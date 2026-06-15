type ReactiveViewOptions = {
  readonly bindFunctions?: boolean
  readonly preserveArrayLengthDescriptor?: boolean
  readonly shouldWrapValue: (value: unknown) => value is object
}

export function createReactiveView<TValue extends object>(
  target: TValue,
  subscribe: () => void,
  cache: WeakMap<object, object>,
  options: ReactiveViewOptions,
): TValue {
  const cached = cache.get(target)
  if (cached) {
    return cached as TValue
  }

  const proxy = new Proxy(Array.isArray(target) ? [] : {}, {
    get(_shell, key) {
      subscribe()
      const value = Reflect.get(target, key, target)

      if (options.bindFunctions && typeof value === 'function') {
        return value.bind(target)
      }

      if (options.shouldWrapValue(value)) {
        return createReactiveView(value, subscribe, cache, options)
      }

      return value
    },
    set(_shell, key, value) {
      return Reflect.set(target, key, value)
    },
    ownKeys() {
      subscribe()
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(_shell, key) {
      subscribe()
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)

      if (!descriptor) {
        return undefined
      }

      if (options.preserveArrayLengthDescriptor && Array.isArray(target) && key === 'length') {
        return descriptor
      }

      return {
        ...descriptor,
        configurable: true,
      }
    },
    has(_shell, key) {
      subscribe()
      return Reflect.has(target, key)
    },
  })

  cache.set(target, proxy)
  return proxy as TValue
}
