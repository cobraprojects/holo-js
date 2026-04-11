import type {
  AuthClientConfig,
  AuthClientRequestOptions,
  AuthUser,
  CurrentAuthResponse,
} from './contracts'

const DEFAULT_CURRENT_USER_ENDPOINT = '/api/auth/user'

type ResolvedClientConfig = {
  readonly endpoint: string
  readonly guard?: string
  readonly headers?: Record<string, string> | readonly (readonly [string, string])[]
  readonly fetchImpl: typeof fetch
}

const clientState: {
  config?: AuthClientConfig
  cache: Map<string, CurrentAuthResponse>
} = {
  config: undefined,
  cache: new Map(),
}

function getDefaultFetch(): typeof fetch {
  if (typeof fetch !== 'function') {
    throw new Error('[@holo-js/auth/client] Fetch is not available. Configure a fetch implementation explicitly.')
  }

  return fetch
}

function resolveClientConfig(options: AuthClientRequestOptions = {}): ResolvedClientConfig {
  return {
    endpoint: options.endpoint ?? clientState.config?.endpoint ?? DEFAULT_CURRENT_USER_ENDPOINT,
    guard: options.guard ?? clientState.config?.guard,
    headers: options.headers ?? clientState.config?.headers,
    fetchImpl: options.endpoint || options.guard || options.headers || clientState.config?.fetch
      ? (clientState.config?.fetch ?? getDefaultFetch())
      : getDefaultFetch(),
  }
}

function createCacheKey(config: ResolvedClientConfig): string {
  return `${config.endpoint}::${config.guard ?? 'default'}::${serializeHeadersForCache(config.headers)}`
}

function serializeHeadersForCache(headers: ResolvedClientConfig['headers']): string {
  const normalized = normalizeHeaders(headers)
  if (!normalized) {
    return ''
  }

  return Array.from(normalized.entries())
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}:${value}`)
    .join('\n')
}

function createRequestUrl(config: ResolvedClientConfig): string {
  if (!config.guard) {
    return config.endpoint
  }

  const base = config.endpoint.startsWith('http://') || config.endpoint.startsWith('https://')
    ? new URL(config.endpoint)
    : new URL(config.endpoint, 'https://holo.local')
  base.searchParams.set('guard', config.guard)
  const href = base.toString()

  return config.endpoint.startsWith('http://') || config.endpoint.startsWith('https://')
    ? href
    : `${base.pathname}${base.search}${base.hash}`
}

function normalizeHeaders(
  headers: ResolvedClientConfig['headers'],
): Headers | undefined {
  if (!headers) {
    return undefined
  }

  const normalized = new Headers()
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized.set(key, value)
    }
    return normalized
  }

  for (const [key, value] of Object.entries(headers)) {
    normalized.set(key, value)
  }

  return normalized
}

async function fetchCurrentUser(
  options: AuthClientRequestOptions = {},
  fetchOptions: { readonly force?: boolean } = {},
): Promise<CurrentAuthResponse> {
  const config = resolveClientConfig(options)
  const cacheKey = createCacheKey(config)
  if (!fetchOptions.force) {
    const cached = clientState.cache.get(cacheKey)
    if (cached) {
      return cached
    }
  }

  const response = await config.fetchImpl(createRequestUrl(config), {
    method: 'GET',
    headers: normalizeHeaders(config.headers),
  })

  if (!response.ok) {
    throw new Error(`[@holo-js/auth/client] Current-auth request failed with status ${response.status}.`)
  }

  let payload: CurrentAuthResponse
  try {
    payload = await response.json() as CurrentAuthResponse
  } catch {
    throw new Error('[@holo-js/auth/client] Current-auth response body was not valid JSON.')
  }

  clientState.cache.set(cacheKey, payload)
  return payload
}

export function configureAuthClient(config?: AuthClientConfig): void {
  clientState.config = config
  clientState.cache.clear()
}

export function resetAuthClient(): void {
  clientState.config = undefined
  clientState.cache.clear()
}

export async function user(options?: AuthClientRequestOptions): Promise<AuthUser | null> {
  return (await fetchCurrentUser(options)).user
}

export async function refreshUser(options?: AuthClientRequestOptions): Promise<AuthUser | null> {
  return (await fetchCurrentUser(options, { force: true })).user
}

export async function check(options?: AuthClientRequestOptions): Promise<boolean> {
  return (await fetchCurrentUser(options)).authenticated
}

export const authClientInternals = {
  createCacheKey,
  createRequestUrl,
  fetchCurrentUser,
  resolveClientConfig,
  serializeHeadersForCache,
}
