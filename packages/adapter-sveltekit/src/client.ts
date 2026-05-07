import { createSubscriber } from 'svelte/reactivity'
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
