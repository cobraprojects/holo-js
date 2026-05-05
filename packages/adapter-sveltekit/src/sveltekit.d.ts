declare module '$app/server' {
  export function getRequestEvent(): {
    readonly cookies: {
      get(name: string): string | undefined
    }
    readonly request: {
      readonly headers: Headers
    }
  }
}
