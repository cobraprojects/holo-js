declare module 'next/server' {
  export const NextResponse: {
    next(): Response & {
      readonly cookies: {
        set(
          name: string,
          value: string,
          options?: {
            readonly path?: string
            readonly secure?: boolean
            readonly sameSite?: 'lax' | 'strict' | 'none'
            readonly httpOnly?: boolean
          },
        ): void
      }
    }
  }
}

declare module 'h3' {
  export type H3Event = {
    readonly node: {
      readonly req: {
        readonly headers: Record<string, string | string[] | undefined>
      }
    }
  }

  export function createError(input: {
    readonly statusCode: number
    readonly statusMessage?: string
    readonly message?: string
  }): Error
  export function defineEventHandler<TValue>(
    handler: (event: H3Event) => TValue | Promise<TValue>,
  ): (event: H3Event) => TValue | Promise<TValue>
  export function getCookie(event: H3Event, name: string): string | undefined
  export function getMethod(event: H3Event): string
  export function getRequestHeaders(event: H3Event): Record<string, string | undefined>
  export function getRequestURL(event: H3Event): URL
  export function readRawBody(event: H3Event, encoding: false): Promise<Buffer | undefined>
  export function setCookie(
    event: H3Event,
    name: string,
    value: string,
    options?: {
      readonly path?: string
      readonly secure?: boolean
      readonly sameSite?: 'lax' | 'strict' | 'none'
      readonly httpOnly?: boolean
    },
  ): void
}
