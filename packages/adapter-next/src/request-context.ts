import { AsyncLocalStorage } from 'node:async_hooks'

export type NextRequestLike = {
  readonly cookies: {
    get(name: string): { readonly value: string } | undefined
  }
  readonly headers: Headers
}

const nextRequestStore = new AsyncLocalStorage<NextRequestLike>()

export function getCurrentNextRequest(): NextRequestLike | undefined {
  return nextRequestStore.getStore()
}

export function runWithNextRequest<TValue>(
  request: NextRequestLike,
  callback: () => TValue,
): TValue {
  return nextRequestStore.run(request, callback)
}
