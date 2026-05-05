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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function isLeafValue(value: unknown): boolean {
  return Array.isArray(value)
    || value instanceof Date
    || value instanceof Blob
    || !isPlainObject(value)
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

function defineLeafAccessor(
  target: Record<string, unknown>,
  key: string,
  path: string,
  form: { value: FormValuesBridge },
  version: { value: number },
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
      return getValueAtPath(form.value.values, path)
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

    if (isLeafValue(item)) {
      if (isPlainObject(current)) {
        delete target[key]
      }

      defineLeafAccessor(target, key, path, form, version)
      continue
    }

    if (!isPlainObject(current)) {
      target[key] = {}
    }

    syncValuesView(target[key] as Record<string, unknown>, item, form, version, path)
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

  const syncValuesFromForm = () => {
    syncValuesView(
      rawValues,
      form.value.values,
      form as { value: FormValuesBridge },
      version,
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
