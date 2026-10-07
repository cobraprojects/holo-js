export type NextRequestLike = {
  readonly cookies: {
    get(name: string): { readonly value: string } | undefined
  }
  readonly headers: Headers
}

type NextRequestStore = {
  getStore(): NextRequestLike | undefined
  run<TValue>(request: NextRequestLike, callback: () => TValue): TValue
}

type AsyncLocalStorageConstructor = new <TStore>() => {
  getStore(): TStore | undefined
  run<TValue>(store: TStore, callback: () => TValue): TValue
}

type NextRequestGlobals = typeof globalThis & {
  readonly AsyncLocalStorage?: AsyncLocalStorageConstructor
  __holoNextRequestStore?: NextRequestStore
}

export function getNextRequestStore(storage?: AsyncLocalStorageConstructor): NextRequestStore {
  const globals = globalThis as NextRequestGlobals
  if (globals.__holoNextRequestStore) return globals.__holoNextRequestStore
  const NativeStorage = globals.AsyncLocalStorage ?? storage
  if (!NativeStorage) {
    throw new Error('Next request context requires native AsyncLocalStorage')
  }
  globals.__holoNextRequestStore = new NativeStorage<NextRequestLike>()
  return globals.__holoNextRequestStore
}
