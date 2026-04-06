import { onScopeDispose, shallowRef, watchEffect } from 'vue'
import type { FormSchema } from '@holo-js/forms'
import {
  type UseFormOptions,
  type UseFormResult,
  useForm as createForm,
} from '@holo-js/forms/client'
import type { InferSchemaData, SchemaInputShape } from '@holo-js/validation'

export {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/client'

type VersionRef = {
  value: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function createReactiveView<TValue extends object>(
  targetRef: { value: TValue },
  version: VersionRef,
  cache: WeakMap<object, object>,
): TValue {
  const target = targetRef.value
  const cached = cache.get(target)

  if (cached) {
    return cached as TValue
  }

  const proxy = new Proxy({}, {
    get(_shell, key) {
      void version.value
      const currentTarget = targetRef.value
      const value = Reflect.get(currentTarget as object, key)

      if (typeof value === 'function') {
        return value.bind(currentTarget)
      }

      if (isPlainObject(value)) {
        return createReactiveView({ value: value as object }, version, cache)
      }

      return value
    },
    set(_shell, key, value) {
      const updated = Reflect.set(targetRef.value as object, key, value)
      version.value += 1
      return updated
    },
    ownKeys() {
      void version.value
      return Reflect.ownKeys(targetRef.value as object)
    },
    getOwnPropertyDescriptor(_shell, key) {
      void version.value
      const descriptor = Reflect.getOwnPropertyDescriptor(targetRef.value as object, key)

      if (!descriptor) {
        return undefined
      }

      return {
        ...descriptor,
        configurable: true,
      }
    },
    has(_shell, key) {
      void version.value
      return Reflect.has(targetRef.value as object, key)
    },
  })

  cache.set(target, proxy)
  return proxy as TValue
}

export function useForm<TSchema extends FormSchema<SchemaInputShape>>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferSchemaData<TSchema['fields']>> = {},
): UseFormResult<InferSchemaData<TSchema['fields']>> {
  const form = shallowRef(createForm(schemaDefinition, options))
  const version = shallowRef(0)
  const cache = new WeakMap<object, object>()
  const stopWatching = watchEffect((onCleanup) => {
    form.value = createForm(schemaDefinition, options)
    version.value += 1

    const unsubscribe = form.value.subscribe(() => {
      version.value += 1
    })

    onCleanup(unsubscribe)
  })

  onScopeDispose(stopWatching)

  return createReactiveView(form, version, cache)
}
