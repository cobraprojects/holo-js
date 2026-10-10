import { isSecureRequest, token, csrfInternals } from './csrf'
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

export async function prepareCsrfCookies(
  request: Request,
  getCookie: (name: string) => string | undefined,
): Promise<readonly SecurityCookie[]> {
  const { config } = getSecurityRuntime()
  const method = request.method.trim().toUpperCase()
  if (!config.csrf.enabled || (method !== 'GET' && method !== 'HEAD')) {
    return []
  }

  const existingToken = getCookie(config.csrf.cookie)
  const clientConfig = serializeSecurityClientConfig(createSecurityClientConfig(config))
  const shouldIssueToken = !existingToken || !csrfInternals.isValidSignedCsrfToken(existingToken)
  const shouldIssueClientConfig = getCookie(SECURITY_CLIENT_CONFIG_COOKIE) !== clientConfig
  if (!shouldIssueToken && !shouldIssueClientConfig) {
    return []
  }

  const options = {
    httpOnly: false as const,
    path: '/' as const,
    sameSite: 'lax' as const,
    secure: isSecureRequest(request),
  }
  const cookies: SecurityCookie[] = []
  if (shouldIssueToken) {
    cookies.push({ name: config.csrf.cookie, value: await token(request), options })
  }
  if (shouldIssueClientConfig) {
    cookies.push({ name: SECURITY_CLIENT_CONFIG_COOKIE, value: clientConfig, options })
  }
  return cookies
}
