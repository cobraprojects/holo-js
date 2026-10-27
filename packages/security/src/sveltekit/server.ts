import { responseCookieInternals } from '@holo-js/kernel'
import { protect } from '../index'
import { cors } from '../cors'
import { prepareCsrfCookies } from '../cookie-issuance'
import { createSecurityRejectionResponse, isSecurityRejection } from '../rejection-response'

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

async function issueCsrfCookie(event: SvelteKitCsrfEvent): Promise<void> {
  const { cookies, sessionCookies } = await prepareCsrfCookies(event.request, name => event.cookies.get(name))
  for (const cookie of cookies) {
    event.cookies.set(cookie.name, cookie.value, cookie.options)
  }
  for (const sessionCookie of sessionCookies) {
    const parsed = responseCookieInternals.parseResponseCookie(sessionCookie)
    if (!parsed) throw new Error('[@holo-js/security] The CSRF session cookie could not be parsed.')
    event.cookies.set(parsed.name, parsed.value, parsed.options)
  }
}

export function csrfProtection(): SvelteKitCsrfHandle {
  return async ({ event, resolve }) => {
    const preflight = cors.preflight(event.request)
    if (preflight) return preflight

    if (event.request.method.trim().toUpperCase() === 'TRACE') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE' },
      })
    }

    try {
      await protect(event.request)
      await issueCsrfCookie(event)
    } catch (error) {
      if (isSecurityRejection(error)) {
        return cors.apply(event.request, createSecurityRejectionResponse(error))
      }

      throw error
    }

    return cors.apply(event.request, await resolve(event))
  }
}

export const svelteKitSecurityInternals = {
  issueCsrfCookie,
}
