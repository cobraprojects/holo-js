import { getNextRequestStore, type NextRequestLike } from './request-store'

export { type NextRequestLike } from './request-store'

export function getCurrentNextRequest(): NextRequestLike | undefined {
  return getNextRequestStore().getStore()
}

export function runWithNextRequest<TValue>(request: NextRequestLike, callback: () => TValue): TValue {
  return getNextRequestStore().run(request, callback)
}
