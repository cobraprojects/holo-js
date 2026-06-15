import { onScopeDispose, reactive, shallowRef, watchEffect } from 'vue'
import { useCookie } from '#app'
import { normalizeHoloHttpError } from '@holo-js/core/errors'
import type { FormSchema, InferFormData } from '@holo-js/forms'
import { DEFAULT_VALIDATION_BAG, createErrorBag, type ValidationErrorBag } from '@holo-js/validation'
import {
  type InferFormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  createFormClient,
} from '@holo-js/forms/internal/client'
import { renderNuxtClientHttpErrorPage } from './client-errors'
import { isPlainObject } from './object'

export {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/internal/client'

type FormValuesBridge = {
  readonly values: unknown
  setValue(path: string, value: unknown): Promise<void>
}

type FormValuesGetter = () => FormValuesBridge
type FlashedValidationPayload = {
  readonly bag?: string
  readonly errors?: Record<string, readonly string[]>
}
type NuxtCookieValue = string | FlashedValidationPayload | null
type FormHttpFailure = {
  readonly ok: false
  readonly status: number
  readonly errors?: Record<string, readonly string[]>
}

const FORM_FAILURE_COOKIE = 'holo_form_failure'

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

function isLeafValue(value: unknown): boolean {
  return value instanceof Date
    || value instanceof Blob
    || (!Array.isArray(value) && !isPlainObject(value))
}

function readBrowserCookie(name: string): string | undefined {
  const cookie = (globalThis as { readonly document?: { readonly cookie?: string } }).document?.cookie
  if (!cookie) {
    return undefined
  }

  for (const segment of cookie.split(';')) {
    const trimmed = segment.trim()
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      continue
    }

    if (trimmed.slice(0, separator) === name) {
      return trimmed.slice(separator + 1)
    }
  }

  return undefined
}

function readCookie(name: string): NuxtCookieValue | undefined {
  try {
    const cookie = useCookie<NuxtCookieValue>(name)
    if (typeof cookie.value === 'string' || isPlainObject(cookie.value)) {
      return cookie.value
    }
  } catch {
    return readBrowserCookie(name)
  }

  return readBrowserCookie(name)
}

function parseFlashedValidationPayload(): FlashedValidationPayload | undefined {
  const value = readCookie(FORM_FAILURE_COOKIE)
  if (!value) {
    return undefined
  }

  try {
    const decoded = typeof value === 'string'
      ? JSON.parse(decodeURIComponent(value)) as unknown
      : value
    if (!isPlainObject(decoded) || !isPlainObject(decoded.errors)) {
      return undefined
    }

    return {
      bag: typeof decoded.bag === 'string' ? decoded.bag : DEFAULT_VALIDATION_BAG,
      errors: decoded.errors as Record<string, readonly string[]>,
    }
  } catch {
    return undefined
  }
}

function getHttpFailureMessage(result: FormHttpFailure): string | undefined {
  return result.errors?._root?.[0]
}

function renderFormHttpFailure(result: unknown): void {
  if (!isPlainObject(result)) {
    return
  }

  const httpError = result.ok === false && typeof result.status === 'number'
    ? normalizeHoloHttpError({
        status: result.status,
        message: getHttpFailureMessage(result as FormHttpFailure),
      })
    : normalizeHoloHttpError(result)

  if (!httpError || httpError.status === 422) {
    return
  }

  renderNuxtClientHttpErrorPage(httpError)
}

function createHttpHandledFormOptions<TData, TSuccess>(
  options: UseFormOptions<TData, TSuccess>,
): UseFormOptions<TData, TSuccess> {
  const submitter = options.submitter
  if (!submitter) {
    return options
  }

  return {
    ...options,
    async submitter(context) {
      try {
        const result = await submitter(context)
        renderFormHttpFailure(result)
        return result
      } catch (error) {
        renderFormHttpFailure(error)
        throw error
      }
    },
  }
}

export function useValidationErrors<TData = Record<string, unknown>>(
  bag = DEFAULT_VALIDATION_BAG,
): ValidationErrorBag<TData> {
  const payload = parseFlashedValidationPayload()
  if (!payload || (payload.bag ?? DEFAULT_VALIDATION_BAG) !== bag) {
    return createErrorBag<TData>()
  }

  return createErrorBag<TData>(payload.errors ?? {})
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
  getForm: FormValuesGetter,
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
      const current = getValueAtPath(getForm().values, path)
      if (!Array.isArray(current)) {
        return undefined
      }

      const value = Reflect.get(current, key, current)
      if (typeof value !== 'function') {
        return value
      }

      if (typeof key === 'string' && ARRAY_MUTATION_METHODS.has(key)) {
        return (...args: unknown[]) => {
          const latest = getValueAtPath(getForm().values, path)
          if (!Array.isArray(latest)) {
            return undefined
          }

          const next = latest.slice()
          const result = Reflect.get(next, key, next).apply(next, args)
          void getForm().setValue(path, next)
          return result
        }
      }

      return value.bind(current)
    },
    set(_target, key, value) {
      const current = getValueAtPath(getForm().values, path)
      if (!Array.isArray(current)) {
        return false
      }

      const next = current.slice()
      const updated = Reflect.set(next, key, value)
      if (updated) {
        void getForm().setValue(path, next)
      }
      return updated
    },
    deleteProperty(_target, key) {
      const current = getValueAtPath(getForm().values, path)
      if (!Array.isArray(current)) {
        return false
      }

      const next = current.slice()
      const deleted = Reflect.deleteProperty(next, key)
      if (deleted) {
        void getForm().setValue(path, next)
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
  getForm: FormValuesGetter,
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
      const value = getValueAtPath(getForm().values, path)
      return Array.isArray(value)
        ? createArrayMutationView(value, path, getForm, version, arrayCache)
        : value
    },
    set(nextValue: unknown) {
      void getForm().setValue(path, nextValue)
    },
  })
}

function syncValuesView(
  target: Record<string, unknown>,
  source: unknown,
  getForm: FormValuesGetter,
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

      defineLeafAccessor(target, key, path, getForm, version, arrayCache)
      continue
    }

    if (isLeafValue(item)) {
      if (isPlainObject(current)) {
        delete target[key]
      }

      defineLeafAccessor(target, key, path, getForm, version, arrayCache)
      continue
    }

    if (!isPlainObject(current)) {
      target[key] = {}
    }

    syncValuesView(target[key] as Record<string, unknown>, item, getForm, version, arrayCache, path)
  }
}

export function useForm<TSchema extends FormSchema, TSuccess = unknown>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferFormData<TSchema>, TSuccess> = {},
): UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>> {
  const form = shallowRef<UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>> | undefined>(undefined)
  const version = shallowRef(0)
  let versionCounter = 0
  const rawValues: Record<string, unknown> = {}
  const values = reactive(rawValues) as InferFormData<TSchema>
  const arrayCache = new WeakMap<readonly unknown[], unknown[]>()
  let activeForm: FormValuesBridge | undefined

  const getActiveForm = () => {
    if (!activeForm) {
      throw new TypeError('Expected form to be initialized.')
    }

    return activeForm
  }

  const currentForm = () => {
    const current = form.value
    if (!current) {
      throw new TypeError('Expected form to be initialized.')
    }

    return current
  }

  const syncValuesFromForm = (localForm: UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>>) => {
    activeForm = localForm
    syncValuesView(
      rawValues,
      localForm.values,
      getActiveForm,
      version,
      arrayCache,
    )
  }

  const stopWatching = watchEffect((onCleanup) => {
    const localForm = createFormClient(schemaDefinition, createHttpHandledFormOptions(options))
    syncValuesFromForm(localForm)
    form.value = localForm
    version.value = ++versionCounter

    const unsubscribe = localForm.subscribe(() => {
      syncValuesFromForm(localForm)
      version.value = ++versionCounter
    })

    onCleanup(unsubscribe)
  })

  onScopeDispose(stopWatching)

  return reactive({
    get fields() {
      void version.value
      return currentForm().fields
    },
    values,
    get errors() {
      void version.value
      return currentForm().errors
    },
    get submitting() {
      void version.value
      return currentForm().submitting
    },
    get valid() {
      void version.value
      return currentForm().valid
    },
    get lastSubmission() {
      void version.value
      return currentForm().lastSubmission
    },
    subscribe(listener: () => void) {
      return currentForm().subscribe(listener)
    },
    async validate() {
      return await currentForm().validate()
    },
    async validateField(path: string) {
      return await currentForm().validateField(path)
    },
    async submit() {
      const result = await currentForm().submit()
      renderFormHttpFailure(result)
      return result
    },
    reset(nextValues?: Partial<InferFormData<TSchema>>) {
      currentForm().reset(nextValues)
    },
    async setValue(path: string, value: unknown) {
      await currentForm().setValue(path, value)
    },
    applyServerState(result: ReturnType<UseFormResult<InferFormData<TSchema>, TSuccess>['applyServerState']>) {
      return currentForm().applyServerState(result)
    },
  }) as UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>>
}
