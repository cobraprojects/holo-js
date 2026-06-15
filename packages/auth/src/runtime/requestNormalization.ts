export type AuthRuntimeRequestHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>
  | {
    readonly get?: (name: string) => string | null | undefined
    readonly forEach?: (callback: (value: string, key: string) => void) => void
    readonly entries?: () => Iterable<readonly [string, string]>
  }

export type AuthRuntimeRequestLike = {
  readonly method?: string
  readonly path?: string
  readonly url?: string | URL
  readonly headers?: AuthRuntimeRequestHeaders
  readonly request?: Request
  readonly req?: Request | {
    readonly method?: string
    readonly url?: string
    readonly headers?: AuthRuntimeRequestHeaders
  }
  readonly node?: {
    readonly req?: {
      readonly method?: string
      readonly url?: string
      readonly headers?: AuthRuntimeRequestHeaders
    }
  }
  readonly web?: {
    readonly request?: Request
  }
}

export type AuthRuntimeRequestInput = Request | AuthRuntimeRequestLike
export type NormalizeRequestInputOptions = {
  readonly createRelativeRequestBaseUrl?: (headers: Headers) => string
}

const GET_ONLY_REQUEST_HEADER_NAMES = ['authorization', 'cookie', 'host', 'x-forwarded-host', 'x-forwarded-proto'] as const

function isPlainHeaderRecord(value: unknown): value is Record<string, string | readonly string[] | undefined> {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

function appendKnownHeaders(headers: Headers, input: { readonly get?: (name: string) => string | null | undefined }): void {
  for (const name of GET_ONLY_REQUEST_HEADER_NAMES) {
    const value = input.get?.(name)
    if (typeof value === 'string' && value) {
      headers.set(name, value)
    }
  }
}

function hasHeaderForEach(input: AuthRuntimeRequestHeaders): input is { readonly forEach: (callback: (value: string, key: string) => void) => void } {
  return !Array.isArray(input) && 'forEach' in input && typeof input.forEach === 'function'
}

function hasHeaderEntries(input: AuthRuntimeRequestHeaders): input is { readonly entries: () => Iterable<readonly [string, string]> } {
  return !Array.isArray(input) && 'entries' in input && typeof input.entries === 'function'
}

function hasHeaderGet(input: AuthRuntimeRequestHeaders): input is { readonly get: (name: string) => string | null | undefined } {
  return !Array.isArray(input) && 'get' in input && typeof input.get === 'function'
}

function normalizeRequestHeaders(input: AuthRuntimeRequestHeaders | undefined): Headers {
  const headers = new Headers()
  if (!input) {
    return headers
  }

  if (input instanceof Headers || Array.isArray(input)) {
    new Headers(input).forEach((value, name) => headers.append(name, value))
    return headers
  }

  if (hasHeaderForEach(input)) {
    input.forEach((value, name) => headers.append(name, value))
    return headers
  }

  if (hasHeaderEntries(input)) {
    for (const [name, value] of input.entries()) {
      headers.append(name, value)
    }
    return headers
  }

  if (hasHeaderGet(input)) {
    appendKnownHeaders(headers, input)
    return headers
  }

  if (isPlainHeaderRecord(input)) {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        headers.append(name, value)
        continue
      }

      if (Array.isArray(value)) {
        const separator = name.toLowerCase() === 'cookie' ? '; ' : ','
        const joined = value.filter((entry): entry is string => typeof entry === 'string').join(separator)
        if (joined) {
          headers.append(name, joined)
        }
      }
    }
  }

  return headers
}

function getRequestFromLikeInput(input: AuthRuntimeRequestLike): Request | undefined {
  return input.request ?? input.web?.request ?? (input.req instanceof Request ? input.req : undefined)
}

function getRequestLikeHeaders(input: AuthRuntimeRequestLike): AuthRuntimeRequestHeaders | undefined {
  return input.headers
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.headers : undefined)
    ?? input.node?.req?.headers
}

function getRequestLikeMethod(input: AuthRuntimeRequestLike): string {
  return input.method
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.method : undefined)
    ?? input.node?.req?.method
    ?? 'GET'
}

function getRequestLikeUrl(input: AuthRuntimeRequestLike, headers: Headers, options: NormalizeRequestInputOptions): string {
  const url = (typeof input.url === 'string' ? input.url : input.url?.toString())
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.url : undefined)
    ?? input.node?.req?.url
    ?? input.path
    ?? '/'

  try {
    return new URL(url).toString()
  } catch {
    const baseUrl = options.createRelativeRequestBaseUrl?.(headers)
      ?? `${headers.get('x-forwarded-proto') ?? 'http'}://${headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost'}`
    return new URL(url, baseUrl).toString()
  }
}

export function normalizeRequestInput(input: AuthRuntimeRequestInput, options: NormalizeRequestInputOptions = {}): Request {
  if (input instanceof Request) {
    return input
  }

  const request = getRequestFromLikeInput(input)
  if (request) {
    return request
  }

  const headers = normalizeRequestHeaders(getRequestLikeHeaders(input))
  return new Request(getRequestLikeUrl(input, headers, options), {
    method: getRequestLikeMethod(input),
    headers,
  })
}
