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
  safeParse,
} from '@holo-js/validation'
import { getClientCsrfField } from '../client-security'
import { validationExceptionToFailure } from './validation-exception'
import { FormClientState } from './state'
export { FormClientState, collectFormDirtyPaths } from './state'
import {
  areFormValuesEqual as areEqual,
  buildFormData,
  cloneFormValue as cloneValue,
  flattenFormLeafPaths as flattenLeafPaths,
  getFormValueAtPath as getValueAtPath,
  isFormLeafValue as isLeafValue,
  isPlainFormObject as isPlainObject,
  mergeFormValues as mergeValues,
  normalizeFormObject as normalizeObject,
  setFormValueAtPath as setValueAtPath,
} from './formValues'

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
  | {
    readonly ok: boolean
    readonly status: number
    readonly data: TSuccess
  }

type NormalizedClientSubmitResult<TData, TSuccess>
  = FormSubmissionResult<TData>
  | SubmittedFormFailurePayload<TData>
  | FormSuccessPayload<TSuccess>

type SubmittedFormFailurePayload<TData> = FormFailurePayload<TData> & {
  readonly submitted: true
}

type SvelteKitActionFailureResult = {
  readonly type: 'failure'
  readonly status: number
  readonly data: string
}

type SvelteKitActionErrorResult = {
  readonly type: 'error'
  readonly error: unknown
}

type BrowserFormElement = {
  readonly action?: string
  readonly method?: string
}

const browserFormSubmitSymbol: unique symbol = Symbol('browserFormSubmit')
const clientSubmitControlFlowErrors = new WeakSet<object>()

type BrowserFormSubmitter<TData, TSuccess> = {
  readonly [browserFormSubmitSymbol]: (form: BrowserFormElement) => Promise<ClientSubmitResult<TData, TSuccess>>
}

function isBrowserFormSubmitter<TData, TSuccess>(
  value: Pick<UseFormResult<TData, TSuccess>, 'submit'>,
): value is Pick<UseFormResult<TData, TSuccess>, 'submit'> & BrowserFormSubmitter<TData, TSuccess> {
  return browserFormSubmitSymbol in value
}

export interface UseFormOptions<TData, TSuccess = unknown> {
  readonly action?: string
  readonly method?: string
  readonly validateOn?: ValidateOnMode
  readonly initialValues?: Partial<TData>
  readonly initialState?: SerializedFormSubmission<TData> | FormFailurePayload<TData> | null
  readonly submitter?: (
    context: ClientSubmitContext<TData>,
  ) => Promise<ClientSubmitResult<TData, TSuccess> | void> | ClientSubmitResult<TData, TSuccess> | void
}

export function markClientSubmitControlFlowError(error: unknown): unknown {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return error
  }

  clientSubmitControlFlowErrors.add(error)
  return error
}

function isClientSubmitControlFlowError(error: unknown): boolean {
  return !!error
    && (typeof error === 'object' || typeof error === 'function')
    && clientSubmitControlFlowErrors.has(error)
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

type MutableState<TData, TSuccess> = FormClientState<TData, TSuccess>

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
): SubmittedFormFailurePayload<TData> {
  return {
    ok: false,
    status: normalizeStatus(status, 500),
    submitted: true,
    valid: false,
    values: values as Partial<TData>,
    errors: {
      _root: [transportFailureMessage],
    },
  }
}

async function validateClientValues<TData>(
  values: TData | FormLikeValidationInput,
  schemaDefinition: FormSchema,
): Promise<FormSubmissionResult<TData>> {
  const result = await safeParse(
    values as FormLikeValidationInput,
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

function getActiveElementBrowserForm(): BrowserFormElement | undefined {
  const activeElement = (globalThis as {
    readonly document?: {
      readonly activeElement?: {
        readonly form?: BrowserFormElement | null
      } | null
    }
  }).document?.activeElement

  return activeElement?.form ?? undefined
}

function getActiveBrowserFormData(form: BrowserFormElement | undefined): FormData | undefined {
  if (!form) {
    return undefined
  }

  try {
    return Reflect.construct(FormData, [form]) as FormData
  } catch {
    return undefined
  }
}

export async function runWithBrowserFormElement<TData, TSuccess>(
  formClient: Pick<UseFormResult<TData, TSuccess>, 'submit'>,
  form: BrowserFormElement,
): Promise<ClientSubmitResult<TData, TSuccess>> {
  if (isBrowserFormSubmitter(formClient)) {
    return await formClient[browserFormSubmitSymbol](form)
  }

  return await formClient.submit()
}

function notifyListeners<TData, TSuccess>(state: MutableState<TData, TSuccess>): void {
  for (const listener of state.listeners) {
    listener()
  }
}

function nextValidationSequence<TData, TSuccess>(state: MutableState<TData, TSuccess>): number {
  state.validationSequence += 1
  return state.validationSequence
}

function isLatestValidation<TData, TSuccess>(
  state: MutableState<TData, TSuccess>,
  sequence: number,
): boolean {
  return sequence === state.validationSequence
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
          const sequence = nextValidationSequence(state)
          const submission = await validateClientValues(
            cloneValue(state.values),
            schemaDefinition,
          ) as FormSubmissionResult<TData>
          if (isLatestValidation(state, sequence)) {
            state.flattenedErrors = submission.errors.flatten()
          }
        }

        notifyListeners(state)
      },
      async onInput(value: TData) {
        await (this as FormFieldState<TData>).set(value)
      },
      async onBlur() {
        state.touched.add(path)
        if (validateOn === 'blur') {
          const sequence = nextValidationSequence(state)
          const submission = await validateClientValues(
            cloneValue(state.values),
            schemaDefinition,
          ) as FormSubmissionResult<TData>
          if (isLatestValidation(state, sequence)) {
            state.flattenedErrors = replaceErrorsForPath(
              state.flattenedErrors,
              path,
              submission.errors.flatten(),
            )
          }
        }

        notifyListeners(state)
      },
      async validate() {
        const sequence = nextValidationSequence(state)
        const submission = await validateClientValues(cloneValue(state.values), schemaDefinition)
        if (isLatestValidation(state, sequence)) {
          state.flattenedErrors = submission.errors.flatten()
          notifyListeners(state)
        }
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

function isFormFailurePayload<TData>(value: unknown): value is FormFailurePayload<TData> {
  return isPlainObject(value)
    && value.ok === false
    && typeof value.status === 'number'
    && value.valid === false
    && isPlainObject(value.values)
    && isPlainObject(value.errors)
}

function isSvelteKitActionFailureResult(value: unknown): value is SvelteKitActionFailureResult {
  return isPlainObject(value)
    && value.type === 'failure'
    && typeof value.status === 'number'
    && typeof value.data === 'string'
}

function isSvelteKitActionErrorResult(value: unknown): value is SvelteKitActionErrorResult {
  return isPlainObject(value)
    && value.type === 'error'
    && isPlainObject(value.error)
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function normalizeSvelteKitActionResult<TData>(
  result: unknown,
): SubmittedFormFailurePayload<TData> | undefined {
  const payload = isSvelteKitActionFailureResult(result)
    ? parseJsonObject(result.data)
    : isSvelteKitActionErrorResult(result)
      ? result.error
      : undefined

  if (!isFormFailurePayload<TData>(payload)) {
    return undefined
  }

  return {
    ...payload,
    submitted: true,
  }
}

function normalizeSubmissionLike<TData, TSuccess>(
  schemaDefinition: FormSchema,
  values: TData,
  result: ClientSubmitResult<TData, TSuccess>,
): NormalizedClientSubmitResult<TData, TSuccess> {
  const svelteKitActionResult = normalizeSvelteKitActionResult<TData>(result)
  if (svelteKitActionResult) {
    return svelteKitActionResult
  }

  if (isSubmissionResult(result)) {
    return result
  }

  if ('ok' in result && result.ok === false && 'status' in result && 'errors' in result && 'values' in result) {
    return {
      ok: false,
      status: result.status,
      submitted: true,
      valid: false,
      values: result.values,
      errors: result.errors,
      ...(result.status === 429 && 'retryAfter' in result ? { retryAfter: result.retryAfter } : {}),
      ...(result.status === 429 && 'retryAt' in result ? { retryAt: result.retryAt } : {}),
    }
  }

  if (isSerializedSubmission(result)) {
    if (result.valid) {
      return createSuccessfulSubmission(schemaDefinition, result.values as TData) as FormSubmissionResult<TData>
    }

    return createFailedSubmission(schemaDefinition, result.values as Partial<TData>, result.errors) as FormSubmissionResult<TData>
  }

  if ('ok' in result && result.ok === true) {
    return {
      ok: true,
      status: result.status,
      data: result.data,
    }
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
  const initialState = options.initialState ?? undefined

  const initialValues = mergeValues(
    normalizeObject<TData>(options.initialValues),
    normalizeObject<TData>(initialState?.values),
  )

  const state = new FormClientState<TData, TSuccess>(initialValues, initialState)

  const validateOn = options.validateOn ?? 'submit'
  const fieldPaths = flattenLeafPaths(schemaDefinition.fields)
  const fields = buildFieldsTree(
    state,
    schemaDefinition,
    schemaDefinition.fields,
    validateOn,
  ) as unknown as InferFormFieldTree<TSchema>

  async function runValidation(): Promise<FormSubmissionResult<TData>> {
    return await runValidationForInput(cloneValue(state.values))
  }

  async function runValidationForInput(input: TData | FormLikeValidationInput): Promise<FormSubmissionResult<TData>> {
    const sequence = nextValidationSequence(state)
    const submission = await validateClientValues<TData>(input, schemaDefinition)
    if (isLatestValidation(state, sequence)) {
      state.values = mergeValues(
        state.values,
        submission.valid ? submission.data : submission.values,
      )
      state.flattenedErrors = submission.errors.flatten()
      notifyListeners(state)
    }
    return submission
  }

  function applyServerState(result: ClientSubmitResult<TData, TSuccess>): ClientSubmitResult<TData, TSuccess> {
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
      const sanitized = {
        ...normalized,
        values: sanitizeFlashedInput(normalized.values, schemaDefinition),
      }

      state.values = mergeValues(state.values, sanitized.values)
      clearSensitiveInputValues(state.values, schemaDefinition)
      state.flattenedErrors = sanitized.errors
      state.lastSubmission = sanitized
      notifyListeners(state)
      return sanitized
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
  }

  async function submit(browserForm?: BrowserFormElement): Promise<ClientSubmitResult<TData, TSuccess>> {
    const finishSubmission = state.startSubmission()
    notifyListeners(state)
    try {
      const submitter = options.submitter ?? defaultSubmitter<TData, TSuccess>
      const liveForm = browserForm ?? getActiveElementBrowserForm()
      const method = options.method ?? liveForm?.method ?? 'POST'
      const action = options.action ?? liveForm?.action
      const liveFormData = getActiveBrowserFormData(liveForm)
      const formData = liveFormData ?? buildFormData(state.values)
      const localSubmission = liveFormData
        ? await runValidationForInput(liveFormData)
        : await runValidation()

      if (!localSubmission.valid) {
        return localSubmission
      }

      if (!isSafeMethod(method)) {
        const csrfField = await getClientCsrfField()
        if (csrfField) {
          formData.set(csrfField.name, csrfField.value)
        }
      }

      let response: ClientSubmitResult<TData, TSuccess> | void
      try {
        response = await submitter({
          action,
          method,
          values: localSubmission.data,
          formData,
        })
      } catch (error) {
        if (isClientSubmitControlFlowError(error)) {
          throw error
        }

        return applyServerState(
          validationExceptionToFailure<TData>(error, state.values)
            ?? createTransportFailure(state.values),
        )
      }

      return applyServerState(response ?? {
        ok: true,
        status: 204,
        data: undefined,
      } as FormSuccessPayload<TSuccess>)
    } finally {
      finishSubmission()
      notifyListeners(state)
    }
  }

  return Object.freeze({
    fields,
    get values() {
      return state.values
    },
    get errors() {
      return state.errors
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
    submit() {
      return submit()
    },
    [browserFormSubmitSymbol](form: BrowserFormElement) {
      return submit(form)
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
        await runValidation()
        return
      }

      notifyListeners(state)
    },
    applyServerState(result: ClientSubmitResult<TData, TSuccess>) {
      return applyServerState(result)
    },
  }) satisfies UseFormResult<TData, TSuccess, InferFormFieldTree<TSchema>>
}
