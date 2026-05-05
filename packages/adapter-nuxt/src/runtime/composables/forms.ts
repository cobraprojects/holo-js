import { onScopeDispose, reactive, shallowRef, watchEffect } from 'vue'
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

type FormValuesBridge = {
  readonly values: unknown
  setValue(path: string, value: unknown): Promise<void>
}

const ARRAY_MUTATION_METHODS = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function isLeafValue(value: unknown): boolean {
  return value instanceof Date
    || value instanceof Blob
    || (!Array.isArray(value) && !isPlainObject(value))
}

function getValueAtPath(root: unknown, path: string): unknown {
  const parts = path.split('.').map(part => part.trim()).filter(Boolean)
  let cursor = root

  for (const part of parts) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) {
      return undefined
    }

    cursor = (cursor as Record<string, unknown>)[part]
  }

  return cursor
}

function createArrayMutationView(
  source: readonly unknown[],
  path: string,
  form: { value: FormValuesBridge },
  version: { value: number },
  cache: WeakMap<readonly unknown[], unknown[]>,
): unknown[] {
  const cached = cache.get(source)
  if (cached) {
    return cached
  }

  const proxy = new Proxy([] as unknown[], {
    get(_target, key) {
      void version.value
      const current = getValueAtPath(form.value.values, path)
      if (!Array.isArray(current)) {
        return undefined
      }

      const value = Reflect.get(current, key, current)
      if (typeof value !== 'function') {
        return value
      }

      if (typeof key === 'string' && ARRAY_MUTATION_METHODS.has(key)) {
        return (...args: unknown[]) => {
          const latest = getValueAtPath(form.value.values, path)
          if (!Array.isArray(latest)) {
            return undefined
          }

          const next = latest.slice()
          const result = Reflect.get(next, key, next).apply(next, args)
          void form.value.setValue(path, next)
          return result
        }
      }

      return value.bind(current)
    },
    set(_target, key, value) {
      const current = getValueAtPath(form.value.values, path)
      if (!Array.isArray(current)) {
        return false
      }

      const next = current.slice()
      const updated = Reflect.set(next, key, value)
      if (updated) {
        void form.value.setValue(path, next)
      }
      return updated
    },
    deleteProperty(_target, key) {
      const current = getValueAtPath(form.value.values, path)
      if (!Array.isArray(current)) {
        return false
      }

      const next = current.slice()
      const deleted = Reflect.deleteProperty(next, key)
      if (deleted) {
        void form.value.setValue(path, next)
      }
      return deleted
    },
  })

  cache.set(source, proxy)
  return proxy
}

function defineLeafAccessor(
  target: Record<string, unknown>,
  key: string,
  path: string,
  form: { value: FormValuesBridge },
  version: { value: number },
  arrayCache: WeakMap<readonly unknown[], unknown[]>,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor?.get && descriptor?.set) {
    return
  }

  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      void version.value
      const value = getValueAtPath(form.value.values, path)
      return Array.isArray(value)
        ? createArrayMutationView(value, path, form, version, arrayCache)
        : value
    },
    set(nextValue: unknown) {
      void form.value.setValue(path, nextValue)
    },
  })
}

function syncValuesView(
  target: Record<string, unknown>,
  source: unknown,
  form: { value: FormValuesBridge },
  version: { value: number },
  arrayCache: WeakMap<readonly unknown[], unknown[]>,
  prefix = '',
): void {
  if (!isPlainObject(source)) {
    for (const key of Object.keys(target)) {
      delete target[key]
    }

    return
  }

  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }

  for (const [key, item] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key
    const current = target[key]

    if (Array.isArray(item)) {
      if (isPlainObject(current)) {
        delete target[key]
      }

      defineLeafAccessor(target, key, path, form, version, arrayCache)
      continue
    }

    if (isLeafValue(item)) {
      if (isPlainObject(current)) {
        delete target[key]
      }

      defineLeafAccessor(target, key, path, form, version, arrayCache)
      continue
    }

    if (!isPlainObject(current)) {
      target[key] = {}
    }

    syncValuesView(target[key] as Record<string, unknown>, item, form, version, arrayCache, path)
  }
}

export function useForm<TSchema extends FormSchema, TSuccess = unknown>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferFormData<TSchema>, TSuccess> = {},
): UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>> {
  const form = shallowRef(createForm(schemaDefinition, options))
  const version = shallowRef(0)
  let versionCounter = 0
  const rawValues: Record<string, unknown> = {}
  const values = reactive(rawValues) as InferFormData<TSchema>
  const arrayCache = new WeakMap<readonly unknown[], unknown[]>()

  const syncValuesFromForm = () => {
    syncValuesView(
      rawValues,
      form.value.values,
      form as { value: FormValuesBridge },
      version,
      arrayCache,
    )
  }

  const stopWatching = watchEffect((onCleanup) => {
    form.value = createForm(schemaDefinition, options)
    syncValuesFromForm()
    version.value = ++versionCounter

    const unsubscribe = form.value.subscribe(() => {
      syncValuesFromForm()
      version.value = ++versionCounter
    })

    onCleanup(unsubscribe)
  })

  onScopeDispose(stopWatching)

  return reactive({
    get fields() {
      void version.value
      return form.value.fields
    },
    values,
    get errors() {
      void version.value
      return form.value.errors
    },
    get submitting() {
      void version.value
      return form.value.submitting
    },
    get valid() {
      void version.value
      return form.value.valid
    },
    get lastSubmission() {
      void version.value
      return form.value.lastSubmission
    },
    subscribe(listener: () => void) {
      return form.value.subscribe(listener)
    },
    async validate() {
      return await form.value.validate()
    },
    async validateField(path: string) {
      return await form.value.validateField(path)
    },
    async submit() {
      return await form.value.submit()
    },
    reset(nextValues?: Partial<InferFormData<TSchema>>) {
      form.value.reset(nextValues)
    },
    async setValue(path: string, value: unknown) {
      await form.value.setValue(path, value)
    },
    applyServerState(result: ReturnType<UseFormResult<InferFormData<TSchema>, TSuccess>['applyServerState']>) {
      return form.value.applyServerState(result)
    },
  }) as UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>>
}
