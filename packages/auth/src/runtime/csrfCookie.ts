export const defaultCsrfCookieName = 'XSRF-TOKEN'

export type CsrfCookieOptions = {
  readonly path: '/'
  readonly sameSite: 'lax'
  readonly secure: boolean
  readonly httpOnly: false
}

type CsrfCookieRequest = {
  readonly url: string | URL
  readonly headers: Headers
}

type CsrfCookieTarget = string | URL | CsrfCookieRequest

type WebCryptoSubtle = {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { readonly name: 'HMAC', readonly hash: 'SHA-256' },
    extractable: false,
    keyUsages: readonly ['sign'],
  ): Promise<object>
  sign(
    algorithm: 'HMAC',
    key: object,
    data: Uint8Array,
  ): Promise<ArrayBuffer>
}

type WebCrypto = {
  readonly subtle?: WebCryptoSubtle
  getRandomValues<TArray extends Uint8Array>(array: TArray): TArray
}

type BrowserEncodingGlobal = {
  btoa(value: string): string
}

function getGlobalCrypto(): WebCrypto | undefined {
  const runtime = globalThis as typeof globalThis & { readonly crypto?: WebCrypto }
  return runtime.crypto
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return (globalThis as typeof globalThis & BrowserEncodingGlobal).btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

async function signCsrfNonce(nonce: string, signingKey: string): Promise<string | undefined> {
  const crypto = getGlobalCrypto()
  if (!crypto?.subtle) {
    return undefined
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce))

  return base64UrlEncode(new Uint8Array(signature))
}

export async function createSignedCsrfToken(signingKey: string): Promise<string | undefined> {
  const crypto = getGlobalCrypto()
  if (!crypto) {
    return undefined
  }

  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = base64UrlEncode(nonceBytes)
  const signature = await signCsrfNonce(nonce, signingKey)

  return signature ? `${nonce}.${signature}` : undefined
}

export function isCsrfCookieRequest(method: string | undefined): boolean {
  const normalized = method?.trim().toUpperCase() ?? 'GET'
  return normalized === 'GET' || normalized === 'HEAD'
}

function normalizeForwardedValue(value: string): string {
  return value.trim().replace(/^"|"$/g, '').toLowerCase()
}

function getForwardedProto(headers: Headers): string | undefined {
  const forwardedProto = headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim()
  if (forwardedProto) {
    return normalizeForwardedValue(forwardedProto)
  }

  const forwarded = headers.get('forwarded')?.split(',', 1)[0]
  if (!forwarded) {
    return undefined
  }

  for (const segment of forwarded.split(';')) {
    const [name, value] = segment.split('=', 2)
    if (name?.trim().toLowerCase() === 'proto' && value) {
      return normalizeForwardedValue(value)
    }
  }

  return undefined
}

function isCsrfCookieRequestTarget(target: CsrfCookieTarget): target is CsrfCookieRequest {
  return typeof target === 'object'
    && !(target instanceof URL)
    && target.headers instanceof Headers
}

export function resolveCsrfCookieOptions(target: CsrfCookieTarget): CsrfCookieOptions {
  const requestUrl = isCsrfCookieRequestTarget(target)
    ? typeof target.url === 'string' ? new URL(target.url) : target.url
    : typeof target === 'string' ? new URL(target) : target
  const forwardedProto = isCsrfCookieRequestTarget(target)
    ? getForwardedProto(target.headers)
    : undefined

  return {
    path: '/',
    sameSite: 'lax',
    secure: forwardedProto === 'https' || requestUrl.protocol === 'https:',
    httpOnly: false,
  }
}
