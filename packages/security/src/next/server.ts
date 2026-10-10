import { protect } from '../index'
import { prepareCsrfCookies } from '../cookie-issuance'
import { SecurityCsrfError } from '../contracts'

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
  const cookies = await prepareCsrfCookies(request, name => getRequestCookie(request, name))
  if (cookies.length === 0) {
    return undefined
  }

  const { NextResponse } = await import('next/server.js') as NextServerModule
  const response = NextResponse.next()
  for (const cookie of cookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options)
  }
  return response
}

export function csrfProtection(): NextCsrfMiddleware {
  return async (request) => {
    if (request.method.trim().toUpperCase() === 'TRACE') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE' },
      })
    }

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
