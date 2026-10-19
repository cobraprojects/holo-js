import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime } from '../../core/src/storageRuntime'
import '../src/config'
import { useStorage } from '../src/runtime/composables'

let server: Server
let objects: Map<string, Buffer>
let parts: Map<string, Buffer[]>
let projectRoot: string

function objectKey(request: IncomingMessage): string {
  const url = new URL(request.url ?? '/', 'http://s3.test')
  return decodeURIComponent(url.pathname.replace(/^\/files\//u, ''))
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

beforeEach(async () => {
  objects = new Map()
  parts = new Map()
  projectRoot = await mkdtemp(join(tmpdir(), 'holo-storage-object-keys-'))
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://s3.test')
    if (request.method === 'GET' && url.pathname === '/files' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort()
      response.writeHead(200).end(`<ListBucketResult>${keys.map(key => `<Contents><Key>${escapeXml(key)}</Key></Contents>`).join('')}</ListBucketResult>`)
      return
    }
    const key = objectKey(request)
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      parts.set(key, [])
      response.writeHead(200).end('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>')
      return
    }
    if (request.method === 'PUT' && url.searchParams.has('partNumber')) {
      parts.get(key)?.push(await readBody(request))
      response.writeHead(200, { etag: `"part-${url.searchParams.get('partNumber')}"` }).end()
      return
    }
    if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      objects.set(key, Buffer.concat(parts.get(key) ?? []))
      response.writeHead(200).end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>')
      return
    }
    if (request.method === 'PUT') {
      objects.set(key, await readBody(request))
      response.writeHead(200).end()
      return
    }
    if (request.method === 'DELETE') {
      objects.delete(key)
      response.writeHead(204).end()
      return
    }
    const body = objects.get(key)
    if (!body) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-length': body.length }).end(request.method === 'HEAD' ? undefined : body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing S3 test endpoint')
  await mkdir(join(projectRoot, 'config'))
  await writeFile(join(projectRoot, 'config/storage.mjs'), `export default ${JSON.stringify({
    defaultDisk: 'local',
    disks: {
      local: { driver: 'local', visibility: 'private', root: join(projectRoot, 'storage/app') },
      media: {
        driver: 's3',
        visibility: 'public',
        bucket: 'files',
        region: 'us-east-1',
        endpoint: `http://127.0.0.1:${address.port}`,
        forcePathStyleEndpoint: true,
        accessKeyId: 'test-access',
        secretAccessKey: 'test-secret',
      },
    },
  })}\n`)
  await configurePlainNodeStorageRuntime(resolve(import.meta.dirname, '../../..'), await loadConfigDirectory(projectRoot, { preferCache: false }))
})

afterEach(async () => {
  await resetOptionalStorageRuntime()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(projectRoot, { recursive: true, force: true })
})

const names = [
  'uploads/my file.txt',
  'uploads/café ☕.txt',
  'uploads/100% (final)!.txt',
  'uploads/a:b&c+d.txt',
  'uploads/already%20encoded.txt',
]

describe('object keys', () => {
  it.each(names)('stores %j on S3 under its literal name and serves it from url() and temporaryUrl()', async (name) => {
    const disk = useStorage('media')
    await disk.put(name, `contents of ${name}`)

    expect([...objects.keys()]).toEqual([name])
    await expect(fetch(disk.url(name)).then(response => response.text())).resolves.toBe(`contents of ${name}`)
    await expect(fetch(disk.temporaryUrl(name)).then(response => response.text())).resolves.toBe(`contents of ${name}`)
    await expect(disk.get(name)).resolves.toBe(`contents of ${name}`)
    await expect(disk.listFiles('uploads')).resolves.toEqual({ nextCursor: null, paths: [name] })
    await disk.delete(name)
    expect(objects.size).toBe(0)
  })

  it('streams uploads to S3 under the literal name', async () => {
    const disk = useStorage('media')
    await disk.writeStream('uploads/my clip.bin', (async function* () {
      yield new TextEncoder().encode('streamed')
    })())

    expect([...objects.keys()]).toEqual(['uploads/my clip.bin'])
  })

  it.each(names)('returns a local path() that holds the stored file for %j', async (name) => {
    const disk = useStorage('local')
    await disk.put(name, `contents of ${name}`)

    await expect(readFile(disk.path(name), 'utf8')).resolves.toBe(`contents of ${name}`)
  })
})
