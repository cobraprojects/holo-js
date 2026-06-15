import type { CookieOptions } from './cookieSerialization'

type ParsedSetCookieOptions = {
  -readonly [TKey in keyof CookieOptions]?: CookieOptions[TKey]
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
  const attributeSeparator = header.indexOf(';')
  const nameValue = attributeSeparator === -1 ? header : header.slice(0, attributeSeparator)
  const separator = nameValue.indexOf('=')
  if (!nameValue || separator <= 0) {
    return null
  }

  const options: ParsedSetCookieOptions = {}

  for (const rawAttribute of attributeSeparator === -1 ? [] : header.slice(attributeSeparator + 1).split(';')) {
    applyCookieAttribute(options, rawAttribute)
  }

  const name = decodeCookieName(nameValue.slice(0, separator))
  if (!name) {
    return null
  }

  return { name, options }
}
