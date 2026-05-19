import type {
  FormFailureInput,
  FormFailurePayload,
  InferFormData,
  FormSchema,
  FormSubmissionResult,
  FormSuccessPayload,
  SerializedFormSubmission as SerializedSubmissionState,
  SerializedFormSubmission,
} from '../contracts'
import {
  normalizeFailureErrors,
  normalizeFailureInput,
  normalizeStatus,
} from '../failure'
import { clearSensitiveInputValues, sanitizeFlashedInput } from '../sensitiveInput'
import {
  type FormLikeValidationInput,
  createErrorBag,
  type FieldBuilderInput,
  type InferFieldOutput,
  type SchemaInputShape,
  type ValidationErrorBag,
  type ValidationSchema,
  type WebFileLike,
  validate as validateInput,
} from '@holo-js/validation'
import { getClientCsrfField } from '../client-security'

type PrimitiveLike = string | number | boolean | bigint | symbol | null | undefined | Date | Blob | WebFileLike

export type ValidateOnMode = 'submit' | 'blur' | 'change'

export interface ClientSubmitContext<TData> {
  readonly action?: string
  readonly method: string
  readonly values: TData
  readonly formData: FormData
}

export type ClientSubmitResult<TData, TSuccess = unknown>
  = FormSubmissionResult<TData>
  | SerializedFormSubmission<TData>
  | FormFailurePayload<TData>
  | FormSuccessPayload<TSuccess>

export interface UseFormOptions<TData, TSuccess = unknown> {
  readonly action?: string
  readonly method?: string
  readonly csrf?: boolean
  readonly validateOn?: ValidateOnMode
  readonly initialValues?: Partial<TData>
  readonly initialState?: SerializedFormSubmission<TData>
  readonly submitter?: (
    context: ClientSubmitContext<TData>,
  ) => Promise<ClientSubmitResult<TData, TSuccess>> | ClientSubmitResult<TData, TSuccess>
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

export type FormFieldTree<TData> = [TData] extends [readonly unknown[]]
  ? FormFieldState<TData>
  : [TData] extends [PrimitiveLike]
    ? FormFieldState<TData>
    : [TData] extends [Record<string, unknown>]
      ? { readonly [K in keyof TData]: FormFieldTree<TData[K]> }
      : FormFieldState<TData>

type FormFieldTreeFromShape<TShape extends SchemaInputShape> = {
  readonly [K in Extract<keyof TShape, string>]:
    TShape[K] extends FieldBuilderInput
      ? FormFieldState<InferFieldOutput<TShape[K]>>
      : TShape[K] extends SchemaInputShape
        ? FormFieldTreeFromShape<TShape[K]>
        : never
}

export type InferFormFieldTree<TSchema extends FormSchema>
  = TSchema extends FormSchema<infer TShape>
    ? FormFieldTreeFromShape<TShape>
    : never

export interface UseFormResult<TData, TSuccess = unknown, TFields = FormFieldTree<TData>> {
  readonly fields: TFields
  readonly values: TData
  readonly errors: ValidationErrorBag<TData>
  readonly submitting: boolean
  readonly valid: boolean
  readonly lastSubmission?: SerializedFormSubmission<TData> | FormFailurePayload<TData> | FormSuccessPayload<TSuccess>
  subscribe(listener: () => void): () => void
  validate(): Promise<FormSubmissionResult<TData>>
  validateField(path: string): Promise<readonly string[]>
  submit(): Promise<ClientSubmitResult<TData, TSuccess>>
  reset(values?: Partial<TData>): void
  setValue(path: string, value: unknown): Promise<void>
  applyServerState(result: ClientSubmitResult<TData, TSuccess>): ClientSubmitResult<TData, TSuccess>
}

type MutableState<TData, TSuccess> = {
  values: TData
  initialValues: TData
  flattenedErrors: Record<string, readonly string[]>
  touched: Set<string>
  dirty: Set<string>
  submitting: boolean
  lastSubmission?: SerializedFormSubmission<TData> | FormFailurePayload<TData> | FormSuccessPayload<TSuccess>
  listeners: Set<() => void>
}

type SchemaFieldLike = {
  readonly kind: 'field'
  readonly definition: object
}

const transportFailureMessage = 'Unable to submit the form right now. Please try again.'

function serializeSubmissionState<TData>(
  valid: boolean,
  values: Partial<TData> | TData,
  errors: ValidationErrorBag<TData>,
  schemaDefinition?: FormSchema,
): SerializedFormSubmission<TData> {
  return Object.freeze({
    valid,
    submitted: true as const,
    values: sanitizeFlashedInput(values, schemaDefinition),
    errors: errors.flatten(),
  })
}

function createSubmission<TData>(
  valid: boolean,
  values: Partial<TData> | TData,
  errors: ValidationErrorBag<TData>,
  failureStatus = 422,
  schemaDefinition?: FormSchema,
): FormSubmissionResult<TData> {
  const normalizedFailureStatus = normalizeStatus(failureStatus, 422)
  const serialize = () => serializeSubmissionState(valid, values, errors, schemaDefinition)

  const failure = (input?: FormFailureInput): FormFailurePayload<TData> => {
    const normalized = normalizeFailureInput(input, normalizedFailureStatus)

    return {
      ok: false,
      status: normalized.status,
      valid: false as const,
      values: sanitizeFlashedInput(values, schemaDefinition) as Partial<TData>,
      errors: normalizeFailureErrors(errors.flatten(), normalized.errors),
    }
  }

  const success = <TPayload>(payload?: TPayload, status?: number): FormSuccessPayload<TPayload | undefined> => ({
    ok: true,
    status: normalizeStatus(status, 200),
    data: payload,
  })

  if (valid) {
    const data = values as TData
    return Object.freeze({
      valid: true as const,
      submitted: true as const,
      data,
      values: data,
      errors,
      serialize,
      success,
      fail(input?: FormFailureInput) {
        return failure(input)
      },
    })
  }

  return Object.freeze({
    valid: false as const,
    submitted: true as const,
    data: undefined,
    values: values as Partial<TData>,
    errors,
    serialize,
    success,
    fail(input?: FormFailureInput) {
      return failure(input)
    },
  })
}

function createSuccessfulSubmission<TData>(
  schemaDefinition: FormSchema,
  data: TData,
): FormSubmissionResult<TData> {
  return createSubmission<TData>(true, data, createErrorBag(), 422, schemaDefinition)
}

function createFailedSubmission<TData>(
  schemaDefinition: FormSchema,
  values: Partial<TData>,
  flattenedErrors: Record<string, readonly string[]>,
  status = 422,
): FormSubmissionResult<TData> {
  void schemaDefinition
  return createSubmission<TData>(
    false,
    values,
    createErrorBag<TData>(flattenedErrors),
    normalizeStatus(status, 422),
    schemaDefinition,
  )
}

function createTransportFailure<TData>(
  values: Partial<TData> | TData,
  status = 500,
): FormFailurePayload<TData> {
  return {
    ok: false,
    status: normalizeStatus(status, 500),
    valid: false,
    values: values as Partial<TData>,
    errors: {
      _root: [transportFailureMessage],
    },
  }
}

async function validateClientValues<TData>(
  values: TData,
  schemaDefinition: FormSchema,
): Promise<FormSubmissionResult<TData>> {
  const result = await validateInput(
    values as unknown as FormLikeValidationInput,
    schemaDefinition as ValidationSchema<SchemaInputShape>,
  )

  if (result.valid) {
    return createSuccessfulSubmission(schemaDefinition, result.data as TData)
  }

  return createFailedSubmission(
    schemaDefinition,
    result.values as Partial<TData>,
    result.errors.flatten(),
  )
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

function notifyListeners<TData, TSuccess>(state: MutableState<TData, TSuccess>): void {
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

function replaceErrorsForPath(
  flattenedErrors: Record<string, readonly string[]>,
  path: string,
  nextErrors: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  const prefix = `${path}.`
  const merged = Object.fromEntries(
    Object.entries(flattenedErrors).filter(([key]) => key !== path && !key.startsWith(prefix)),
  )

  for (const [key, messages] of Object.entries(nextErrors)) {
    if (key === path || key.startsWith(prefix)) {
      merged[key] = messages
    }
  }

  return merged
}

function buildFieldsTree<TData>(
  state: MutableState<TData, unknown>,
  schemaDefinition: FormSchema,
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
          const submission = await validateClientValues(state.values, schemaDefinition) as FormSubmissionResult<TData>
          state.flattenedErrors = submission.errors.flatten()
        }

        notifyListeners(state)
      },
      async onInput(value: TData) {
        await (this as FormFieldState<TData>).set(value)
      },
      async onBlur() {
        state.touched.add(path)
        if (validateOn === 'blur') {
          const submission = await validateClientValues(state.values, schemaDefinition) as FormSubmissionResult<TData>
          state.flattenedErrors = replaceErrorsForPath(
            state.flattenedErrors,
            path,
            submission.errors.flatten(),
          )
        }

        notifyListeners(state)
      },
      async validate() {
        const submission = await validateClientValues(state.values, schemaDefinition)
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

function isSubmissionResult<TData, TSuccess>(
  value: ClientSubmitResult<TData, TSuccess>,
): value is FormSubmissionResult<TData> {
  return 'valid' in value
    && 'errors' in value
    && 'values' in value
    && !!value.errors
    && typeof value.errors === 'object'
    && 'flatten' in value.errors
    && typeof value.errors.flatten === 'function'
}

function isSerializedSubmission<TData, TSuccess>(
  value: ClientSubmitResult<TData, TSuccess>,
): value is SerializedSubmissionState<TData> {
  return 'submitted' in value && 'errors' in value && 'values' in value && !('ok' in value)
}

function normalizeSubmissionLike<TData, TSuccess>(
  schemaDefinition: FormSchema,
  values: TData,
  result: ClientSubmitResult<TData, TSuccess>,
): ClientSubmitResult<TData, TSuccess> {
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
      return createSuccessfulSubmission(schemaDefinition, result.values as TData) as FormSubmissionResult<TData>
    }

    return createFailedSubmission(schemaDefinition, result.values as Partial<TData>, result.errors) as FormSubmissionResult<TData>
  }

  if ('ok' in result && result.ok === true) {
    return result
  }

  return createSuccessfulSubmission(schemaDefinition, values) as FormSubmissionResult<TData>
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

async function normalizeFetchResponse<TData, TSuccess>(
  response: Response,
  fallbackValues: Partial<TData> | TData,
): Promise<ClientSubmitResult<TData, TSuccess>> {
  if (response.status === 204 || response.status === 205) {
    return {
      ok: true,
      status: response.status,
      data: undefined,
    } as FormSuccessPayload<TSuccess>
  }

  if (isJsonResponse(response)) {
    return await response.json() as ClientSubmitResult<TData, TSuccess>
  }

  if (response.ok) {
    return {
      ok: true,
      status: response.status,
      data: undefined,
    } as FormSuccessPayload<TSuccess>
  }

  try {
    return await response.json() as ClientSubmitResult<TData, TSuccess>
  } catch {
    return createTransportFailure(fallbackValues, response.status)
  }
}

async function defaultSubmitter<TData, TSuccess>(
  context: ClientSubmitContext<TData>,
): Promise<ClientSubmitResult<TData, TSuccess>> {
  if (typeof fetch !== 'function' || !context.action) {
    return {
      ok: true,
      status: 200,
      data: context.values as unknown as TSuccess,
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
      } as FormSuccessPayload<TSuccess>
    }

    return await normalizeFetchResponse<TData, TSuccess>(response, context.values)
  }

  const response = await fetch(context.action, {
    method,
    body: context.formData,
  })

  return await normalizeFetchResponse<TData, TSuccess>(response, context.values)
}

function isSafeMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase()
  return normalized === 'GET'
    || normalized === 'HEAD'
    || normalized === 'OPTIONS'
    || normalized === 'TRACE'
}

/**
 * @internal Shared headless form runtime for framework adapters.
 */
export function createFormClient<TSchema extends FormSchema, TSuccess = unknown>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferFormData<TSchema>, TSuccess> = {},
): UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>> {
  type TData = InferFormData<TSchema>

  const initialValues = mergeValues(
    normalizeObject<TData>(options.initialState?.values),
    options.initialValues,
  )

  const state: MutableState<TData, TSuccess> = {
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
    schemaDefinition,
    schemaDefinition.fields,
    validateOn,
  ) as unknown as InferFormFieldTree<TSchema>

  async function runValidation(): Promise<FormSubmissionResult<TData>> {
    const submission = await validateClientValues(state.values, schemaDefinition) as FormSubmissionResult<TData>
    state.flattenedErrors = submission.errors.flatten()
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

        const submitter = options.submitter ?? defaultSubmitter<TData, TSuccess>
        const method = options.method ?? 'POST'
        const formData = buildFormData(state.values)

        if (options.csrf === true && !isSafeMethod(method)) {
          const csrfField = await getClientCsrfField()
          formData.set(csrfField.name, csrfField.value)
        }

        let response: ClientSubmitResult<TData, TSuccess>
        try {
          response = await submitter({
            action: options.action,
            method,
            values: state.values,
            formData,
          })
        } catch {
          return this.applyServerState(createTransportFailure(state.values))
        }

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
    applyServerState(result: ClientSubmitResult<TData, TSuccess>) {
      const normalized = normalizeSubmissionLike(
        schemaDefinition,
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
        clearSensitiveInputValues(state.values, schemaDefinition)
        state.flattenedErrors = normalized.errors
        state.lastSubmission = normalized
        notifyListeners(state)
        return normalized
      }

      const normalizedSubmission = normalized as FormSubmissionResult<TData>
      state.values = mergeValues(state.values, normalizedSubmission.values)
      clearSensitiveInputValues(state.values, schemaDefinition)
      state.flattenedErrors = normalizedSubmission.errors.flatten()
      state.lastSubmission = normalizedSubmission.valid
        ? undefined
        : normalizedSubmission.fail()
      notifyListeners(state)

      return normalizedSubmission
    },
  }) satisfies UseFormResult<TData, TSuccess, InferFormFieldTree<TSchema>>
}
