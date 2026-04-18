import {
  type FormFailurePayload,
  type FormSchema,
  type FormSubmissionResult,
  type FormSuccessPayload,
  type SerializedFormSubmission as SerializedSubmissionState,
  type SerializedFormSubmission,
  createFailedSubmission,
  createSuccessfulSubmission,
  validate,
} from './contracts'
import { createErrorBag, type InferSchemaData, type SchemaInputShape, type ValidationErrorBag, type WebFileLike } from '@holo-js/validation'
import { getClientCsrfField } from './client-security'

type PrimitiveLike = string | number | boolean | bigint | symbol | null | undefined | Date | Blob | WebFileLike

export type ValidateOnMode = 'submit' | 'blur' | 'change'

export interface ClientSubmitContext<TData> {
  readonly action?: string
  readonly method: string
  readonly values: TData
  readonly formData: FormData
}

export type ClientSubmitResult<TData>
  = FormSubmissionResult<TData>
  | SerializedFormSubmission<TData>
  | FormFailurePayload<TData>
  | FormSuccessPayload<unknown>

export interface UseFormOptions<TData> {
  readonly action?: string
  readonly method?: string
  readonly csrf?: boolean
  readonly validateOn?: ValidateOnMode
  readonly initialValues?: Partial<TData>
  readonly initialState?: SerializedFormSubmission<TData>
  readonly submitter?: (context: ClientSubmitContext<TData>) => Promise<ClientSubmitResult<TData>> | ClientSubmitResult<TData>
}

export interface FormFieldState<TValue> {
  value: TValue
  readonly errors: readonly string[]
  readonly touched: boolean
  readonly dirty: boolean
  set(value: TValue): Promise<void>
  onInput(value: TValue): Promise<void>
  onBlur(): Promise<void>
  validate(): Promise<readonly string[]>
}

export type FormFieldTree<TData> = TData extends readonly unknown[]
  ? FormFieldState<TData>
  : TData extends PrimitiveLike
    ? FormFieldState<TData>
    : TData extends Record<string, unknown>
      ? { readonly [K in keyof TData]: FormFieldTree<TData[K]> }
      : FormFieldState<TData>

export interface UseFormResult<TData> {
  readonly fields: FormFieldTree<TData>
  readonly values: TData
  readonly errors: ValidationErrorBag<TData>
  readonly submitting: boolean
  readonly valid: boolean
  readonly lastSubmission?: SerializedFormSubmission<TData> | FormSuccessPayload<unknown>
  subscribe(listener: () => void): () => void
  validate(): Promise<FormSubmissionResult<TData>>
  validateField(path: string): Promise<readonly string[]>
  submit(): Promise<ClientSubmitResult<TData>>
  reset(values?: Partial<TData>): void
  setValue(path: string, value: unknown): Promise<void>
  applyServerState(result: ClientSubmitResult<TData>): ClientSubmitResult<TData>
}

type MutableState<TData> = {
  values: TData
  initialValues: TData
  flattenedErrors: Record<string, readonly string[]>
  touched: Set<string>
  dirty: Set<string>
  submitting: boolean
  lastSubmission?: SerializedFormSubmission<TData> | FormSuccessPayload<unknown>
  listeners: Set<() => void>
}

type SchemaFieldLike = {
  readonly kind: 'field'
  readonly definition: object
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function isSchemaFieldLike(value: unknown): value is SchemaFieldLike {
  return !!value
    && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'field'
    && !!(value as { definition?: unknown }).definition
    && typeof (value as { definition?: unknown }).definition === 'object'
}

function areEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }

  if (left instanceof Blob || right instanceof Blob) {
    return false
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => areEqual(value, right[index]))
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)

    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => key in right && areEqual(left[key], right[key]))
  }

  return false
}

function cloneValue<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return value.map(item => cloneValue(item)) as TValue
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as TValue
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    ) as TValue
  }

  return value
}

function isLeafValue(value: unknown): boolean {
  return Array.isArray(value)
    || value instanceof Date
    || value instanceof Blob
    || isSchemaFieldLike(value)
    || !isPlainObject(value)
}

function normalizeObject<TData>(value: Partial<TData> | TData | undefined): TData {
  return (isPlainObject(value) ? cloneValue(value) : {}) as TData
}

function mergeValues<TData>(base: TData, override: Partial<TData> | undefined): TData {
  if (!override || !isPlainObject(override)) {
    return cloneValue(base)
  }

  const output = cloneValue(base) as Record<string, unknown>
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = mergeValues(output[key] as Record<string, unknown>, value)
      continue
    }

    output[key] = cloneValue(value)
  }

  return output as TData
}

function splitPath(path: string): readonly string[] {
  return path.split('.').map(part => part.trim()).filter(Boolean)
}

function getValueAtPath(root: unknown, path: string): unknown {
  let cursor = root
  for (const part of splitPath(path)) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) {
      return undefined
    }

    cursor = (cursor as Record<string, unknown>)[part]
  }

  return cursor
}

function setValueAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = splitPath(path)
  let cursor: Record<string, unknown> | unknown[] = root

  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1
    const nextPart = parts[index + 1]!

    if (Array.isArray(cursor)) {
      const offset = Number(part)
      if (!Number.isInteger(offset) || offset < 0) {
        return
      }

      if (last) {
        cursor[offset] = value
        return
      }

      const existing = cursor[offset]
      if (!isPlainObject(existing) && !Array.isArray(existing)) {
        cursor[offset] = /^\d+$/.test(nextPart) ? [] : {}
      }

      cursor = cursor[offset] as Record<string, unknown> | unknown[]
      continue
    }

    if (last) {
      cursor[part] = value
      return
    }

    const existing = cursor[part]
    if (!isPlainObject(existing) && !Array.isArray(existing)) {
      cursor[part] = /^\d+$/.test(nextPart) ? [] : {}
    }

    cursor = cursor[part] as Record<string, unknown> | unknown[]
  }
}

function flattenLeafPaths(value: unknown, prefix = ''): readonly string[] {
  if (isLeafValue(value)) {
    return [prefix].filter(Boolean)
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return flattenLeafPaths(nested, next)
  })
}

function buildFormData(value: unknown, path = '', formData: FormData = new FormData()): FormData {
  if (typeof value === 'undefined') {
    return formData
  }

  if (value instanceof Date) {
    formData.append(path, value.toISOString())
    return formData
  }

  if (value instanceof Blob) {
    formData.append(path, value)
    return formData
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      buildFormData(item, `${path}[]`, formData)
    }
    return formData
  }

  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key
      buildFormData(nested, next, formData)
    }
    return formData
  }

  formData.append(path, String(value))
  return formData
}

function createTypedErrorBag<TData>(flattenedErrors: Record<string, readonly string[]>): ValidationErrorBag<TData> {
  return createErrorBag<TData>(flattenedErrors)
}

function notifyListeners<TData>(state: MutableState<TData>): void {
  for (const listener of state.listeners) {
    listener()
  }
}

function collectErrorsForPath(
  flattenedErrors: Record<string, readonly string[]>,
  path: string,
): readonly string[] {
  const direct = flattenedErrors[path] ?? []
  const prefix = `${path}.`
  const nested = Object.entries(flattenedErrors)
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([, messages]) => messages)

  return direct.length > 0 || nested.length > 0
    ? [...direct, ...nested]
    : []
}

function buildFieldsTree<TData>(
  state: MutableState<TData>,
  schemaDefinition: FormSchema<SchemaInputShape>,
  source: unknown,
  validateOn: ValidateOnMode,
  prefix = '',
): FormFieldTree<TData> {
  if (isLeafValue(source)) {
    const path = prefix
    return Object.freeze({
      get value() {
        return getValueAtPath(state.values, path) as TData
      },
      set value(next: TData) {
        void (this as FormFieldState<TData>).set(next)
      },
      get errors() {
        return collectErrorsForPath(state.flattenedErrors, path)
      },
      get touched() {
        return state.touched.has(path)
      },
      get dirty() {
        return state.dirty.has(path)
      },
      async set(value: TData) {
        setValueAtPath(state.values as Record<string, unknown>, path, value)
        state.touched.add(path)
        if (!areEqual(getValueAtPath(state.initialValues, path), value)) {
          state.dirty.add(path)
        } else {
          state.dirty.delete(path)
        }

        if (validateOn === 'change') {
          const submission = await validate(state.values as unknown as Record<string, unknown>, schemaDefinition as never) as FormSubmissionResult<TData>
          state.flattenedErrors = submission.errors.flatten()
          state.lastSubmission = submission.serialize() as SerializedFormSubmission<TData>
        }

        notifyListeners(state)
      },
      async onInput(value: TData) {
        await (this as FormFieldState<TData>).set(value)
      },
      async onBlur() {
        state.touched.add(path)
        if (validateOn === 'blur') {
          const submission = await validate(state.values as unknown as Record<string, unknown>, schemaDefinition as never) as FormSubmissionResult<TData>
          state.flattenedErrors = submission.errors.flatten()
          state.lastSubmission = submission.serialize() as SerializedFormSubmission<TData>
        }

        notifyListeners(state)
      },
      async validate() {
        const submission = await validate(state.values as unknown as Record<string, unknown>, schemaDefinition as never)
        state.flattenedErrors = submission.errors.flatten()
        notifyListeners(state)
        return state.flattenedErrors[path] ?? []
      },
    }) as unknown as FormFieldTree<TData>
  }

  const entries = Object.entries(source as Record<string, unknown>).map(([key, value]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return [key, buildFieldsTree(state, schemaDefinition, value, validateOn, next)]
  })

  return Object.freeze(Object.fromEntries(entries)) as FormFieldTree<TData>
}

function isSubmissionResult<TData>(value: ClientSubmitResult<TData>): value is FormSubmissionResult<TData> {
  return 'valid' in value
    && 'errors' in value
    && 'values' in value
    && !!value.errors
    && typeof value.errors === 'object'
    && 'flatten' in value.errors
    && typeof value.errors.flatten === 'function'
}

function isSerializedSubmission<TData>(value: ClientSubmitResult<TData>): value is SerializedSubmissionState<TData> {
  return 'submitted' in value && 'errors' in value && 'values' in value && !('ok' in value)
}

function normalizeSubmissionLike<TData>(
  schemaDefinition: FormSchema<SchemaInputShape>,
  values: TData,
  result: ClientSubmitResult<TData>,
): ClientSubmitResult<TData> {
  if (isSubmissionResult(result)) {
    return result
  }

  if ('ok' in result && result.ok === false && 'errors' in result && 'values' in result) {
    return {
      ...result,
      submitted: true,
    }
  }

  if (isSerializedSubmission(result)) {
    if (result.valid) {
      return createSuccessfulSubmission(schemaDefinition as never, result.values as never) as FormSubmissionResult<TData>
    }

    return createFailedSubmission(schemaDefinition as never, result.values as never, result.errors) as FormSubmissionResult<TData>
  }

  if ('ok' in result && result.ok === true) {
    return result
  }

  return createSuccessfulSubmission(schemaDefinition as never, values as never) as FormSubmissionResult<TData>
}

function appendQueryString(action: string, formData: FormData): string {
  const [rawPath = '', hash = ''] = action.split('#', 2)
  const [pathname = '', search = ''] = rawPath.split('?', 2)
  const params = new URLSearchParams(search)

  for (const [key, value] of formData.entries()) {
    params.append(key, typeof value === 'string' ? value : value.name)
  }

  const query = params.toString()
  const suffix = hash ? `#${hash}` : ''
  return query ? `${pathname}?${query}${suffix}` : `${pathname}${suffix}`
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers?.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return contentType === 'application/json' || contentType?.endsWith('+json') === true
}

async function normalizeFetchResponse<TData>(
  response: Response,
  fallbackValues: Partial<TData> | TData,
): Promise<ClientSubmitResult<TData>> {
  if (response.status === 204 || response.status === 205) {
    return {
      ok: true,
      status: response.status,
      data: undefined,
    }
  }

  if (isJsonResponse(response)) {
    return await response.json() as ClientSubmitResult<TData>
  }

  if (response.ok) {
    return {
      ok: true,
      status: response.status,
      data: undefined,
    }
  }

  try {
    return await response.json() as ClientSubmitResult<TData>
  } catch {
    return {
      ok: false,
      status: response.status,
      valid: false,
      values: fallbackValues as Partial<TData>,
      errors: {},
    }
  }
}

async function defaultSubmitter<TData>(context: ClientSubmitContext<TData>): Promise<ClientSubmitResult<TData>> {
  if (typeof fetch !== 'function' || !context.action) {
    return {
      ok: true,
      status: 200,
      data: context.values,
    }
  }

  const method = context.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    const response = await fetch(appendQueryString(context.action, context.formData), {
      method,
    })
    if (method === 'HEAD' || response.status === 204 || response.status === 205) {
      return {
        ok: true,
        status: response.status,
        data: undefined,
      }
    }

    return await normalizeFetchResponse(response, context.values)
  }

  const response = await fetch(context.action, {
    method,
    body: context.formData,
  })

  return await normalizeFetchResponse(response, context.values)
}

function isSafeMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase()
  return normalized === 'GET'
    || normalized === 'HEAD'
    || normalized === 'OPTIONS'
    || normalized === 'TRACE'
}

export function useForm<TSchema extends FormSchema<SchemaInputShape>>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferSchemaData<TSchema['fields']>> = {},
): UseFormResult<InferSchemaData<TSchema['fields']>> {
  type TData = InferSchemaData<TSchema['fields']>

  const initialValues = mergeValues(
    normalizeObject<TData>(options.initialState?.values),
    options.initialValues,
  )

  const state: MutableState<TData> = {
    values: cloneValue(initialValues),
    initialValues: cloneValue(initialValues),
    flattenedErrors: { ...(options.initialState?.errors ?? {}) },
    touched: new Set<string>(),
    dirty: new Set<string>(),
    submitting: false,
    lastSubmission: options.initialState,
    listeners: new Set(),
  }

  const validateOn = options.validateOn ?? 'submit'
  const fieldPaths = flattenLeafPaths(schemaDefinition.fields)
  const fields = buildFieldsTree(
    state,
    schemaDefinition as unknown as FormSchema<SchemaInputShape>,
    schemaDefinition.fields,
    validateOn,
  ) as FormFieldTree<TData>

  async function runValidation(): Promise<FormSubmissionResult<TData>> {
    const submission = await validate(state.values as unknown as Record<string, unknown>, schemaDefinition as never) as FormSubmissionResult<TData>
    state.flattenedErrors = submission.errors.flatten()
    state.lastSubmission = submission.serialize()
    notifyListeners(state)
    return submission
  }

  return Object.freeze({
    fields,
    get values() {
      return state.values
    },
    get errors() {
      return createTypedErrorBag<TData>(state.flattenedErrors)
    },
    get submitting() {
      return state.submitting
    },
    get valid() {
      return Object.keys(state.flattenedErrors).length === 0
    },
    get lastSubmission() {
      return state.lastSubmission
    },
    subscribe(listener: () => void) {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
    async validate() {
      return runValidation()
    },
    async validateField(path: string) {
      const submission = await runValidation()
      return submission.errors.get(path)
    },
    async submit() {
      state.submitting = true
      notifyListeners(state)
      try {
        const local = await runValidation()
        if (!local.valid) {
          return local
        }

        const submitter = options.submitter ?? defaultSubmitter<TData>
        const method = options.method ?? 'POST'
        const formData = buildFormData(state.values)

        if (options.csrf === true && !isSafeMethod(method)) {
          const csrfField = await getClientCsrfField()
          formData.set(csrfField.name, csrfField.value)
        }

        const response = await submitter({
          action: options.action,
          method,
          values: state.values,
          formData,
        })

        return this.applyServerState(response)
      } finally {
        state.submitting = false
        notifyListeners(state)
      }
    },
    reset(values?: Partial<TData>) {
      const next = mergeValues(state.initialValues, values)
      state.values = cloneValue(next)
      state.initialValues = cloneValue(next)
      state.flattenedErrors = {}
      state.touched.clear()
      state.dirty.clear()
      state.lastSubmission = undefined
      notifyListeners(state)
    },
    async setValue(path: string, value: unknown) {
      setValueAtPath(state.values as Record<string, unknown>, path, value)
      state.touched.add(path)
      if (!areEqual(getValueAtPath(state.initialValues, path), value)) {
        state.dirty.add(path)
      } else {
        state.dirty.delete(path)
      }

      if (validateOn === 'change' && fieldPaths.includes(path)) {
        const submission = await runValidation()
        state.flattenedErrors = submission.errors.flatten()
        return
      }

      notifyListeners(state)
    },
    applyServerState(result: ClientSubmitResult<TData>) {
      const normalized = normalizeSubmissionLike(
        schemaDefinition as unknown as FormSchema<SchemaInputShape>,
        state.values,
        result,
      )

      if ('ok' in normalized && normalized.ok === true) {
        state.lastSubmission = normalized
        state.flattenedErrors = {}
        notifyListeners(state)
        return normalized
      }

      if ('ok' in normalized && normalized.ok === false) {
        state.values = mergeValues(state.values, normalized.values)
        state.flattenedErrors = normalized.errors
        state.lastSubmission = {
          valid: false,
          submitted: true,
          values: normalized.values,
          errors: normalized.errors,
        }
        notifyListeners(state)
        return normalized
      }

      const normalizedSubmission = normalized as FormSubmissionResult<TData>
      state.values = mergeValues(state.values, normalizedSubmission.values)
      state.flattenedErrors = normalizedSubmission.errors.flatten()
      state.lastSubmission = normalizedSubmission.serialize()
      notifyListeners(state)

      return normalizedSubmission
    },
  }) satisfies UseFormResult<TData>
}
