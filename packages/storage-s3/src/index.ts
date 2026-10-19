import { createHash, createHmac } from 'node:crypto'
import type { StorageBackend } from '@holo-js/storage/runtime'

type DriverValue = string | Uint8Array | ArrayBuffer
const storedValueMarker = '__holo_storage_s3_value_v1'
const MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024
const MAXIMUM_MULTIPART_PART_BYTES = 64 * 1024 * 1024
const MULTIPART_PARTS_PER_SIZE = 10
const MAXIMUM_MULTIPART_PARTS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
const MINIMUM_UPLOAD_BYTES_PER_SECOND = 128 * 1024
const RESPONSE_IDLE_TIMEOUT_MS = 30_000
const CLEAR_PAGE_KEYS = 1000
const CLEAR_CONCURRENCY = 8
const NULL_BODY_STATUSES = new Set([204, 205, 304])

export interface S3DriverOptions {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  endpoint?: string
  region?: string
  bucket?: string
  forcePathStyleEndpoint?: boolean
}

type KeysPage = {
  readonly nextCursor: string | null
  readonly paths: string[]
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

function decodeKeySegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function objectKeySegments(key = ''): string[] {
  return normalizeKey(key)
    .split('/')
    .filter(Boolean)
    .map(decodeKeySegment)
}

function normalizeListPrefix(key = ''): string {
  if (!key) {
    return ''
  }

  const normalized = objectKeySegments(key).join('/')
  if (!normalized) {
    return ''
  }

  return /[:/\\]\s*$/.test(key) ? `${normalized}/` : normalized
}

function toStorageKey(objectKey: string): string {
  return objectKey
    .split('/')
    .filter(Boolean)
    .map(segment => segment.replace(/[%:$]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`))
    .join(':')
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
  return objectKeySegments(key)
    .map((segment) => {
      if (segment === '.' || segment === '..') {
        throw createDriverError('S3 object keys cannot contain period-only path segments.')
      }

      if (/[/\\]/u.test(segment)) {
        throw createDriverError('S3 object key segments cannot contain path separators.')
      }

      return encodeRfc3986(segment)
    })
    .join('/')
}

function assertValidObjectKey(key: string): void {
  encodeObjectKey(key)
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
    return key ? toStorageKey(decodeXmlEntity(key)) : undefined
  }).filter((value): value is string => Boolean(value))
}

function parseContinuationToken(xml: string): string | null {
  const token = xml.match(/<NextContinuationToken>([\s\S]+?)<\/NextContinuationToken>/)?.[1]
  return token ? decodeXmlEntity(token) : null
}

function deserializeStoredValue<T>(value: string): T {
  let parsed: unknown

  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return value as T
  }

  return (isStoredValueEnvelope(parsed) ? parsed.value : value) as T
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

function requestTimeoutMs(body?: DriverValue): number {
  const bytes = toBodyBytes(body)?.byteLength ?? 0
  return REQUEST_TIMEOUT_MS + Math.ceil(bytes / MINIMUM_UPLOAD_BYTES_PER_SECOND) * 1000
}

async function withTimeout<TResult>(
  operation: Promise<TResult>,
  timeoutMs: number,
  controller: AbortController,
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = createDriverError('Request timed out.')
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function withIdleTimeout(response: Response, controller: AbortController): Response {
  if (!response.body || NULL_BODY_STATUSES.has(response.status)) return response
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      const result = await withTimeout(reader.read(), RESPONSE_IDLE_TIMEOUT_MS, controller)
      if (result.done) streamController.close()
      else streamController.enqueue(result.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

async function sendSignedRequest(
  options: ResolvedS3DriverOptions,
  method: string,
  url: URL,
  body?: DriverValue,
  headers?: Headers | Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Response> {
  const request = createSignedRequest(options, method, url, body, headers)
  const controller = new AbortController()
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  const response = await withTimeout(fetch(request, { signal: requestSignal }), requestTimeoutMs(body), controller)
  return withIdleTimeout(response, controller)
}

async function s3Fetch(
  options: ResolvedS3DriverOptions,
  method: string,
  url: URL,
  body?: DriverValue,
  headers?: Headers | Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Response | null> {
  const response = await sendSignedRequest(options, method, url, body, headers, signal)

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
  const response = await sendSignedRequest(
    options,
    'POST',
    multipartUrl(options, key, uploadId),
    completeMultipartBody(parts),
    overwrite ? undefined : { 'if-none-match': '*' },
  )
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
  const response = await sendSignedRequest(
    options,
    'PUT',
    resolveObjectUrl(options, key),
    new Uint8Array(),
    overwrite ? undefined : { 'if-none-match': '*' },
  )
  await response.body?.cancel()
  if (response.status === 409 || response.status === 412) throw destinationExistsError()
  if (!response.ok) throw createDriverError('Stream upload failed.')
}

async function forEachConcurrently<TItem>(
  items: readonly TItem[],
  concurrency: number,
  task: (item: TItem) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!
      next += 1
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

async function withMetadataFailure<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  try {
    return await operation()
  } catch {
    throw createDriverError('File metadata request failed.')
  }
}

function parseObjectSize(value: string | null): number {
  const size = Number(value)
  if (value === null || !/^\d+$/u.test(value) || !Number.isSafeInteger(size)) {
    throw createDriverError('File metadata response has an invalid content length.')
  }
  return size
}

async function readEmptyObjectStat(
  options: ResolvedS3DriverOptions,
  url: URL,
): Promise<{ readonly size: number, readonly sample: Uint8Array } | null> {
  const response = await withMetadataFailure(() => s3Fetch(options, 'HEAD', url))
  return response ? { size: parseObjectSize(response.headers.get('content-length')), sample: new Uint8Array() } : null
}

async function readLeadingBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const result = await reader.read()
      if (result.done) break
      const chunk = result.value.subarray(0, limit - size)
      chunks.push(chunk)
      size += chunk.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return concatenateChunks(chunks, size)
}

export default function createS3Driver(input: S3DriverOptions) {
  let resolvedOptions: ResolvedS3DriverOptions | undefined
  const getOptions = (): ResolvedS3DriverOptions => resolvedOptions ??= resolveDriverOptions(input)

  const driver = {
    name: 's3',
    get options() {
      return getOptions()
    },
    async getItem<T = unknown>(key: string): Promise<T | null> {
      const options = getOptions()
      const response = await s3Fetch(options, 'GET', resolveObjectUrl(options, key))
      if (!response) {
        return null
      }

      return deserializeStoredValue<T>(await response.text())
    },
    async getItemRaw(key: string) {
      const options = getOptions()
      const response = await s3Fetch(options, 'GET', resolveObjectUrl(options, key))
      return response ? response.arrayBuffer() : null
    },
    async getItemStat(key: string, request: { readonly sampleBytes: number }): Promise<{ readonly size: number, readonly sample: Uint8Array } | null> {
      const options = getOptions()
      const url = resolveObjectUrl(options, key)
      const response = await withMetadataFailure(() => sendSignedRequest(options, 'GET', url, undefined, { range: `bytes=0-${request.sampleBytes - 1}` }))
      if (response.status === 404 || response.status === 416 || !response.ok) await response.body?.cancel()
      if (response.status === 404) return null
      if (response.status === 416) return await readEmptyObjectStat(options, url)
      if (!response.ok) throw createDriverError('File metadata request failed.')
      const size = response.status === 206
        ? parseObjectSize(/^bytes \d+-\d+\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')?.[1] ?? null)
        : parseObjectSize(response.headers.get('content-length'))
      return { size, sample: await withMetadataFailure(() => readLeadingBytes(response, request.sampleBytes)) }
    },
    async getItemStream(
      key: string,
      request: { readonly chunkBytes?: number, readonly signal?: AbortSignal },
    ): Promise<AsyncIterable<Uint8Array> | null> {
      const options = getOptions()
      const url = resolveObjectUrl(options, key)
      const chunkBytes = normalizeStreamChunkBytes(request.chunkBytes)
      try {
        if (!await s3Fetch(options, 'HEAD', url, undefined, undefined, request.signal)) return null
      } catch {
        request.signal?.throwIfAborted()
        throw createDriverError('Stream read failed.')
      }

      return (async function* (): AsyncGenerator<Uint8Array> {
        const response = await s3Fetch(options, 'GET', url, undefined, undefined, request.signal)
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
      const options = getOptions()
      await s3Fetch(options, 'PUT', resolveObjectUrl(options, key), serializeStoredValue(value))
    },
    async setItemRaw(key: string, value: DriverValue) {
      const options = getOptions()
      await s3Fetch(options, 'PUT', resolveObjectUrl(options, key), value)
    },
    async setItemStream(
      key: string,
      source: AsyncIterable<Uint8Array>,
      request: { readonly overwrite: boolean },
    ) {
      const options = getOptions()
      let uploadId: string | undefined
      try {
        const start = await s3Fetch(options, 'POST', multipartUrl(options, key))
        if (!start) throw createDriverError('Multipart upload initialization failed.')
        uploadId = parseUploadId(await start.text())
        const etags: string[] = []
        let part: Uint8Array | undefined
        let bufferedBytes = 0

        const flush = async (): Promise<void> => {
          if (!part || bufferedBytes === 0 || !uploadId) return
          const partNumber = etags.length + 1
          if (partNumber > MAXIMUM_MULTIPART_PARTS) throw createDriverError('Multipart upload exceeds the S3 part limit.')
          etags.push(await uploadMultipartPart(options, key, uploadId, partNumber, part.subarray(0, bufferedBytes)))
          part = undefined
          bufferedBytes = 0
        }

        for await (const sourceChunk of source) {
          let offset = 0
          while (offset < sourceChunk.byteLength) {
            part ??= new Uint8Array(multipartPartBytes(etags.length + 1))
            const nextOffset = Math.min(offset + part.byteLength - bufferedBytes, sourceChunk.byteLength)
            part.set(sourceChunk.subarray(offset, nextOffset), bufferedBytes)
            bufferedBytes += nextOffset - offset
            offset = nextOffset
            if (bufferedBytes === part.byteLength) await flush()
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
    async getMeta<T = Record<string, string>>(key: string): Promise<T | null> {
      const options = getOptions()
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

      return metaHeaders as T
    },
    async hasItem(key: string) {
      const options = getOptions()
      const response = await s3Fetch(options, 'HEAD', resolveObjectUrl(options, key))
      return Boolean(response)
    },
    async getKeys(base?: string) {
      const options = getOptions()
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
      const options = getOptions()
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
      const options = getOptions()
      await s3Fetch(options, 'DELETE', resolveObjectUrl(options, key))
    },
    async clear(base?: string) {
      let cursor: string | null = null
      do {
        const page: KeysPage = await this.getKeysPage(base, { cursor, limit: CLEAR_PAGE_KEYS })
        page.paths.forEach(assertValidObjectKey)
        await forEachConcurrently(page.paths, CLEAR_CONCURRENCY, key => this.removeItem(key))
        cursor = page.nextCursor
      } while (cursor)
    },
  }

  return driver satisfies StorageBackend
}
