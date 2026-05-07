import { AsyncLocalStorage } from 'node:async_hooks'

export type NextAuthRequestLike = {
  readonly cookies: {
    get(name: string): { readonly value: string } | undefined
  }
  readonly headers: Headers
}

type NextAuthRequestGlobals = typeof globalThis & {
  __holoNextAuthRequestStore?: AsyncLocalStorage<NextAuthRequestLike>
}

function getNextAuthRequestStore(): AsyncLocalStorage<NextAuthRequestLike> {
  const globals = globalThis as NextAuthRequestGlobals
  globals.__holoNextAuthRequestStore ??= new AsyncLocalStorage<NextAuthRequestLike>()

  return globals.__holoNextAuthRequestStore
}

export function getCurrentNextAuthRequest(): NextAuthRequestLike | undefined {
  return getNextAuthRequestStore().getStore()
}

export function runWithNextAuthRequest<TValue>(
  request: NextAuthRequestLike,
  callback: () => TValue,
): TValue {
  return getNextAuthRequestStore().run(request, callback)
}
