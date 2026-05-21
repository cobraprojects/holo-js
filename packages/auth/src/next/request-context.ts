export type NextAuthRequestLike = {
  readonly cookies: {
    get(name: string): { readonly value: string } | undefined
  }
  readonly headers: Headers
}

type NextAuthRequestStore = {
  getStore(): NextAuthRequestLike | undefined
  run<TValue>(request: NextAuthRequestLike, callback: () => TValue): TValue
}

type AsyncLocalStorageConstructor = new <TStore>() => {
  getStore(): TStore | undefined
  run<TValue>(store: TStore, callback: () => TValue): TValue
}

type NextAuthRequestGlobals = typeof globalThis & {
  readonly AsyncLocalStorage?: AsyncLocalStorageConstructor
  __holoNextAuthRequestStore?: NextAuthRequestStore
}

function hasFinally(value: unknown): value is { finally(onFinally: () => void): unknown } {
  return typeof value === 'object'
    && value !== null
    && 'finally' in value
    && typeof value.finally === 'function'
}

function createFallbackRequestStore(): NextAuthRequestStore {
  let currentRequest: NextAuthRequestLike | undefined

  return {
    getStore() {
      return currentRequest
    },
    run(request, callback) {
      const previousRequest = currentRequest
      currentRequest = request

      try {
        const result = callback()
        if (hasFinally(result)) {
          return result.finally(() => {
            currentRequest = previousRequest
          }) as typeof result
        }

        currentRequest = previousRequest
        return result
      } catch (error) {
        currentRequest = previousRequest
        throw error
      }
    },
  }
}

function createNextAuthRequestStore(): NextAuthRequestStore {
  const globals = globalThis as NextAuthRequestGlobals
  return globals.AsyncLocalStorage
    ? new globals.AsyncLocalStorage<NextAuthRequestLike>()
    : createFallbackRequestStore()
}

function getNextAuthRequestStore(): NextAuthRequestStore {
  const globals = globalThis as NextAuthRequestGlobals
  globals.__holoNextAuthRequestStore ??= createNextAuthRequestStore()

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
