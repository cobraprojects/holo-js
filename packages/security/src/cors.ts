import type { NormalizedHoloCorsConfig } from '@holo-js/config'
import type { SecurityCorsFacade } from './contracts'
import { getSecurityRuntime } from './runtime'

function matchesPathPattern(pathname: string, pattern: string): boolean {
  const segments = pattern.split('*')
  if (segments.length === 1) {
    return pathname === pattern
  }

  const firstSegment = segments[0] as string
  if (firstSegment && !pathname.startsWith(firstSegment)) {
    return false
  }

  let position = firstSegment.length
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] as string
    if (!segment) {
      continue
    }

    const nextPosition = pathname.indexOf(segment, position)
    if (nextPosition < 0) {
      return false
    }

    position = nextPosition + segment.length
  }

  const lastSegment = segments[segments.length - 1] as string
  return pattern.endsWith('*') || pathname.endsWith(lastSegment)
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  try {
    const parsed = new URL(trimmed)
    return parsed.host.toLowerCase()
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, '').toLowerCase()
  }
}

function isCorsPath(config: NormalizedHoloCorsConfig, request: Request): boolean {
  const pathname = new URL(request.url).pathname
  return config.paths.some(pattern => matchesPathPattern(pathname, pattern))
}

function isStatefulOrigin(config: NormalizedHoloCorsConfig, origin: string): boolean {
  const normalizedOrigin = normalizeDomain(origin)
  return normalizedOrigin !== ''
    && config.statefulDomains.some(domain => normalizeDomain(domain) === normalizedOrigin)
}

function resolveAllowedOrigin(config: NormalizedHoloCorsConfig, origin: string | null): string | undefined {
  if (!origin) {
    return undefined
  }

  if (config.origins.includes(origin) || isStatefulOrigin(config, origin)) {
    return origin
  }

  if (config.origins.includes('*')) {
    return config.credentials ? origin : '*'
  }

  return undefined
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('vary')
  const entries = new Set([
    ...(existing ? existing.split(',') : []),
    ...value.split(','),
  ].map(entry => entry.trim()).filter(Boolean))

  headers.set('Vary', Array.from(entries).join(', '))
}

export function headers(request: Request): Headers {
  const config = getSecurityRuntime().cors
  const result = new Headers()
  if (!isCorsPath(config, request)) {
    return result
  }

  const origin = request.headers.get('origin')
  if (origin === null) {
    appendVary(result, 'Origin')
    return result
  }

  const allowedOrigin = resolveAllowedOrigin(config, origin)
  if (!allowedOrigin) {
    appendVary(result, 'Origin')
    return result
  }

  result.set('Access-Control-Allow-Origin', allowedOrigin)
  appendVary(result, 'Origin')

  if (config.credentials || isStatefulOrigin(config, origin)) {
    result.set('Access-Control-Allow-Credentials', 'true')
  }

  if (request.method.toUpperCase() === 'OPTIONS') {
    result.set('Access-Control-Allow-Methods', config.methods.join(', '))
    result.set('Access-Control-Allow-Headers', config.headers.join(', '))
    result.set('Access-Control-Max-Age', String(config.maxAge))
    appendVary(result, 'Access-Control-Request-Method')
    appendVary(result, 'Access-Control-Request-Headers')
  }

  return result
}

export function apply(request: Request, response: Response = new Response(null, { status: 204 })): Response {
  const nextHeaders = new Headers(response.headers)
  const corsHeaders = headers(request)
  corsHeaders.forEach((value, key) => {
    if (key.toLowerCase() === 'vary') {
      appendVary(nextHeaders, value)
      return
    }

    nextHeaders.set(key, value)
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  })
}

export function preflight(request: Request): Response | null {
  if (request.method.toUpperCase() !== 'OPTIONS') {
    return null
  }

  if (!request.headers.has('access-control-request-method')) {
    return null
  }

  const response = apply(request)
  return response.headers.has('access-control-allow-origin') ? response : null
}

export const cors = Object.freeze({
  headers,
  preflight,
  apply,
}) satisfies SecurityCorsFacade

export const corsInternals = {
  appendVary,
  isCorsPath,
  isStatefulOrigin,
  matchesPathPattern,
  normalizeDomain,
  resolveAllowedOrigin,
}
