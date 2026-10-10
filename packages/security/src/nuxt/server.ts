import {
  createError,
  defineEventHandler,
  getCookie,
  getMethod,
  getRequestHeaders,
  getRequestURL,
  readRawBody,
  setCookie,
  type H3Event,
} from 'h3'
import { protect } from '../index'
import { prepareCsrfCookies } from '../cookie-issuance'
import { SecurityCsrfError } from '../contracts'

function isSafeMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD'
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

async function createRequest(event: H3Event): Promise<Request> {
  const method = getMethod(event)
  const headers = createHeaders(event)
  const body = isSafeMethod(method)
    ? undefined
    : await readRawBody(event, false)

  return new Request(getRequestURL(event), {
    method,
    headers,
    body: createRequestBody(body),
  })
}

async function issueCsrfCookie(event: H3Event, request: Request): Promise<void> {
  const cookies = await prepareCsrfCookies(request, name => getCookie(event, name))
  for (const cookie of cookies) {
    setCookie(event, cookie.name, cookie.value, cookie.options)
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

    const request = await createRequest(event)

    try {
      await protect(request)
    } catch (error) {
      if (error instanceof SecurityCsrfError) {
        throw createError({
          statusCode: error.status,
          statusMessage: error.message,
          message: error.message,
        })
      }

      throw error
    }

    await issueCsrfCookie(event, request)
    return undefined
  })
}

export const nuxtSecurityInternals = {
  createRequest,
  issueCsrfCookie,
}
