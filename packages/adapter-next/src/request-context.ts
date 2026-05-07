import { AsyncLocalStorage } from 'node:async_hooks'

export type NextRequestLike = {
  readonly cookies: {
    get(name: string): { readonly value: string } | undefined
  }
  readonly headers: Headers
}

type NextRequestGlobals = typeof globalThis & {
  __holoNextAuthRequestStore?: AsyncLocalStorage<NextRequestLike>
}

function getNextRequestStore(): AsyncLocalStorage<NextRequestLike> {
  const globals = globalThis as NextRequestGlobals
  globals.__holoNextAuthRequestStore ??= new AsyncLocalStorage<NextRequestLike>()

  return globals.__holoNextAuthRequestStore
}

export function getCurrentNextRequest(): NextRequestLike | undefined {
  return getNextRequestStore().getStore()
}

export function runWithNextRequest<TValue>(
  request: NextRequestLike,
  callback: () => TValue,
): TValue {
  return getNextRequestStore().run(request, callback)
}
