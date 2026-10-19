import { csrfInternals, encryptedToken, isSecureRequest } from './csrf'
import {
  SECURITY_CLIENT_CONFIG_COOKIE,
  createSecurityClientConfig,
  serializeSecurityClientConfig,
} from './client-config'
import { getSecurityRuntime } from './runtime'

type SecurityCookie = {
  readonly name: string
  readonly value: string
  readonly options: {
    readonly httpOnly: false
    readonly path: '/'
    readonly sameSite: 'lax'
    readonly secure: boolean
  }
}

export type PreparedCsrfCookies = {
  readonly cookies: readonly SecurityCookie[]
  readonly sessionCookies: readonly string[]
}

const NO_CSRF_COOKIES: PreparedCsrfCookies = Object.freeze({ cookies: Object.freeze([]), sessionCookies: Object.freeze([]) })

export async function prepareCsrfCookies(
  request: Request,
  getCookie: (name: string) => string | undefined,
): Promise<PreparedCsrfCookies> {
  const { config } = getSecurityRuntime()
  const method = request.method.trim().toUpperCase()
  if (!config.csrf.enabled || (method !== 'GET' && method !== 'HEAD')) {
    return NO_CSRF_COOKIES
  }

  const { token, sessionCookies } = await csrfInternals.ensureSessionToken(request)
  const existingCookie = getCookie(config.csrf.cookie)
  const clientConfig = serializeSecurityClientConfig(createSecurityClientConfig(config))
  const shouldIssueToken = !existingCookie || csrfInternals.decryptCsrfToken(existingCookie) !== token
  const shouldIssueClientConfig = getCookie(SECURITY_CLIENT_CONFIG_COOKIE) !== clientConfig

  const options = {
    httpOnly: false as const,
    path: '/' as const,
    sameSite: 'lax' as const,
    secure: isSecureRequest(request),
  }
  const cookies: SecurityCookie[] = []
  if (shouldIssueToken) {
    cookies.push({ name: config.csrf.cookie, value: await encryptedToken(request, token), options })
  }
  if (shouldIssueClientConfig) {
    cookies.push({ name: SECURITY_CLIENT_CONFIG_COOKIE, value: clientConfig, options })
  }
  return { cookies, sessionCookies }
}

export function appendSetCookies(response: Response, setCookies: readonly string[]): Response {
  if (setCookies.length === 0) {
    return response
  }

  const headers = new Headers(response.headers)
  for (const setCookie of setCookies) {
    headers.append('Set-Cookie', setCookie)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
