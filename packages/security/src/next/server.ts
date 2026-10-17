import { protect } from '../index'
import { cors } from '../cors'
import { getSecurityRuntime } from '../runtime'
import { prepareCsrfCookies } from '../cookie-issuance'
import { createSecurityRejectionResponse, isSecurityRejection } from '../rejection-response'

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

async function actionRequest(request: Request): Promise<Request> {
  const { field, header } = getSecurityRuntime().config.csrf
  if (!request.headers.has('next-action')
    || request.headers.get(header)?.trim()
    || !request.headers.get('content-type')?.startsWith('multipart/form-data')) return request

  try {
    const data = await request.clone().formData()
    const root = data.get('0')
    if (typeof root !== 'string') return request
    const args: unknown = JSON.parse(root)
    if (!Array.isArray(args)) return request
    for (const argument of args) {
      if (typeof argument !== 'string') continue
      const part = /^\$K([0-9a-f]+)$/.exec(argument)?.[1]
      if (!part) continue
      const token = data.get(`_${Number.parseInt(part, 16)}_${field}`)
      if (typeof token !== 'string') continue
      const headers = new Headers(request.headers)
      headers.set(header, token)
      return new Request(request.clone(), { headers })
    }
  } catch {
    return request
  }
  return request
}

export function csrfProtection(): NextCsrfMiddleware {
  return async (request) => {
    const preflight = cors.preflight(request)
    if (preflight) return preflight

    if (request.method.trim().toUpperCase() === 'TRACE') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE' },
      })
    }

    let response: Response | undefined
    try {
      await protect(await actionRequest(request))
      response = await issueCsrfCookie(request)
    } catch (error) {
      if (isSecurityRejection(error)) {
        return cors.apply(request, createSecurityRejectionResponse(error))
      }

      throw error
    }

    if (response) return cors.apply(request, response)
    if ([...cors.headers(request)].length === 0) return undefined
    const { NextResponse } = await import('next/server.js') as NextServerModule
    return cors.apply(request, NextResponse.next())
  }
}

export const nextSecurityInternals = {
  issueCsrfCookie,
}
