import type { CookieOptions } from './cookieSerialization'

type ParsedSetCookieOptions = {
  path?: string
  domain?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: CookieOptions['sameSite']
  partitioned?: boolean
}

function parseCookieAttribute(rawAttribute: string): {
  readonly key: string
  readonly value: string
} | null {
  const attribute = rawAttribute.trim()
  if (!attribute) {
    return null
  }

  const separator = attribute.indexOf('=')
  const key = (separator === -1 ? attribute : attribute.slice(0, separator)).trim().toLowerCase()
  const value = separator === -1 ? '' : attribute.slice(separator + 1).trim()

  return { key, value }
}

function parseSameSite(value: string): CookieOptions['sameSite'] | undefined {
  const normalized = value.toLowerCase()
  if (normalized === 'lax' || normalized === 'strict' || normalized === 'none') {
    return normalized
  }

  return undefined
}

function applyCookieAttribute(options: ParsedSetCookieOptions, rawAttribute: string): void {
  const attribute = parseCookieAttribute(rawAttribute)
  if (!attribute) {
    return
  }

  switch (attribute.key) {
    case 'path':
      options.path = attribute.value
      break
    case 'domain':
      options.domain = attribute.value
      break
    case 'secure':
      options.secure = true
      break
    case 'httponly':
      options.httpOnly = true
      break
    case 'samesite': {
      const sameSite = parseSameSite(attribute.value)
      if (sameSite) {
        options.sameSite = sameSite
      }
      break
    }
    case 'partitioned':
      options.partitioned = true
      break
  }
}

function decodeCookieName(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function parseSetCookieDefinition(header: string): {
  readonly name: string
  readonly options: CookieOptions
} | null {
  const [nameValue, ...attributes] = header.split(';')
  /* v8 ignore next -- split() always yields a first string element for string input. */
  const separator = nameValue?.indexOf('=') ?? -1
  if (!nameValue || separator <= 0) {
    return null
  }

  const options: ParsedSetCookieOptions = {}

  for (const rawAttribute of attributes) {
    applyCookieAttribute(options, rawAttribute)
  }

  const name = decodeCookieName(nameValue.slice(0, separator))
  if (!name) {
    return null
  }

  return { name, options }
}
