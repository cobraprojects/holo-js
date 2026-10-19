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

export type HoloForwardedRequest = {
  readonly protocol?: string
  readonly host?: string
  readonly port?: string
  readonly prefix?: string
}

export type HoloForwardedRequestResolver = (
  readHeader: (name: string) => string | undefined,
  connectionAddress: string | undefined,
) => HoloForwardedRequest

export type HoloConnectionAddressProvider = () => string | undefined

type RequestForwardingState = {
  resolveForwardedRequest?: HoloForwardedRequestResolver
  connectionAddress?: HoloConnectionAddressProvider
}

function requestForwardingState(): RequestForwardingState {
  const runtime = globalThis as typeof globalThis & { __holoRequestForwarding__?: RequestForwardingState }
  runtime.__holoRequestForwarding__ ??= {}
  return runtime.__holoRequestForwarding__
}

function configureForwardedRequestResolver(resolver: HoloForwardedRequestResolver | undefined): void {
  requestForwardingState().resolveForwardedRequest = resolver
}

function provideConnectionAddress(provider: HoloConnectionAddressProvider | undefined): void {
  requestForwardingState().connectionAddress = provider
}

function currentConnectionAddress(): string | undefined {
  try {
    return requestForwardingState().connectionAddress?.()
  } catch {
    return undefined
  }
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

export class HoloRequestUrlError extends TypeError {
  readonly status = 400

  constructor(message: string) {
    super(`[@holo-js/kernel] ${message}`)
    this.name = 'HoloRequestUrlError'
  }
}

const invalidRequestHostMessage = 'Request hosts must be a valid hostname and optional port.'
const invalidRequestPortMessage = 'Request ports must be a number from 0 to 65535.'
const invalidRequestPrefixMessage = 'Request prefixes must be a path starting with a single "/".'

function validForwardedPort(port: string): string {
  if (!/^\d{1,5}$/u.test(port) || Number(port) > 65535) throw new HoloRequestUrlError(invalidRequestPortMessage)
  return port
}

function validForwardedPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/u, '')
  if (trimmed && (!trimmed.startsWith('/') || trimmed.startsWith('//') || /[\s?#\\]/u.test(trimmed))) {
    throw new HoloRequestUrlError(invalidRequestPrefixMessage)
  }
  return trimmed
}

function parseRequestUrl(value: string | URL, invalidMessage: string): URL {
  if (!URL.canParse(String(value), 'http://localhost')) throw new HoloRequestUrlError(invalidMessage)
  return new URL(value, 'http://localhost')
}

function resolveUrl(input: HoloRequestInput, applyPrefix: boolean): URL {
  const nested = input instanceof Request
    ? undefined
    : input.request ?? input.web?.request ?? input.req ?? input.node?.req
  const headers = input.headers ?? nested?.headers
  const value = input.url ?? nested?.url ?? input.path ?? (nested && 'path' in nested ? nested.path : undefined) ?? '/'
  const invalidUrlMessage = 'Request URLs must use http or https without credentials.'
  const url = parseRequestUrl(value, invalidUrlMessage)
  if (url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new HoloRequestUrlError(invalidUrlMessage)
  }
  const forwarded = requestForwardingState().resolveForwardedRequest?.(name => readHeader(headers, name), currentConnectionAddress())
  const protocol = (forwarded?.protocol ?? url.protocol.slice(0, -1)).toLowerCase()
  if (protocol !== 'http' && protocol !== 'https') {
    throw new HoloRequestUrlError('Request protocols must be http or https.')
  }
  const host = forwarded?.host ?? readHeader(headers, 'host') ?? url.host
  if (!host || /[\s,/@\\?#]/u.test(host)) {
    throw new HoloRequestUrlError(invalidRequestHostMessage)
  }
  const origin = parseRequestUrl(`${protocol}://${host}`, invalidRequestHostMessage)
  if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
    throw new HoloRequestUrlError(invalidRequestHostMessage)
  }
  if (forwarded?.port !== undefined) origin.port = validForwardedPort(forwarded.port)
  url.protocol = origin.protocol
  url.host = origin.host
  url.port = origin.port
  const prefix = forwarded?.prefix === undefined ? '' : validForwardedPrefix(forwarded.prefix)
  if (applyPrefix) url.pathname = `${prefix}${url.pathname}`
  return url
}

export function resolveRequestUrl(input: HoloRequestInput): URL {
  return resolveUrl(input, true)
}

function resolveRoutedRequestUrl(input: HoloRequestInput): URL {
  return resolveUrl(input, false)
}

export const requestUrlInternals = Object.freeze({
  configureForwardedRequestResolver,
  currentConnectionAddress,
  provideConnectionAddress,
  resolveRoutedRequestUrl,
})
