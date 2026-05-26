import { csrf, isSecureRequest, protect } from '../index'
import { SecurityCsrfError } from '../contracts'
import {
  SECURITY_CLIENT_CONFIG_COOKIE,
  createSecurityClientConfig,
  serializeSecurityClientConfig,
} from '../client-config'
import { getSecurityRuntime } from '../runtime'

type NextCsrfRequest = Request & {
  readonly nextUrl?: URL
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

async function issueCsrfCookie(request: NextCsrfRequest): Promise<Response | undefined> {
  const { config } = getSecurityRuntime()

  if (!config.csrf.enabled || !isSafeMethod(request.method)) {
    return undefined
  }

  const { NextResponse } = await import('next/server') as NextServerModule
  const response = NextResponse.next()
  response.cookies.set(config.csrf.cookie, await csrf.token(request), {
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(request),
  })
  response.cookies.set(SECURITY_CLIENT_CONFIG_COOKIE, serializeSecurityClientConfig(createSecurityClientConfig(config)), {
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(request),
  })

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
