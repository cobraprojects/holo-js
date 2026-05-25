import { createSubscriber } from 'svelte/reactivity'
import type { FormSchema, InferFormData } from '@holo-js/forms'
import {
  type InferFormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  createFormClient,
} from '@holo-js/forms/internal/client'

type InitialFormState<TData> = UseFormOptions<TData>['initialState']

export {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/internal/client'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function isSchemaField(value: unknown): boolean {
  return isPlainObject(value)
    && value.kind === 'field'
    && isPlainObject(value.definition)
}

function collectSchemaPaths(value: unknown, prefix = ''): readonly string[] {
  if (isSchemaField(value)) {
    return [prefix].filter(Boolean)
  }

  if (!isPlainObject(value)) {
    return []
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return collectSchemaPaths(nested, next)
  })
}

function collectValuePaths(value: unknown, prefix = ''): readonly string[] {
  if (!isPlainObject(value)) {
    return [prefix].filter(Boolean)
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return collectValuePaths(nested, next)
  })
}

function isFormState<TData>(value: unknown): value is NonNullable<InitialFormState<TData>> {
  return isPlainObject(value)
    && typeof value.valid === 'boolean'
    && isPlainObject(value.values)
    && isPlainObject(value.errors)
}

function stateMatchesSchema<TData>(schemaDefinition: FormSchema, state: NonNullable<InitialFormState<TData>>): boolean {
  const schemaPaths = collectSchemaPaths(schemaDefinition.fields)
  const statePaths = [
    ...Object.keys(state.errors),
    ...collectValuePaths(state.values),
  ]

  return statePaths.every(path => path === '_root' || schemaPaths.includes(path))
}

async function hydrateActionFormState<TData, TSuccess>(
  form: Pick<UseFormResult<TData, TSuccess>, 'applyServerState'>,
  schemaDefinition: FormSchema,
): Promise<void> {
  if (typeof (globalThis as { readonly window?: unknown }).window === 'undefined') {
    return
  }

  const stores = await import('$app/stores') as {
    readonly page: {
      subscribe(listener: (value: { readonly form: unknown }) => void): () => void
    }
  }
  let unsubscribe = () => {}
  unsubscribe = stores.page.subscribe((value) => {
    const state = value.form
    if (isFormState<TData>(state) && stateMatchesSchema(schemaDefinition, state)) {
      form.applyServerState(state)
    }

    queueMicrotask(unsubscribe)
  })
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
  const formOptions: UseFormOptions<TData, TSuccess> = {
    ...options,
    initialState: options.initialState ?? undefined,
  }

  const form = createFormClient(schemaDefinition, formOptions)
  void hydrateActionFormState(form, schemaDefinition)
  const subscribe = createSubscriber((update) => form.subscribe(update))
  const cache = new WeakMap<object, object>()

  return createReactiveView<UseFormResult<TData, TSuccess, InferFormFieldTree<TSchema>>>(form, subscribe, cache)
}
