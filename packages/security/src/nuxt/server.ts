import {
  createError,
  defineEventHandler,
  getMethod,
  getRequestHeaders,
  getRequestURL,
  setCookie,
} from 'h3'
import type { H3Event } from 'h3'
import { csrf, isSecureRequest, protect } from '../index'
import { SecurityCsrfError } from '../contracts'
import {
  SECURITY_CLIENT_CONFIG_COOKIE,
  createSecurityClientConfig,
  serializeSecurityClientConfig,
} from '../client-config'
import { getSecurityRuntime } from '../runtime'

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

async function createRequest(event: H3Event): Promise<Request> {
  const method = getMethod(event)
  const headers = createHeaders(event)

  return new Request(getRequestURL(event), {
    method,
    headers,
  })
}

async function issueCsrfCookie(event: H3Event, request: Request): Promise<void> {
  const { config } = getSecurityRuntime()

  if (!config.csrf.enabled || !isSafeMethod(request.method)) {
    return
  }

  setCookie(event, config.csrf.cookie, await csrf.token(request), {
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(request),
  })
  setCookie(event, SECURITY_CLIENT_CONFIG_COOKIE, serializeSecurityClientConfig(createSecurityClientConfig(config)), {
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(request),
  })
}

export function csrfProtection(): ReturnType<typeof defineEventHandler> {
  return defineEventHandler(async (event) => {
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
  })
}

export const nuxtSecurityInternals = {
  createRequest,
  issueCsrfCookie,
}
