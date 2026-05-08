export type CookieOptions = {
  readonly path?: string
  readonly domain?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: 'lax' | 'strict' | 'none'
  readonly partitioned?: boolean
}

export type CookieSerializationOptions = CookieOptions & {
  readonly expires?: Date
  readonly maxAge?: number
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieSerializationOptions = {},
): string {
  const attributes = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
  ]

  if (options.domain) {
    attributes.push(`Domain=${options.domain}`)
  }
  if (typeof options.maxAge !== 'undefined' && options.maxAge >= 0) {
    attributes.push(`Max-Age=${options.maxAge}`)
  }
  if (options.expires) {
    attributes.push(`Expires=${options.expires.toUTCString()}`)
  }
  if (options.secure) {
    attributes.push('Secure')
  }
  if (options.httpOnly) {
    attributes.push('HttpOnly')
  }
  if (options.sameSite) {
    attributes.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`)
  }
  if (options.partitioned) {
    attributes.push('Partitioned')
  }

  return attributes.join('; ')
}
