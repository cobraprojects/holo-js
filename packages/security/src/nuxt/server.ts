import {
  createError,
  defineEventHandler,
  getCookie,
  getMethod,
  getRequestHeaders,
  getRequestURL,
  readRawBody,
  setCookie,
} from 'h3'
import type { H3Event } from 'h3'
import { csrf, csrfInternals, isSecureRequest, protect } from '../index'
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
  const { config } = getSecurityRuntime()

  if (!config.csrf.enabled || !isSafeMethod(request.method)) {
    return
  }

  const existingCsrfToken = getCookie(event, config.csrf.cookie)
  const shouldIssueCsrfToken = !existingCsrfToken
    || !csrfInternals.isValidSignedCsrfToken(existingCsrfToken)
  const clientConfig = serializeSecurityClientConfig(createSecurityClientConfig(config))
  const shouldIssueClientConfig = getCookie(event, SECURITY_CLIENT_CONFIG_COOKIE) !== clientConfig

  if (!shouldIssueCsrfToken && !shouldIssueClientConfig) {
    return
  }

  const cookieOptions = {
    httpOnly: false,
    path: '/',
    sameSite: 'lax' as const,
    secure: isSecureRequest(request),
  }

  if (shouldIssueCsrfToken) {
    setCookie(event, config.csrf.cookie, await csrf.token(request), cookieOptions)
  }

  if (shouldIssueClientConfig) {
    setCookie(event, SECURITY_CLIENT_CONFIG_COOKIE, clientConfig, cookieOptions)
  }
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
