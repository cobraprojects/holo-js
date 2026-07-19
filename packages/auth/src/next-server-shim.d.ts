declare module 'next/server' {
  export function connection(): Promise<void>

  type NextResponseCookieOptions = {
    readonly path?: string
    readonly secure?: boolean
    readonly sameSite?: 'lax' | 'strict' | 'none'
    readonly httpOnly?: boolean
  }

  type NextResponseWithCookies = Response & {
    readonly cookies: {
      set(name: string, value: string, options?: NextResponseCookieOptions): void
    }
  }

  export const NextResponse: {
    next(): NextResponseWithCookies
  }
}
