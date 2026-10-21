import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createS3Driver from '../src'

const bucket = 'media-bucket'
const region = 'us-east-1'
const accessKeyId = 'AKIAEXAMPLE'
const secretAccessKey = 'supersecretkey'
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

type RecordedRequest = {
  readonly method: string
  readonly url: URL
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

type LocalS3Endpoint = {
  readonly url: string
  readonly requests: RecordedRequest[]
  readonly server: Server
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function signedHeaderNames(request: RecordedRequest): string[] {
  const authorization = request.headers.authorization ?? ''
  return /SignedHeaders=([^,]+)/u.exec(authorization)?.[1]?.split(';') ?? []
}

function verifySignature(request: IncomingMessage, url: URL, body: Buffer): boolean {
  const authorization = /^AWS4-HMAC-SHA256 Credential=[^/]+\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/u.exec(request.headers.authorization ?? '')
  if (!authorization) return false
  const [, scopeDate, scopeRegion, signedHeaderList, signature] = authorization
  const payloadHash = sha256Hex(body)
  if (request.headers['x-amz-content-sha256'] !== payloadHash) return false

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const canonicalHeaders = signedHeaderList!.split(';').map((name) => {
    const value = String(request.headers[name] ?? '').trim().replace(/\s+/g, ' ')
    return `${name}:${value}`
  })
  const canonicalRequest = [
    request.method,
    url.pathname,
    canonicalQuery,
    ...canonicalHeaders,
    '',
    signedHeaderList,
    payloadHash,
  ].join('\n')
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, scopeDate!), scopeRegion!), 's3'),
    'aws4_request',
  )
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    request.headers['x-amz-date'],
    `${scopeDate}/${scopeRegion}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n')

  return createHmac('sha256', kSigning).update(stringToSign).digest('hex') === signature
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function startLocalS3Endpoint(): Promise<LocalS3Endpoint> {
  const requests: RecordedRequest[] = []
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request)
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: request.method ?? '', url, headers: request.headers, body })

    if (!verifySignature(request, url, body)) {
      response.writeHead(403, { 'content-type': 'application/xml' }).end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
      return
    }
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      response.writeHead(200, { 'content-type': 'application/xml' }).end('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>')
      return
    }
    if (request.method === 'PUT' && url.searchParams.has('partNumber')) {
      response.writeHead(200, { etag: `"part-${url.searchParams.get('partNumber')}"` }).end()
      return
    }
    if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      response.writeHead(200, { 'content-type': 'application/xml' }).end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>')
      return
    }
    if (request.method === 'DELETE' && url.searchParams.has('uploadId')) {
      response.writeHead(204).end()
      return
    }
    response.writeHead(200).end()
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests, server }
}

describe('S3 object content type', () => {
  let endpoint: LocalS3Endpoint

  beforeEach(async () => {
    endpoint = await startLocalS3Endpoint()
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => endpoint.server.close(error => error ? reject(error) : resolve()))
  })

  const createDriver = () => createS3Driver({
    bucket,
    region,
    endpoint: endpoint.url,
    accessKeyId,
    secretAccessKey,
    forcePathStyleEndpoint: true,
  })

  it('sends the inferred content type on PUT and signs it', async () => {
    await expect(createDriver().setItemRaw('uploads:photo.png', pngBytes)).resolves.toBeUndefined()

    const put = endpoint.requests.find(request => request.method === 'PUT')
    expect(put?.url.pathname).toBe(`/${bucket}/uploads/photo.png`)
    expect(put?.headers['content-type']).toBe('image/png')
    expect(signedHeaderNames(put!)).toContain('content-type')
    expect(put?.body.equals(pngBytes)).toBe(true)
  })

  it('sends the inferred content type when a multipart upload is created and signs it', async () => {
    const source = async function* (): AsyncGenerator<Uint8Array> {
      yield pngBytes.subarray(0, 3)
      yield pngBytes.subarray(3)
    }

    await expect(createDriver().setItemStream('uploads:photo.png', source(), { overwrite: true })).resolves.toBeUndefined()

    const create = endpoint.requests.find(request => request.method === 'POST' && request.url.searchParams.has('uploads'))
    expect(create?.headers['content-type']).toBe('image/png')
    expect(signedHeaderNames(create!)).toContain('content-type')

    const part = endpoint.requests.find(request => request.method === 'PUT' && request.url.searchParams.has('partNumber'))
    expect(part?.body.equals(pngBytes)).toBe(true)
  })

  it('sends the inferred content type on an empty streamed object', async () => {
    const source = async function* (): AsyncGenerator<Uint8Array> {}

    await expect(createDriver().setItemStream('notes:empty.txt', source(), { overwrite: true })).resolves.toBeUndefined()

    const put = endpoint.requests.find(request => request.method === 'PUT')
    expect(put?.headers['content-type']).toBe('text/plain')
    expect(signedHeaderNames(put!)).toContain('content-type')
  })

  it('stores document types browsers render as application/octet-stream so they download', async () => {
    await createDriver().setItemRaw('site:index.html', new TextEncoder().encode('<script>alert(1)</script>'))
    await createDriver().setItemRaw('site:logo.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
    await createDriver().setItemRaw('site:feed.xml', new TextEncoder().encode('<feed/>'))

    const contentTypeOf = (path: string) => endpoint.requests.find(request => request.url.pathname === `/${bucket}/site/${path}`)?.headers['content-type']
    expect(contentTypeOf('index.html')).toBe('application/octet-stream')
    expect(contentTypeOf('logo.svg')).toBe('application/octet-stream')
    expect(contentTypeOf('feed.xml')).toBe('application/octet-stream')
  })

  it('sends the type of the key on setItem writes', async () => {
    await createDriver().setItem('settings:app.json', { debug: true })

    const put = endpoint.requests.find(request => request.url.pathname === `/${bucket}/settings/app.json`)
    expect(put?.headers['content-type']).toBe('application/json')
  })

  it('keeps the detected type of archives that browsers download', async () => {
    await createDriver().setItemRaw('bundles:archive.zip', new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]))

    const put = endpoint.requests.find(request => request.url.pathname === `/${bucket}/bundles/archive.zip`)
    expect(put?.headers['content-type']).toBe('application/zip')
  })

  it('falls back to application/octet-stream when no type can be inferred', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4])
    const source = async function* (): AsyncGenerator<Uint8Array> {
      yield bytes
    }

    await createDriver().setItemRaw('reports:result.bin', bytes)
    await createDriver().setItemStream('reports:streamed.bin', source(), { overwrite: true })

    const put = endpoint.requests.find(request => request.method === 'PUT' && !request.url.searchParams.has('partNumber'))
    const create = endpoint.requests.find(request => request.method === 'POST' && request.url.searchParams.has('uploads'))
    expect(put?.headers['content-type']).toBe('application/octet-stream')
    expect(create?.headers['content-type']).toBe('application/octet-stream')
  })
})
