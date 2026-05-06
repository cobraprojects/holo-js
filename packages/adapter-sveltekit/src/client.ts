import { getContext, setContext } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'
import { refreshUser as refreshCurrentUser } from '@holo-js/auth/client'
import type { AuthClientRequestOptions, HoloAuthUser } from '@holo-js/auth/client'
import type { FormSchema, InferFormData } from '@holo-js/forms'
import {
  type InferFormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  useForm as createForm,
} from '@holo-js/forms/client'

export {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/client'
export type { HoloAuthUser } from '@holo-js/auth/client'

export type UseAuthOptions = AuthClientRequestOptions & {
  readonly initialUser?: HoloAuthUser | null
}

export type UseAuthResult = {
  readonly authenticated: boolean
  readonly user: HoloAuthUser | null
  readonly refreshUser: () => Promise<HoloAuthUser | null>
}

const authContextKey = Symbol('holo-js.auth.client')

export function setAuthContext(auth: UseAuthResult): UseAuthResult {
  setContext(authContextKey, auth)
  return auth
}

export function getAuthContext(): UseAuthResult | undefined {
  return getContext<UseAuthResult | undefined>(authContextKey)
}

function tryGetAuthContext(): UseAuthResult | undefined {
  try {
    return getAuthContext()
  } catch {
    return undefined
  }
}

function trySetAuthContext(auth: UseAuthResult): void {
  try {
    setAuthContext(auth)
  } catch {
    // Outside component initialization there is no Svelte context to attach.
  }
}

class AuthClientState implements UseAuthResult {
  #notify: () => void = () => {}
  #user: HoloAuthUser | null

  readonly #subscribe = createSubscriber((update) => {
    this.#notify = update

    return () => {
      this.#notify = () => {}
    }
  })

  constructor(
    initialUser: HoloAuthUser | null,
    private readonly requestOptions: AuthClientRequestOptions,
  ) {
    this.#user = initialUser
  }

  get authenticated(): boolean {
    this.#subscribe()
    return this.#user !== null
  }

  get user(): HoloAuthUser | null {
    this.#subscribe()
    return this.#user
  }

  async refreshUser(): Promise<HoloAuthUser | null> {
    this.#user = await refreshCurrentUser(this.requestOptions)
    this.#notify()

    return this.#user
  }
}

export function useAuth(options?: UseAuthOptions): UseAuthResult {
  const context = tryGetAuthContext()
  if (!options && context) {
    return context
  }

  const resolvedOptions = options ?? {}
  const { initialUser = null, ...requestOptions } = resolvedOptions
  const auth = new AuthClientState(initialUser, requestOptions)

  trySetAuthContext(auth)
  return auth
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function createReactiveView<TValue extends object>(
  target: TValue,
  subscribe: () => void,
  cache: WeakMap<object, object>,
): TValue {
  const cached = cache.get(target)

  if (cached) {
    return cached as TValue
  }

  const proxy = new Proxy({}, {
    get(_shell, key) {
      subscribe()
      const value = Reflect.get(target as object, key)

      if (typeof value === 'function') {
        return value.bind(target)
      }

      if (isPlainObject(value)) {
        return createReactiveView(value as object, subscribe, cache)
      }

      return value
    },
    set(_shell, key, value) {
      return Reflect.set(target as object, key, value)
    },
    ownKeys() {
      subscribe()
      return Reflect.ownKeys(target as object)
    },
    getOwnPropertyDescriptor(_shell, key) {
      subscribe()
      const descriptor = Reflect.getOwnPropertyDescriptor(target as object, key)

      if (!descriptor) {
        return undefined
      }

      return {
        ...descriptor,
        configurable: true,
      }
    },
    has(_shell, key) {
      subscribe()
      return Reflect.has(target as object, key)
    },
  })

  cache.set(target, proxy)
  return proxy as TValue
}

export function useForm<TSchema extends FormSchema, TSuccess = unknown>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferFormData<TSchema>, TSuccess> = {},
): UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>> {
  type TData = InferFormData<TSchema>

  const form = createForm(schemaDefinition, options)
  const subscribe = createSubscriber((update) => form.subscribe(update))
  const cache = new WeakMap<object, object>()

  return createReactiveView<UseFormResult<TData, TSuccess, InferFormFieldTree<TSchema>>>(form, subscribe, cache)
}
