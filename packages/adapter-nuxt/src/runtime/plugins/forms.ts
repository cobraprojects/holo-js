import { defineNitroPlugin } from 'nitropack/runtime/plugin'

const FORM_FAILURE_COOKIE = 'holo_form_failure'

type NitroHeaderValue = number | string | readonly string[]

type NitroResponse = {
  body?: unknown
  statusCode?: number
  statusMessage?: string
  headers?: Headers | Record<string, NitroHeaderValue | undefined>
}

type NitroEvent = {
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

type NitroApp = {
  hooks: {
    hook(name: 'beforeResponse', handler: (event: NitroEvent, response: NitroResponse) => void): void
    hook(
      name: 'render:response',
      handler: (response: { body?: unknown, headers?: Record<string, NitroHeaderValue | undefined> }, context: { event: NitroEvent }) => void,
    ): void
  }
}

type FormFailurePayload = {
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

function getFormFailurePayload(value: unknown): FormFailurePayload | undefined {
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
  return `${FORM_FAILURE_COOKIE}=${encoded}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax`
}

function clearFormFailureCookie(): string {
  return `${FORM_FAILURE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

function readCookie(event: NitroEvent, name: string): string | undefined {
  const cookieHeader = getHeader(event, 'cookie')
  if (!cookieHeader) {
    return undefined
  }

  for (const segment of cookieHeader.split(';')) {
    const trimmed = segment.trim()
    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex <= 0) {
      continue
    }

    if (trimmed.slice(0, equalsIndex) === name) {
      return trimmed.slice(equalsIndex + 1)
    }
  }

  return undefined
}

function readFlashedFailure(event: NitroEvent): FormFailurePayload | undefined {
  const value = readCookie(event, FORM_FAILURE_COOKIE)
  if (!value) {
    return undefined
  }

  try {
    const decoded = JSON.parse(decodeURIComponent(value)) as unknown
    return isFormFailurePayload(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

function getFailureMessages(failure: FormFailurePayload): string[] {
  return Object.values(failure.errors)
    .flatMap(value => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function renderFailureHtml(failure: FormFailurePayload): string {
  const messages = getFailureMessages(failure)
  if (messages.length === 0) {
    return ''
  }

  const items = messages
    .map(message => `<li>${escapeHtml(message)}</li>`)
    .join('')

  return `<div data-holo-form-errors style="margin:1rem 0;padding:0.75rem 1rem;border:1px solid #fecaca;border-radius:0.5rem;background:#450a0a;color:#fecaca;"><ul style="margin:0;padding-left:1.25rem;">${items}</ul></div>`
}

function injectAfterBody(html: string, fragment: string): string {
  const bodyMatch = html.match(/<body[^>]*>/i)
  if (typeof bodyMatch?.index !== 'number') {
    return `${fragment}${html}`
  }

  const insertAt = bodyMatch.index + bodyMatch[0].length
  return `${html.slice(0, insertAt)}${fragment}${html.slice(insertAt)}`
}

export default defineNitroPlugin((nitroApp: NitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event, response) => {
    if (
      !isUnsafeMethod(event)
      || !acceptsHtml(event)
      || isApiRequest(event)
    ) {
      return
    }

    const failure = getFormFailurePayload(response.body)
    if (!failure) {
      return
    }

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
  })

  nitroApp.hooks.hook('render:response', (response, context) => {
    if (typeof response.body !== 'string') {
      return
    }

    const failure = readFlashedFailure(context.event)
    if (!failure) {
      return
    }

    const fragment = renderFailureHtml(failure)
    if (fragment) {
      response.body = injectAfterBody(response.body, fragment)
    }

    appendSetCookie(context.event, response, clearFormFailureCookie())
  })
})
