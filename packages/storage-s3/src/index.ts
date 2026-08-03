import { createHash, createHmac } from 'node:crypto'

type DriverValue = string | Uint8Array | ArrayBuffer
const storedValueMarker = '__holo_storage_s3_value_v1'
const MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024
const MAXIMUM_MULTIPART_PART_BYTES = 512 * 1024 * 1024
const MULTIPART_PARTS_PER_SIZE = 10
const MAXIMUM_MULTIPART_PARTS = 10_000

export interface S3DriverOptions {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  endpoint?: string
  region?: string
  bucket?: string
  forcePathStyleEndpoint?: boolean
}

type ResolvedS3DriverOptions = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  endpoint: string
  region: string
  bucket: string
  forcePathStyleEndpoint: boolean
}

function createDriverError(message: string): Error {
  return new Error(`[unstorage] [s3] ${message}`)
}

function normalizeStreamChunkBytes(value = 64 * 1024): number {
  if (!Number.isInteger(value) || value < 4 * 1024 || value > 1024 * 1024) {
    throw createDriverError('Stream chunkBytes must be an integer from 4096 through 1048576.')
  }
  return value
}

function normalizeKey(key = ''): string {
  if (!key) {
    return ''
  }

  return key.replace(/[:/\\]/g, '/').replace(/^[:/\\]|[:/\\]$/g, '')
}

function normalizeListPrefix(key = ''): string {
  if (!key) {
    return ''
  }

  const normalized = normalizeKey(key)
  if (!normalized) {
    return ''
  }

  return /[:/\\]\s*$/.test(key) ? `${normalized}/` : normalized
}

function encodeRfc3986ExtraCharacters(value: string): string {
  return value.replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

function encodeRfc3986(value: string): string {
  return encodeRfc3986ExtraCharacters(encodeURIComponent(value))
}

function encodeObjectKey(key = ''): string {
  const normalized = normalizeKey(key)
  if (!normalized) {
    return ''
  }

  return normalized
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment === '.' || segment === '..') {
        throw createDriverError('S3 object keys cannot contain period-only path segments.')
      }

      return encodeRfc3986(segment)
    })
    .join('/')
}

function canonicalizeUriPath(pathname: string): string {
  return encodeRfc3986ExtraCharacters(pathname)
}

function appendPath(basePath: string, encodedPath?: string): string {
  const trimmedBase = basePath.replace(/\/+$/, '')
  const trimmedPath = encodedPath?.replace(/^\/+/, '')

  if (!trimmedPath) {
    return trimmedBase || '/'
  }

  if (!trimmedBase || trimmedBase === '/') {
    return `/${trimmedPath}`
  }

  return `${trimmedBase}/${trimmedPath}`
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function formatScopeDate(date: Date): string {
  return formatAmzDate(date).slice(0, 8)
}

function getSigningKey(secretAccessKey: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function resolveBucketUrl(options: ResolvedS3DriverOptions): URL {
  const endpoint = new URL(options.endpoint)

  if (options.forcePathStyleEndpoint) {
    endpoint.pathname = appendPath(endpoint.pathname, encodeURIComponent(options.bucket))
  } else {
    endpoint.host = `${options.bucket}.${endpoint.host}`
  }

  return endpoint
}

function resolveObjectUrl(options: ResolvedS3DriverOptions, key = ''): URL {
  const url = resolveBucketUrl(options)
  const encodedKey = encodeObjectKey(key)
  url.pathname = appendPath(url.pathname, encodedKey)
  return url
}

function sortCanonicalQueryEntries(url: URL): Array<readonly [string, string]> {
  return Array.from(url.searchParams.entries()).map(([key, value]) => {
    return [encodeRfc3986(key), encodeRfc3986(value)] as const
  }).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) {
      return leftValue.localeCompare(rightValue)
    }

    return leftKey.localeCompare(rightKey)
  })
}

function toBodyBytes(value?: DriverValue): Uint8Array | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value === 'string') {
    return new TextEncoder().encode(value)
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  return value
}

function createSignedRequest(
  options: ResolvedS3DriverOptions,
  method: string,
  url: URL,
  body?: DriverValue,
  additionalHeaders?: Headers | Readonly<Record<string, string>>,
): Request {
  const now = new Date()
  const amzDate = formatAmzDate(now)
  const scopeDate = formatScopeDate(now)
  const payloadBytes = toBodyBytes(body)
  const payloadHash = sha256Hex(payloadBytes ?? '')
  const credentialScope = `${scopeDate}/${options.region}/s3/aws4_request`
  const headers = new Headers(additionalHeaders)

  headers.set('host', url.host)
  headers.set('x-amz-content-sha256', payloadHash)
  headers.set('x-amz-date', amzDate)

  if (options.sessionToken) {
    headers.set('x-amz-security-token', options.sessionToken)
  }

  const canonicalHeaders = Array.from(headers.entries())
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))

  const canonicalQueryString = sortCanonicalQueryEntries(url)
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(';')
  const canonicalRequest = [
    method,
    canonicalizeUriPath(url.pathname),
    canonicalQueryString,
    canonicalHeaders.map(([name, value]) => `${name}:${value}`).join('\n'),
    '',
    signedHeaders,
    payloadHash,
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const signature = createHmac('sha256', getSigningKey(options.secretAccessKey, scopeDate, options.region))
    .update(stringToSign)
    .digest('hex')

  headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  )

  const requestBody = payloadBytes
    ? (() => {
      const { buffer, byteOffset, byteLength } = payloadBytes
      const arrayBuffer = buffer instanceof ArrayBuffer
        ? (byteOffset === 0 && byteLength === buffer.byteLength
          ? buffer
          : buffer.slice(byteOffset, byteOffset + byteLength))
        : payloadBytes.slice().buffer

      return new Blob([arrayBuffer])
    })()
    : undefined

  return new Request(url.toString(), {
    method,
    headers,
    body: requestBody,
  })
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function decodeXmlEntity(value: string): string {
  const namedEntities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': '\'',
  } as const

  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|amp|lt|gt|quot|apos);/g, (entity, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    return namedEntities[entity as keyof typeof namedEntities]
  })
}

function parseListObjects(xml: string): string[] {
  const contents = xml.match(/<Contents[^>]*>([\s\S]*?)<\/Contents>/g)
  if (!contents?.length) return []

  return contents.map((content) => {
    const key = content.match(/<Key>([\s\S]+?)<\/Key>/)?.[1]
    return key ? decodeXmlEntity(key) : undefined
  }).filter((value): value is string => Boolean(value))
}

function parseContinuationToken(xml: string): string | null {
  const token = xml.match(/<NextContinuationToken>([\s\S]+?)<\/NextContinuationToken>/)?.[1]
  return token ? decodeXmlEntity(token) : null
}

function deserializeStoredValue<T>(value: string): T | string {
  let parsed: unknown

  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return value
  }

  if (isStoredValueEnvelope(parsed)) {
    return parsed.value as T
  }

  return value
}

function isStoredValueEnvelope(value: unknown): value is { readonly value?: unknown } {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>)[storedValueMarker] === true
}

function serializeStoredValue(value: unknown): string {
  return JSON.stringify({
    [storedValueMarker]: true,
    value,
  })
}

function resolveDriverOptions(options: S3DriverOptions): ResolvedS3DriverOptions {
  if (!options.accessKeyId) {
    throw createDriverError('Missing required option `accessKeyId`.')
  }

  if (!options.secretAccessKey) {
    throw createDriverError('Missing required option `secretAccessKey`.')
  }

  if (!options.endpoint) {
    throw createDriverError('Missing required option `endpoint`.')
  }

  if (!options.region) {
    throw createDriverError('Missing required option `region`.')
  }

  if (!options.bucket) {
    throw createDriverError('Missing required option `bucket`.')
  }

  return {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
    endpoint: options.endpoint,
    region: options.region,
    bucket: options.bucket,
    forcePathStyleEndpoint: Boolean(options.forcePathStyleEndpoint),
  }
}

async function s3Fetch(
  options: ResolvedS3DriverOptions,
  method: string,
  url: URL,
  body?: DriverValue,
  headers?: Headers | Readonly<Record<string, string>>,
): Promise<Response | null> {
  const request = createSignedRequest(options, method, url, body, headers)
  const response = await fetch(request)

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const message = await readErrorBody(response)
    throw createDriverError(`[${method}] ${url}: ${response.status} ${response.statusText} ${message}`.trim())
  }

  return response
}

function parseUploadId(xml: string): string {
  const uploadId = xml.match(/<UploadId>([\s\S]+?)<\/UploadId>/)?.[1]
  if (!uploadId) throw createDriverError('Multipart upload initialization failed.')
  return decodeXmlEntity(uploadId)
}

function multipartUrl(options: ResolvedS3DriverOptions, key: string, uploadId?: string): URL {
  const url = resolveObjectUrl(options, key)
  if (uploadId) url.searchParams.set('uploadId', uploadId)
  else url.searchParams.set('uploads', '')
  return url
}

function concatenateChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function multipartPartBytes(partNumber: number): number {
  const sizeStep = Math.floor((partNumber - 1) / MULTIPART_PARTS_PER_SIZE)
  return Math.min(MAXIMUM_MULTIPART_PART_BYTES, MINIMUM_MULTIPART_PART_BYTES * (2 ** sizeStep))
}

async function uploadMultipartPart(
  options: ResolvedS3DriverOptions,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<string> {
  const url = multipartUrl(options, key, uploadId)
  url.searchParams.set('partNumber', String(partNumber))
  const response = await s3Fetch(options, 'PUT', url, body)
  const etag = response?.headers.get('etag')
  if (!etag) throw createDriverError('Multipart part upload failed.')
  return etag
}

async function abortMultipartUpload(
  options: ResolvedS3DriverOptions,
  key: string,
  uploadId: string,
): Promise<void> {
  await s3Fetch(options, 'DELETE', multipartUrl(options, key, uploadId)).catch(() => undefined)
}

function completeMultipartBody(parts: readonly string[]): string {
  return `<CompleteMultipartUpload>${parts.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
}

function destinationExistsError(): Error {
  const error = new Error('[Holo Storage] Stream destination already exists.')
  error.name = 'StorageDestinationExistsError'
  return error
}

async function conditionallyCompleteMultipartUpload(
  options: ResolvedS3DriverOptions,
  key: string,
  uploadId: string,
  parts: readonly string[],
  overwrite: boolean,
): Promise<void> {
  const request = createSignedRequest(
    options,
    'POST',
    multipartUrl(options, key, uploadId),
    completeMultipartBody(parts),
    overwrite ? undefined : { 'if-none-match': '*' },
  )
  const response = await fetch(request)
  if (response.status === 409 || response.status === 412) throw destinationExistsError()
  if (!response.ok) throw createDriverError('Multipart upload completion failed.')
  const responseBody = await response.text()
  if (/^\s*(?:<\?xml[^>]*>\s*)?<Error(?:\s|>)/u.test(responseBody)) {
    throw createDriverError('Multipart upload completion failed.')
  }
}

async function conditionallyPutEmptyObject(
  options: ResolvedS3DriverOptions,
  key: string,
  overwrite: boolean,
): Promise<void> {
  const request = createSignedRequest(
    options,
    'PUT',
    resolveObjectUrl(options, key),
    new Uint8Array(),
    overwrite ? undefined : { 'if-none-match': '*' },
  )
  const response = await fetch(request)
  if (response.status === 409 || response.status === 412) throw destinationExistsError()
  if (!response.ok) throw createDriverError('Stream upload failed.')
}

export default function createS3Driver(input: S3DriverOptions) {
  const options = resolveDriverOptions(input)

  return {
    name: 's3',
    options,
    async getItem<T = unknown>(key: string) {
      const response = await s3Fetch(options, 'GET', resolveObjectUrl(options, key))
      if (!response) {
        return null
      }

      return deserializeStoredValue<T>(await response.text())
    },
    async getItemRaw(key: string) {
      const response = await s3Fetch(options, 'GET', resolveObjectUrl(options, key))
      return response ? response.arrayBuffer() : null
    },
    async getItemStream(
      key: string,
      request: { readonly chunkBytes?: number },
    ): Promise<AsyncIterable<Uint8Array> | null> {
      const url = resolveObjectUrl(options, key)
      const chunkBytes = normalizeStreamChunkBytes(request.chunkBytes)
      try {
        if (!await s3Fetch(options, 'HEAD', url)) return null
      } catch {
        throw createDriverError('Stream read failed.')
      }

      return (async function* (): AsyncGenerator<Uint8Array> {
        const response = await s3Fetch(options, 'GET', url)
        const reader = response?.body?.getReader()
        if (!reader) throw createDriverError('Stream read failed.')
        try {
          while (true) {
            const result = await reader.read()
            if (result.done) return
            for (let offset = 0; offset < result.value.byteLength; offset += chunkBytes) {
              const chunk = result.value.subarray(offset, Math.min(offset + chunkBytes, result.value.byteLength))
              if (chunk.byteLength > 0) yield chunk
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      })()
    },
    async setItem(key: string, value: unknown) {
      await s3Fetch(options, 'PUT', resolveObjectUrl(options, key), serializeStoredValue(value))
    },
    async setItemRaw(key: string, value: DriverValue) {
      await s3Fetch(options, 'PUT', resolveObjectUrl(options, key), value)
    },
    async setItemStream(
      key: string,
      source: AsyncIterable<Uint8Array>,
      request: { readonly overwrite: boolean },
    ) {
      let uploadId: string | undefined
      try {
        const start = await s3Fetch(options, 'POST', multipartUrl(options, key))
        if (!start) throw createDriverError('Multipart upload initialization failed.')
        uploadId = parseUploadId(await start.text())
        const etags: string[] = []
        let buffered: Uint8Array[] = []
        let bufferedBytes = 0
        let targetPartBytes = multipartPartBytes(1)

        const flush = async (): Promise<void> => {
          if (bufferedBytes === 0 || !uploadId) return
          const partNumber = etags.length + 1
          if (partNumber > MAXIMUM_MULTIPART_PARTS) throw createDriverError('Multipart upload exceeds the S3 part limit.')
          const part = concatenateChunks(buffered, bufferedBytes)
          etags.push(await uploadMultipartPart(options, key, uploadId, partNumber, part))
          buffered = []
          bufferedBytes = 0
          targetPartBytes = multipartPartBytes(partNumber + 1)
        }

        for await (const sourceChunk of source) {
          let offset = 0
          while (offset < sourceChunk.byteLength) {
            const available = targetPartBytes - bufferedBytes
            const nextOffset = Math.min(offset + available, sourceChunk.byteLength)
            buffered.push(new Uint8Array(sourceChunk.subarray(offset, nextOffset)))
            bufferedBytes += nextOffset - offset
            offset = nextOffset
            if (bufferedBytes === targetPartBytes) await flush()
          }
        }

        await flush()
        if (etags.length === 0) {
          await abortMultipartUpload(options, key, uploadId)
          uploadId = undefined
          await conditionallyPutEmptyObject(options, key, request.overwrite)
          return
        }

        await conditionallyCompleteMultipartUpload(options, key, uploadId, etags, request.overwrite)
        uploadId = undefined
      } catch (error) {
        if (uploadId) await abortMultipartUpload(options, key, uploadId)
        if (error instanceof Error && error.name === 'StorageDestinationExistsError') throw error
        throw createDriverError('Stream write failed.')
      }
    },
    async getMeta(key: string) {
      const response = await s3Fetch(options, 'HEAD', resolveObjectUrl(options, key))
      if (!response) {
        return null
      }

      const metaHeaders: Record<string, string> = {}
      for (const [name, value] of response.headers.entries()) {
        const match = /x-amz-meta-(.*)/.exec(name)
        if (match?.[1]) {
          metaHeaders[match[1]] = value
        }
      }

      return metaHeaders
    },
    async hasItem(key: string) {
      const response = await s3Fetch(options, 'HEAD', resolveObjectUrl(options, key))
      return Boolean(response)
    },
    async getKeys(base?: string) {
      const keys: string[] = []
      let continuationToken: string | undefined

      while (true) {
        const url = resolveBucketUrl(options)
        url.searchParams.set('list-type', '2')

        const prefix = normalizeListPrefix(base)
        if (prefix) {
          url.searchParams.set('prefix', prefix)
        }

        if (continuationToken) {
          url.searchParams.set('continuation-token', continuationToken)
        }

        const response = await s3Fetch(options, 'GET', url)
        if (!response) {
          return keys
        }

        const xml = await response.text()
        keys.push(...parseListObjects(xml))

        const nextToken = parseContinuationToken(xml)
        if (!nextToken) {
          return keys
        }

        continuationToken = nextToken
      }
    },
    async getKeysPage(
      base: string | undefined,
      request: { readonly cursor: string | null, readonly limit: number },
    ) {
      const url = resolveBucketUrl(options)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('max-keys', String(request.limit))
      const prefix = normalizeListPrefix(base)
      if (prefix) url.searchParams.set('prefix', prefix)
      if (request.cursor) url.searchParams.set('continuation-token', request.cursor)

      const response = await s3Fetch(options, 'GET', url)
      if (!response) return { nextCursor: null, paths: [] }
      const xml = await response.text()
      return {
        nextCursor: parseContinuationToken(xml),
        paths: parseListObjects(xml),
      }
    },
    async removeItem(key: string) {
      await s3Fetch(options, 'DELETE', resolveObjectUrl(options, key))
    },
    async clear(base?: string) {
      const keys = await this.getKeys(base)
      await Promise.all(keys.map((key: string) => this.removeItem(key)))
    },
  }
}
