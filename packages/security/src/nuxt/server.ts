import { readBoundedCachedBody, readBoundedNodeRequestBody, requestBodyLimitFor } from '@holo-js/kernel'
import {
  createError,
  defineEventHandler,
  appendResponseHeader,
  getCookie,
  getMethod,
  getRequestHeader,
  getRequestHeaders,
  getRequestURL,
  setCookie,
  setResponseHeader,
  type H3Event,
} from 'h3'
import { protect } from '../index'
import { csrfInternals } from '../csrf'
import { cors } from '../cors'
import { prepareCsrfCookies } from '../cookie-issuance'
import { isSecurityRejection } from '../rejection-response'

function isSafeMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS'
}

function createHeaders(event: H3Event): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(getRequestHeaders(event))) {
    if (typeof value === 'string') {
      headers.append(name, value)
    }
  }

  return headers
}

function createRequestBody(body: Uint8Array | undefined): RequestInit['body'] {
  if (!body) {
    return undefined
  }

  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy.buffer
}

const h3RawBodySymbol = Symbol.for('h3RawBody')

async function readBoundedEventBody(event: H3Event): Promise<Uint8Array> {
  const limit = requestBodyLimitFor(getRequestHeader(event, 'content-type'))
  const cached = await readBoundedCachedBody((event.node.req as unknown as Record<symbol, unknown>)[h3RawBodySymbol] ?? event._requestBody, limit)
  const bytes = cached ?? await readBoundedNodeRequestBody(event.node.req, limit, getRequestHeader(event, 'content-length'))
  event._requestBody = bytes
  Object.assign(event.node.req, { [h3RawBodySymbol]: bytes })
  return bytes
}

async function createRequest(event: H3Event): Promise<Request> {
  if (event.web?.request) {
    const request = event.web.request.clone()
    event._requestBody = event.web.request.body ?? undefined
    return request
  }
  const method = getMethod(event)
  const headers = createHeaders(event)
  const body = isSafeMethod(method)
    ? undefined
    : await readBoundedEventBody(event)

  return new Request(getRequestURL(event, { xForwardedProto: false }), {
    method,
    headers,
    body: createRequestBody(body),
  })
}

function shareSessionWithHandlers(event: H3Event, token: string, sessionCookies: readonly string[]): void {
  const cookie = [event.headers.get('cookie'), ...sessionCookies.map(sessionCookie => sessionCookie.split(';', 1)[0])]
    .filter(Boolean)
    .join('; ')
  event.headers.set('cookie', cookie)
  event.node.req.headers.cookie = cookie
  if (event.web?.request) {
    csrfInternals.rememberSessionToken(event.web.request, token)
  }
}

async function issueCsrfCookie(event: H3Event, request: Request): Promise<void> {
  const { token, cookies, sessionCookies } = await prepareCsrfCookies(request, name => getCookie(event, name))
  for (const cookie of cookies) {
    setCookie(event, cookie.name, cookie.value, cookie.options)
  }
  for (const sessionCookie of sessionCookies) {
    appendResponseHeader(event, 'set-cookie', sessionCookie)
  }
  if (token && sessionCookies.length > 0) {
    shareSessionWithHandlers(event, token, sessionCookies)
  }
}

export function csrfProtection(): ReturnType<typeof defineEventHandler> {
  return defineEventHandler(async (event) => {
    if (getMethod(event).trim().toUpperCase() === 'TRACE') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE' },
      })
    }

    try {
      const request = await createRequest(event)
      const preflight = cors.preflight(request)
      if (preflight) return preflight
      cors.headers(request).forEach((value, name) => setResponseHeader(event, name, value))

      await protect(request)
      await issueCsrfCookie(event, request)
    } catch (error) {
      if (isSecurityRejection(error)) {
        throw createError({
          statusCode: error.status,
          statusMessage: error.message,
          message: error.message,
        })
      }

      throw error
    }

    return undefined
  })
}

export const nuxtSecurityInternals = {
  createRequest,
  issueCsrfCookie,
}
