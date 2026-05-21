declare module 'next/server' {
  type NextResponseCookieOptions = {
    readonly path?: string
    readonly secure?: boolean
    readonly sameSite?: 'lax' | 'strict' | 'none'
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
