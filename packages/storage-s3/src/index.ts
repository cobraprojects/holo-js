import { createHash, createHmac } from 'node:crypto'

type DriverValue = string | Uint8Array | ArrayBuffer
type DriverHeaders = Record<string, string>

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

function normalizeKey(key = '', separator = ':'): string {
  if (!key) {
    return ''
  }

  return key.replace(/[:/\\]/g, separator).replace(/^[:/\\]|[:/\\]$/g, '')
}

function normalizeListPrefix(key = ''): string {
  if (!key) {
    return ''
  }

  const normalized = normalizeKey(key, '/')
  if (!normalized) {
    return ''
  }

  return /[:/\\]\s*$/.test(key) ? `${normalized}/` : normalized
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

function encodeObjectKey(key = ''): string {
  const normalized = normalizeKey(key, '/')
  if (!normalized) {
    return ''
  }

  return normalized
    .split('/')
    .filter(Boolean)
    .map(segment => encodeRfc3986(segment))
    .join('/')
}

function canonicalizeUriPath(pathname: string): string {
  return pathname.replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
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

function sortQueryEntries(url: URL): Array<[string, string]> {
  return Array.from(url.searchParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
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
  initHeaders?: DriverHeaders,
): Request {
  const now = new Date()
  const amzDate = formatAmzDate(now)
  const scopeDate = formatScopeDate(now)
  const payloadBytes = toBodyBytes(body)
  const payloadHash = sha256Hex(payloadBytes ?? '')
  const credentialScope = `${scopeDate}/${options.region}/s3/aws4_request`
  const headers = new Headers(initHeaders)

  headers.set('host', url.host)
  headers.set('x-amz-content-sha256', payloadHash)
  headers.set('x-amz-date', amzDate)

  if (options.sessionToken) {
    headers.set('x-amz-security-token', options.sessionToken)
  }

  const canonicalHeaders = Array.from(headers.entries())
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))

  const canonicalQueryString = sortQueryEntries(url)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
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

function parseListObjects(xml: string): string[] {
  const contents = xml.match(/<Contents[^>]*>([\s\S]*?)<\/Contents>/g)
  if (!contents?.length) {
    return []
  }

  const decodeXmlEntity = (value: string): string => {
    const namedEntities = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': '\'',
    } as const

    return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|amp|lt|gt|quot|apos);/g, (entity, decimal, hex) => {
      if (decimal) {
        return String.fromCodePoint(Number(decimal))
      }

      if (hex) {
        return String.fromCodePoint(Number.parseInt(hex, 16))
      }

      return namedEntities[entity as keyof typeof namedEntities]
    })
  }

  return contents.map((content) => {
    const key = content.match(/<Key>([\s\S]+?)<\/Key>/)?.[1]
    return key ? decodeXmlEntity(key) : undefined
  }).filter((value): value is string => Boolean(value))
}

function deserializeStoredValue<T>(value: string): T | string {
  try {
    return JSON.parse(value) as T
  } catch {
    return value
  }
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
  headers?: DriverHeaders,
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
    async setItem(key: string, value: unknown) {
      const body = typeof value === 'string' ? value : JSON.stringify(value)
      await s3Fetch(options, 'PUT', resolveObjectUrl(options, key), body)
    },
    async setItemRaw(key: string, value: DriverValue) {
      await s3Fetch(options, 'PUT', resolveObjectUrl(options, key), value)
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

        const nextToken = xml.match(/<NextContinuationToken>([\s\S]+?)<\/NextContinuationToken>/)?.[1]
        if (!nextToken) {
          return keys
        }

        continuationToken = nextToken
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
