import { csrf, csrfInternals, isSecureRequest, protect } from '../index'
import { SecurityCsrfError } from '../contracts'
import {
  SECURITY_CLIENT_CONFIG_COOKIE,
  createSecurityClientConfig,
  serializeSecurityClientConfig,
} from '../client-config'
import { getSecurityRuntime } from '../runtime'

type NextCsrfRequest = Request & {
  readonly nextUrl?: URL
  readonly cookies?: {
    get(name: string): string | { readonly value?: string } | undefined
  }
}

type NextResponseCookieOptions = {
  readonly path?: string
  readonly secure?: boolean
  readonly sameSite?: 'lax' | 'strict' | 'none'
  readonly httpOnly?: boolean
}

type NextResponseWithCookies = Response & {
  readonly cookies: {
    set(name: string, value: string, options?: NextResponseCookieOptions): void
  }
}

type NextServerModule = {
  readonly NextResponse: {
    next(): NextResponseWithCookies
  }
}

export type NextCsrfMiddleware = (
  request: NextCsrfRequest,
) => Response | undefined | Promise<Response | undefined>

function isSafeMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD'
}

function createCsrfErrorResponse(error: SecurityCsrfError): Response {
  return new Response(error.message, {
    status: error.status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}

function getRequestCookie(request: NextCsrfRequest, name: string): string | undefined {
  const cookie = request.cookies?.get(name)
  if (typeof cookie === 'string') {
    return cookie
  }

  return typeof cookie?.value === 'string' ? cookie.value : undefined
}

async function issueCsrfCookie(request: NextCsrfRequest): Promise<Response | undefined> {
  const { config } = getSecurityRuntime()

  if (!config.csrf.enabled || !isSafeMethod(request.method)) {
    return undefined
  }

  const existingCsrfToken = getRequestCookie(request, config.csrf.cookie)
  const shouldIssueCsrfToken = !existingCsrfToken
    || !csrfInternals.isValidSignedCsrfToken(existingCsrfToken)
  const clientConfig = serializeSecurityClientConfig(createSecurityClientConfig(config))
  const shouldIssueClientConfig = getRequestCookie(request, SECURITY_CLIENT_CONFIG_COOKIE) !== clientConfig

  if (!shouldIssueCsrfToken && !shouldIssueClientConfig) {
    return undefined
  }

  const { NextResponse } = await import('next/server') as NextServerModule
  const response = NextResponse.next()
  const cookieOptions = {
    httpOnly: false,
    path: '/',
    sameSite: 'lax' as const,
    secure: isSecureRequest(request),
  }

  if (shouldIssueCsrfToken) {
    response.cookies.set(config.csrf.cookie, await csrf.token(request), cookieOptions)
  }

  if (shouldIssueClientConfig) {
    response.cookies.set(SECURITY_CLIENT_CONFIG_COOKIE, clientConfig, cookieOptions)
  }

  return response
}

export function csrfProtection(): NextCsrfMiddleware {
  return async (request) => {
    try {
      await protect(request)
    } catch (error) {
      if (error instanceof SecurityCsrfError) {
        return createCsrfErrorResponse(error)
      }

      throw error
    }

    return await issueCsrfCookie(request)
  }
}

export const nextSecurityInternals = {
  issueCsrfCookie,
}
