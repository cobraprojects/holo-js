export type HoloRequestHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>
  | {
    readonly get?: (name: string) => string | null | undefined
    readonly forEach?: (callback: (value: string, key: string) => void) => void
    readonly entries?: () => Iterable<readonly [string, string]>
  }

type RequestUrlParts = {
  readonly url?: string | URL
  readonly path?: string
  readonly headers?: HoloRequestHeaders
}

export type HoloRequestInput = RequestUrlParts & {
  readonly request?: Request
  readonly req?: RequestUrlParts
  readonly node?: { readonly req?: RequestUrlParts }
  readonly web?: { readonly request?: RequestUrlParts }
}

function shouldTrustProxyHeaders(): boolean {
  const value = typeof process === 'undefined'
    ? undefined
    : process.env.HOLO_SECURITY_TRUST_PROXY?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function isHeaderTuples(headers: HoloRequestHeaders): headers is ReadonlyArray<readonly [string, string]> {
  return Array.isArray(headers)
}

function readHeader(headers: HoloRequestHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (isHeaderTuples(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1]
  }
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? undefined
  if ('entries' in headers && typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase() === name) return value
    }
    return undefined
  }
  if ('forEach' in headers && typeof headers.forEach === 'function') {
    let result: string | undefined
    headers.forEach((value, key) => {
      if (key.toLowerCase() === name) result = value
    })
    return result
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : undefined
    }
  }
  return undefined
}

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(',', 1)[0]?.trim().replace(/^"|"$/g, '')
}

function readForwardedParameter(headers: HoloRequestHeaders | undefined, name: string): string | undefined {
  const forwarded = readHeader(headers, 'forwarded')?.split(',', 1)[0]
  for (const segment of forwarded?.split(';') ?? []) {
    const separator = segment.indexOf('=')
    if (segment.slice(0, separator).trim().toLowerCase() === name) {
      return segment.slice(separator + 1).trim().replace(/^"|"$/g, '')
    }
  }
  return undefined
}

export function resolveRequestUrl(input: HoloRequestInput): URL {
  const nested = input instanceof Request
    ? undefined
    : input.request ?? input.web?.request ?? input.req ?? input.node?.req
  const headers = input.headers ?? nested?.headers
  const value = input.url ?? nested?.url ?? input.path ?? (nested && 'path' in nested ? nested.path : undefined) ?? '/'
  const url = new URL(value, 'http://localhost')
  if (url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new TypeError('[@holo-js/kernel] Request URLs must use http or https without credentials.')
  }
  const trustProxy = shouldTrustProxyHeaders()
  const protocol = (trustProxy
    ? firstForwardedValue(readHeader(headers, 'x-forwarded-proto')) ?? readForwardedParameter(headers, 'proto') ?? url.protocol.slice(0, -1)
    : url.protocol.slice(0, -1)).toLowerCase()
  if (protocol !== 'http' && protocol !== 'https') {
    throw new TypeError('[@holo-js/kernel] Request protocols must be http or https.')
  }
  const host = (trustProxy
    ? firstForwardedValue(readHeader(headers, 'x-forwarded-host')) ?? readForwardedParameter(headers, 'host') ?? readHeader(headers, 'host')
    : readHeader(headers, 'host')) ?? url.host
  if (!host || /[\s,/@\\?#]/u.test(host)) {
    throw new TypeError('[@holo-js/kernel] Request hosts must be a valid hostname and optional port.')
  }
  const origin = new URL(`${protocol}://${host}`)
  if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
    throw new TypeError('[@holo-js/kernel] Request hosts must be a valid hostname and optional port.')
  }
  url.protocol = origin.protocol
  url.host = origin.host
  url.port = origin.port
  return url
}

export const requestUrlInternals = Object.freeze({ shouldTrustProxyHeaders })
