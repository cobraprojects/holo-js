import {
  type FormLikeValidationInput,
  type InferSchemaData,
  type SchemaInputShape,
  type ValidationErrorBag,
  type ValidationSchema,
  createErrorBag,
  defineSchema,
  isValidationSchema,
  validate as validateInput,
} from '@holo-js/validation'
import { formsSecurityInternals, loadSecurityModule } from './security'

export interface FormSchema<TShape extends SchemaInputShape = SchemaInputShape> extends ValidationSchema<TShape> {
  readonly mode: 'form'
  readonly fields: ValidationSchema<TShape>['fields']
  readonly $values?: Partial<InferSchemaData<TShape>>
}

export interface FormFailurePayload<TData> {
  readonly ok: false
  readonly status: number
  readonly valid: false
  readonly values: Partial<TData>
  readonly errors: Record<string, readonly string[]>
}

export interface FormSuccessPayload<TPayload = undefined> {
  readonly ok: true
  readonly status: number
  readonly data: TPayload
}

export interface SerializedFormSubmission<TData> {
  readonly valid: boolean
  readonly submitted: true
  readonly values: Partial<TData> | TData
  readonly errors: Record<string, readonly string[]>
}

export interface FormSecurityOptions {
  readonly csrf?: boolean
  readonly throttle?: string
}

type RequestLikeBody =
  | NonNullable<RequestInit['body']>
  | AsyncIterable<Uint8Array>

type RequestLikeHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>

export interface FormRequestLikeInput {
  readonly method?: string
  readonly path?: string
  readonly url?: string | URL
  readonly headers?: RequestLikeHeaders
  readonly body?: unknown
  readonly req?: Request | {
    readonly method?: string
    readonly url?: string
    readonly headers?: RequestLikeHeaders
    readonly body?: unknown
  }
  readonly node?: {
    readonly req?: {
      readonly method?: string
      readonly url?: string
      readonly headers?: RequestLikeHeaders
      readonly body?: unknown
    }
  }
  readonly web?: {
    readonly request?: Request
  }
}

export interface FormSubmissionSuccess<TData> {
  readonly valid: true
  readonly submitted: true
  readonly data: TData
  readonly values: TData
  readonly errors: ValidationErrorBag<TData>
  serialize(): SerializedFormSubmission<TData>
  success(): FormSuccessPayload<undefined>
  success<TPayload>(payload: TPayload, status?: number): FormSuccessPayload<TPayload>
  fail(status?: number): FormFailurePayload<TData>
}

export interface FormSubmissionFailure<TData> {
  readonly valid: false
  readonly submitted: true
  readonly data?: undefined
  readonly values: Partial<TData>
  readonly errors: ValidationErrorBag<TData>
  serialize(): SerializedFormSubmission<TData>
  success(): FormSuccessPayload<undefined>
  success<TPayload>(payload: TPayload, status?: number): FormSuccessPayload<TPayload>
  fail(status?: number): FormFailurePayload<TData>
}

export type FormSubmissionResult<TData> = FormSubmissionSuccess<TData> | FormSubmissionFailure<TData>

export class FormContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormContractError'
  }
}

export function schema<TShape extends SchemaInputShape>(
  shapeOrSchema: TShape | ValidationSchema<TShape>,
): FormSchema<TShape> {
  const base = isValidationSchema(shapeOrSchema)
    ? shapeOrSchema
    : defineSchema(shapeOrSchema)

  return Object.freeze({
    ...base,
    mode: 'form' as const,
  }) as FormSchema<TShape>
}

export function isFormSchema(value: unknown): value is FormSchema {
  return isValidationSchema(value)
    && (value as { mode?: unknown }).mode === 'form'
}

function normalizeStatus(value: number | undefined, fallback: number): number {
  if (typeof value === 'undefined') {
    return fallback
  }

  if (!Number.isInteger(value) || value < 100) {
    throw new FormContractError('HTTP status codes must be integers greater than or equal to 100.')
  }

  return value
}

function serializeSubmissionState<TData>(
  valid: boolean,
  values: Partial<TData> | TData,
  errors: ValidationErrorBag<TData>,
): SerializedFormSubmission<TData> {
  return Object.freeze({
    valid,
    submitted: true as const,
    values,
    errors: errors.flatten(),
  })
}

function createSubmission<TData>(
  valid: boolean,
  values: Partial<TData> | TData,
  errors: ValidationErrorBag<TData>,
  failureStatus = 422,
): FormSubmissionResult<TData> {
  const normalizedFailureStatus = normalizeStatus(failureStatus, 422)
  const serialize = () => serializeSubmissionState(valid, values, errors)

  const failure = (): FormFailurePayload<TData> => ({
    ok: false,
    status: normalizedFailureStatus,
    valid: false as const,
    values: values as Partial<TData>,
    errors: errors.flatten(),
  })

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
      fail(status?: number) {
        const payload = failure()
        return {
          ...payload,
          status: normalizeStatus(status, payload.status),
        }
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
    fail(status?: number) {
      const payload = failure()
      return {
        ...payload,
        status: normalizeStatus(status, payload.status),
      }
    },
  })
}

export function createSuccessfulSubmission<TShape extends SchemaInputShape>(
  schemaDefinition: FormSchema<TShape>,
  data: InferSchemaData<TShape>,
): FormSubmissionSuccess<InferSchemaData<TShape>> {
  void schemaDefinition
  return createSubmission<InferSchemaData<TShape>>(true, data, createErrorBag()) as FormSubmissionSuccess<
    InferSchemaData<TShape>
  >
}

export function createFailedSubmission<TShape extends SchemaInputShape>(
  schemaDefinition: FormSchema<TShape>,
  values: Partial<InferSchemaData<TShape>>,
  flattenedErrors: Record<string, readonly string[]>,
  status = 422,
): FormSubmissionFailure<InferSchemaData<TShape>> {
  void schemaDefinition
  const normalizedStatus = normalizeStatus(status, 422)
  return createSubmission<InferSchemaData<TShape>>(
    false,
    values,
    createErrorBag<InferSchemaData<TShape>>(flattenedErrors),
    normalizedStatus,
  ) as FormSubmissionFailure<InferSchemaData<TShape>>
}

function isRequestInput(input: FormLikeValidationInput): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request
}

function isRequestLikeBody(value: unknown): value is RequestLikeBody {
  if (typeof value === 'string' || value instanceof URLSearchParams) {
    return true
  }

  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    return true
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return true
  }

  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return true
  }

  if (ArrayBuffer.isView(value)) {
    return true
  }

  return !!value
    && typeof value === 'object'
    && (Symbol.asyncIterator in value || 'pipe' in value || 'getReader' in value)
}

function isHeadersTupleArray(value: unknown): value is ReadonlyArray<readonly [string, string]> {
  return Array.isArray(value)
    && value.every(entry =>
      Array.isArray(entry)
      && entry.length === 2
      && typeof entry[0] === 'string'
      && typeof entry[1] === 'string')
}

function isRequestLikeHeaders(value: unknown): value is RequestLikeHeaders {
  return value instanceof Headers || isHeadersTupleArray(value) || (!!value && typeof value === 'object')
}

function normalizeRequestHeaders(input: unknown): Headers {
  if (input instanceof Headers) {
    return new Headers(input)
  }

  const headers = new Headers()

  if (isHeadersTupleArray(input)) {
    for (const [name, value] of input) {
      headers.append(name, value)
    }

    return headers
  }

  if (input && typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        headers.append(name, value)
        continue
      }

      if (Array.isArray(value)) {
        const separator = name.toLowerCase() === 'cookie' ? '; ' : ','
        const joined = value.filter((entry): entry is string => typeof entry === 'string').join(separator)
        if (joined) {
          headers.append(name, joined)
        }
      }
    }
  }

  return headers
}

function extractRequestLikeUrl(input: FormRequestLikeInput, headers: Headers): string {
  const url = input.web?.request?.url
    ?? (typeof input.url === 'string' ? input.url : input.url?.toString())
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.url : undefined)
    ?? input.node?.req?.url
    ?? input.path
    ?? '/'

  try {
    return new URL(url).toString()
  } catch {
    const protocol = headers.get('x-forwarded-proto') ?? 'http'
    const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost'
    return new URL(url, `${protocol}://${host}`).toString()
  }
}

function extractRequestLikeMethod(input: FormRequestLikeInput): string {
  return input.web?.request?.method
    ?? input.method
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.method : undefined)
    ?? input.node?.req?.method
    ?? 'GET'
}

function extractRequestLikeBody(
  input: FormRequestLikeInput,
  headers: Headers,
  method: string,
): RequestInit['body'] | null | undefined {
  if (method === 'GET' || method === 'HEAD') {
    return undefined
  }

  const rawBody = input.body
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.body : undefined)
    ?? input.node?.req?.body
    ?? input.node?.req

  if (typeof rawBody === 'undefined' || rawBody === null) {
    return undefined
  }

  if (isRequestLikeBody(rawBody)) {
    return rawBody as RequestInit['body']
  }

  if (typeof rawBody === 'object') {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    return JSON.stringify(rawBody)
  }

  return String(rawBody)
}

function isRequestLikeInput(input: unknown): input is FormRequestLikeInput {
  if (!input || typeof input !== 'object') {
    return false
  }

  const candidate = input as FormRequestLikeInput
  return candidate.web?.request instanceof Request
    || candidate.req instanceof Request
    || typeof candidate.method === 'string'
    || typeof candidate.path === 'string'
    || typeof candidate.url === 'string'
    || candidate.url instanceof URL
    || isRequestLikeHeaders(candidate.headers)
    || (!!candidate.req && typeof candidate.req === 'object')
    || (!!candidate.node?.req && typeof candidate.node.req === 'object')
}

function normalizeRequestLikeInput(input: FormLikeValidationInput | FormRequestLikeInput | null | undefined): Request | undefined {
  if (isRequestInput(input as FormLikeValidationInput)) {
    return input as Request
  }

  if (!isRequestLikeInput(input)) {
    return undefined
  }

  if (input.web?.request instanceof Request) {
    return input.web.request
  }

  if (input.req instanceof Request) {
    return input.req
  }

  const headers = normalizeRequestHeaders(
    input.headers
      ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.headers : undefined)
      ?? input.node?.req?.headers,
  )
  const method = extractRequestLikeMethod(input)
  const body = extractRequestLikeBody(input, headers, method)

  return new Request(extractRequestLikeUrl(input, headers), {
    method,
    headers,
    body,
    // Undici requires duplex when constructing a Request from a stream/async iterable in Node.
    ...(body && typeof body === 'object' && (Symbol.asyncIterator in body || 'pipe' in body || 'getReader' in body)
      ? { duplex: 'half' as const }
      : {}),
  })
}

async function createSecurityFailureSubmission<TShape extends SchemaInputShape>(
  input: Request,
  schemaDefinition: FormSchema<TShape>,
  error: Error & { readonly status: number },
): Promise<FormSubmissionFailure<InferSchemaData<TShape>>> {
  let values = {} as Partial<InferSchemaData<TShape>>
  let flattenedErrors: Record<string, readonly string[]> = {}

  try {
    const inspection = await validateInput(input.clone(), schemaDefinition as ValidationSchema<TShape>)

    if (inspection.valid) {
      values = inspection.data
    } else {
      values = inspection.values
      flattenedErrors = inspection.errors.flatten()
    }
  } catch {
    values = {} as Partial<InferSchemaData<TShape>>
    flattenedErrors = {}
  }

  return createFailedSubmission(
    schemaDefinition,
    values,
    {
      ...flattenedErrors,
      _root: [
        ...(flattenedErrors._root ?? []),
        error.message,
      ],
    },
    error.status,
  )
}

export async function validate<TShape extends SchemaInputShape>(
  input: FormLikeValidationInput | FormRequestLikeInput,
  schemaDefinition: FormSchema<TShape>,
  options: FormSecurityOptions = {},
): Promise<FormSubmissionResult<InferSchemaData<TShape>>> {
  let validatedSubmission:
    | FormSubmissionResult<InferSchemaData<TShape>>
    | undefined
  const usesSecurityOptions = options.csrf === true || typeof options.throttle === 'string'
  const normalizedRequestInput = usesSecurityOptions
    ? normalizeRequestLikeInput(input)
    : undefined
  const validationInput = normalizedRequestInput ?? input

  if (usesSecurityOptions && !normalizedRequestInput) {
    throw new FormContractError(
      'Security-aware validate() options require a Request or request-like event input.',
    )
  }

  if (usesSecurityOptions) {
    const request = normalizedRequestInput as Request

    try {
      const security = await loadSecurityModule()
      const verificationRequest = (() => {
        try {
          return request.clone()
        } catch {
          return request
        }
      })()

      if (options.csrf === true) {
        await security.csrf.verify(verificationRequest)
      }

      if (typeof options.throttle === 'string') {
        const inspection = await validateInput(request.clone(), schemaDefinition as ValidationSchema<TShape>)
        const throttleValues = inspection.valid ? inspection.data : inspection.values
        validatedSubmission = inspection.valid
          ? createSuccessfulSubmission(schemaDefinition, inspection.data)
          : createFailedSubmission(schemaDefinition, inspection.values, inspection.errors.flatten())
        await security.rateLimit(options.throttle, {
          request,
          values: throttleValues,
        })
      }
    } catch (error) {
      if (formsSecurityInternals.isRootSecurityError(error)) {
        if (validatedSubmission) {
          return createFailedSubmission(
            schemaDefinition,
            validatedSubmission.valid
              ? validatedSubmission.data
              : validatedSubmission.values,
            {
              ...(validatedSubmission.valid
                ? {}
                : validatedSubmission.errors.flatten()),
              _root: [
                ...(!validatedSubmission.valid
                  ? (validatedSubmission.errors.flatten()._root ?? [])
                  : []),
                error.message,
              ],
            },
            error.status,
          )
        }

        return await createSecurityFailureSubmission(request, schemaDefinition, error)
      }

      throw error
    }
  }

  if (validatedSubmission) {
    return validatedSubmission
  }

  const result = await validateInput(validationInput as FormLikeValidationInput, schemaDefinition as ValidationSchema<TShape>)

  if (result.valid) {
    return createSuccessfulSubmission(schemaDefinition, result.data)
  }

  return createFailedSubmission(schemaDefinition, result.values, result.errors.flatten())
}

export const formsInternals = {
  createSubmission,
  isRequestLikeHeaders,
  normalizeRequestLikeInput,
  normalizeStatus,
  normalizeRequestHeaders,
  serializeSubmissionState,
}
