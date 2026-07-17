const FORM_FAILURE_COOKIE = 'holo_form_failure'

export type NitroHeaderValue = number | string | readonly string[]

export type NitroResponse = {
  body?: unknown
  statusCode?: number
  statusMessage?: string
  headers?: Headers | Record<string, NitroHeaderValue | undefined>
}

export type NitroEvent = {
  path?: string
  node?: {
    req?: {
      url?: string
      method?: string
      headers?: Record<string, string | string[] | undefined>
    }
    res?: {
      statusCode?: number
      statusMessage?: string
      getHeader?: (name: string) => number | string | string[] | undefined
      setHeader?: (name: string, value: number | string | readonly string[]) => void
    }
  }
}

export type FormFailurePayload = {
  ok: false
  status: number
  valid: false
  errors: Record<string, unknown>
} & Record<string, unknown>

function getHeader(event: NitroEvent, name: string): string | undefined {
  const value = event.node?.req?.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function isFormFailurePayload(value: unknown): value is FormFailurePayload {
  if (!value || typeof value !== 'object') {
    return false
  }

  const payload = value as Record<string, unknown>
  return payload.ok === false
    && payload.valid === false
    && typeof payload.status === 'number'
    && !!payload.errors
    && typeof payload.errors === 'object'
}

export function getFormFailurePayload(value: unknown): FormFailurePayload | undefined {
  if (isFormFailurePayload(value)) {
    return value
  }

  if (typeof value !== 'string') {
    return undefined
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return isFormFailurePayload(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function acceptsHtml(event: NitroEvent): boolean {
  return getHeader(event, 'accept')?.toLowerCase().includes('text/html') === true
}

function isUnsafeMethod(event: NitroEvent): boolean {
  const method = event.node?.req?.method?.toUpperCase()
  return method !== 'GET' && method !== 'HEAD'
}

function isApiRequest(event: NitroEvent): boolean {
  const path = event.path ?? event.node?.req?.url ?? ''
  return path.startsWith('/api/')
}

function getRedirectLocation(event: NitroEvent): string {
  const referer = getHeader(event, 'referer')
  const host = getHeader(event, 'host') ?? 'localhost'
  if (referer) {
    try {
      const url = new URL(referer)
      if (url.host === host) {
        return `${url.pathname}${url.search}`
      }
    } catch {
      // Ignore malformed client-controlled referer headers.
    }
  }

  return event.path ?? event.node?.req?.url ?? '/'
}

function appendSetCookie(event: NitroEvent, response: NitroResponse, cookie: string): void {
  const responseCookie = event.node?.res?.getHeader?.('set-cookie')
  if (Array.isArray(responseCookie)) {
    event.node?.res?.setHeader?.('set-cookie', [...responseCookie, cookie])
  } else if (responseCookie) {
    event.node?.res?.setHeader?.('set-cookie', [String(responseCookie), cookie])
  } else {
    event.node?.res?.setHeader?.('set-cookie', cookie)
  }

  if (response.headers instanceof Headers) {
    response.headers.append('set-cookie', cookie)
  } else {
    response.headers ??= {}
    const current = response.headers['set-cookie']
    if (Array.isArray(current)) {
      response.headers['set-cookie'] = [...current.map(String), cookie]
      return
    }

    response.headers['set-cookie'] = current ? [String(current), cookie] : cookie
  }
}

function setHeader(event: NitroEvent, response: NitroResponse, name: string, value: string): void {
  event.node?.res?.setHeader?.(name, value)

  if (response.headers instanceof Headers) {
    response.headers.set(name, value)
    return
  }

  response.headers ??= {}
  response.headers[name] = value
}

function serializeFormFailureCookie(payload: FormFailurePayload): string {
  const encoded = encodeURIComponent(JSON.stringify(payload))
  return `${FORM_FAILURE_COOKIE}=${encoded}; Path=/; Max-Age=60; SameSite=Lax`
}

export function shouldRedirectFormFailure(event: NitroEvent): boolean {
  return isUnsafeMethod(event)
    && acceptsHtml(event)
    && !isApiRequest(event)
}

export function applyFormFailureRedirect(
  event: NitroEvent,
  response: NitroResponse,
  failure: FormFailurePayload,
): void {
  if (event.node?.res) {
    event.node.res.statusCode = 303
    event.node.res.statusMessage = 'See Other'
  }
  response.statusCode = 303
  response.statusMessage = 'See Other'
  response.body = ''
  setHeader(event, response, 'location', getRedirectLocation(event))
  setHeader(event, response, 'content-type', 'text/html; charset=utf-8')
  appendSetCookie(event, response, serializeFormFailureCookie(failure))
}

export const formFailureInternals = {
  appendSetCookie,
}
