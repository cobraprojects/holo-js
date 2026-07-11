import { csrf, isSecureRequest, protect } from '../index'
import { getSecurityRuntime } from '../runtime'
import { SecurityCsrfError } from '../contracts'
import {
  SECURITY_CLIENT_CONFIG_COOKIE,
  createSecurityClientConfig,
  serializeSecurityClientConfig,
} from '../client-config'

type SvelteKitCookieOptions = {
  path: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
}

type SvelteKitCsrfEvent = {
  readonly url: URL
  readonly request: Request
  readonly cookies: {
    get(name: string): string | undefined
    set(name: string, value: string, options: SvelteKitCookieOptions): void
  }
}

type SvelteKitResolveOptions = {
  readonly transformPageChunk?: (input: {
    readonly html: string
    readonly done: boolean
  }) => string | Promise<string>
  readonly filterSerializedResponseHeaders?: (name: string, value: string) => boolean
  readonly preload?: (input: {
    readonly type: 'js' | 'css' | 'font' | 'asset'
    readonly path: string
  }) => boolean
}

export type SvelteKitCsrfHandleInput<TEvent extends SvelteKitCsrfEvent = SvelteKitCsrfEvent> = {
  readonly event: TEvent
  readonly resolve: (event: TEvent, options?: SvelteKitResolveOptions) => Response | Promise<Response>
}

export type SvelteKitCsrfHandle = <TEvent extends SvelteKitCsrfEvent>(
  input: SvelteKitCsrfHandleInput<TEvent>,
) => Response | Promise<Response>

function isSafeMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD'
}

async function issueCsrfCookie(event: SvelteKitCsrfEvent): Promise<void> {
  const runtime = getSecurityRuntime()
  const { config } = runtime

  if (!config.csrf.enabled || !isSafeMethod(event.request.method)) {
    return
  }

  event.cookies.set(config.csrf.cookie, await csrf.token(event.request), {
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(event.request),
  })
  event.cookies.set(SECURITY_CLIENT_CONFIG_COOKIE, serializeSecurityClientConfig(createSecurityClientConfig(config)), {
    httpOnly: false,
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(event.request),
  })
}

function createCsrfErrorResponse(error: SecurityCsrfError): Response {
  return new Response(error.message, {
    status: error.status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}

export function csrfProtection(): SvelteKitCsrfHandle {
  return async ({ event, resolve }) => {
    if (event.request.method.trim().toUpperCase() === 'TRACE') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE' },
      })
    }

    try {
      await protect(event.request)
    } catch (error) {
      if (error instanceof SecurityCsrfError) {
        return createCsrfErrorResponse(error)
      }

      throw error
    }

    await issueCsrfCookie(event)

    return resolve(event)
  }
}

export const svelteKitSecurityInternals = {
  issueCsrfCookie,
}
