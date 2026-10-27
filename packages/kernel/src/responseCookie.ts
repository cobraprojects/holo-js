type ResponseCookieOptions = {
  path: string
  domain?: string
  maxAge?: number
  expires?: Date
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  partitioned?: boolean
}

type ParsedResponseCookie = {
  readonly name: string
  readonly value: string
  readonly options: ResponseCookieOptions
}

function safeDecodeCookieSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseResponseCookie(cookie: string): ParsedResponseCookie | null {
  const [nameValue = '', ...attributes] = cookie.split(';')
  const separator = nameValue.indexOf('=')
  if (!nameValue || separator <= 0) {
    return null
  }

  const options: ResponseCookieOptions = { path: '/', secure: false, httpOnly: false }
  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim()
    if (!attribute) {
      continue
    }

    const attributeSeparator = attribute.indexOf('=')
    const key = (attributeSeparator === -1 ? attribute : attribute.slice(0, attributeSeparator)).trim().toLowerCase()
    const value = attributeSeparator === -1 ? '' : attribute.slice(attributeSeparator + 1).trim()

    switch (key) {
      case 'path':
        options.path = value || '/'
        break
      case 'domain':
        options.domain = value
        break
      case 'max-age': {
        const maxAge = Number(value)
        if (Number.isFinite(maxAge)) {
          options.maxAge = maxAge
        }
        break
      }
      case 'expires': {
        const expires = new Date(value)
        if (!Number.isNaN(expires.getTime())) {
          options.expires = expires
        }
        break
      }
      case 'secure':
        options.secure = true
        break
      case 'httponly':
        options.httpOnly = true
        break
      case 'samesite':
        if (value.toLowerCase() === 'lax' || value.toLowerCase() === 'strict' || value.toLowerCase() === 'none') {
          options.sameSite = value.toLowerCase() as ResponseCookieOptions['sameSite']
        }
        break
      case 'partitioned':
        options.partitioned = value ? value.toLowerCase() === 'true' : true
        break
    }
  }

  return {
    name: safeDecodeCookieSegment(nameValue.slice(0, separator)),
    value: safeDecodeCookieSegment(nameValue.slice(separator + 1)),
    options,
  }
}

export const responseCookieInternals = { parseResponseCookie }
