import { runWithNextRequest as runWithSharedNextRequest, type NextRequestLike } from '@holo-js/adapter-shared/next/request-context'

export { getCurrentNextRequest, type NextRequestLike } from '@holo-js/adapter-shared/next/request-context'

type NextRequestGlobals = typeof globalThis & {
  __holoNextAuthRequestRunner?: <TValue>(callback: () => TValue) => TValue
}

export function runWithNextRequest<TValue>(
  request: NextRequestLike,
  callback: () => TValue,
): TValue {
  return runWithSharedNextRequest(request, () => {
    const runner = (globalThis as NextRequestGlobals).__holoNextAuthRequestRunner
    return runner ? runner(callback) : callback()
  })
}

export function setNextAuthRequestRunner(runner: <TValue>(callback: () => TValue) => TValue): void {
  (globalThis as NextRequestGlobals).__holoNextAuthRequestRunner = runner
}
