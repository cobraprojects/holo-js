import {
  type FormLikeValidationInput,
  type InferSchemaData,
  type SchemaInputShape,
  type ValidationErrorBag,
  type ValidationSchema,
  ValidationException,
  createErrorBag,
  safeParse as safeParseInput,
  validationInternals,
} from '@holo-js/validation'
import { FormContractError } from './errors'
import {
  normalizeFailureErrors,
  normalizeFailureInput,
  normalizeStatus,
  type FormFailureInput,
  type FormFailureOptions,
} from './failure'
import type { FormSchema } from './schema'
import { sanitizeFlashedInput } from './sensitiveInput'

export { FormContractError } from './errors'
export {
  normalizeFailureErrors,
  normalizeFailureInput,
} from './failure'
export type {
  FormFailureErrors,
  FormFailureInput,
  FormFailureOptions,
} from './failure'
export { type FormSchema, type InferFormData, isFormSchema, schema } from './schema'
export { sanitizeFlashedInput } from './sensitiveInput'

export interface FormFailurePayload<TData> {
  readonly ok: false
  readonly status: number
  readonly valid: false
  readonly values: Partial<TData>
  readonly errors: Record<string, readonly string[]>
  readonly retryAfterSeconds?: number
  readonly retryAt?: string
}

export interface FormSuccessPayload<TPayload = undefined> {
  readonly ok: true
  readonly status: number
  readonly data: TPayload
}

export interface SerializedFormSubmission<TData> {
  readonly ok?: false
  readonly valid: boolean
  readonly submitted: true
  readonly values: Partial<TData> | TData
  readonly errors: Record<string, readonly string[]>
}

export interface FormSecurityOptions {
  readonly throttle?: string
  readonly bag?: string
}

type RequestLikeBody =
  | NonNullable<RequestInit['body']>
  | AsyncIterable<Uint8Array>

type RequestLikeHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>
  | {
    readonly get?: (name: string) => string | null | undefined
    readonly forEach?: (callback: (value: string, key: string) => void) => void
    readonly entries?: () => Iterable<readonly [string, string]>
  }

interface StructuredRequestLikeObject {
  readonly method?: string
  readonly path?: string
  readonly url?: string | URL
  readonly headers?: RequestLikeHeaders
  readonly body?: unknown
}

interface FormFailureMetadata {
  readonly retryAfterSeconds?: number
  readonly retryAt?: string
}

type NextHeadersModule = {
  readonly headers: () => Headers | Promise<Headers>
}

type FormsRuntimeGlobal = typeof globalThis & {
  readonly __holoFormsNextHeadersImport__?: () => Promise<unknown>
}

const nextHeadersModuleSpecifier = 'next/headers.js'

const h3RawBodySymbol = Symbol.for('h3RawBody')

type NodeRequestLikeObject = {
  readonly method?: string
  readonly url?: string
  readonly headers?: RequestLikeHeaders
  readonly body?: unknown
  readonly rawBody?: unknown
  readonly [h3RawBodySymbol]?: unknown
}

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
    readonly request?: Request | StructuredRequestLikeObject
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
  fail(): FormFailurePayload<TData>
  fail(status?: number): FormFailurePayload<TData>
  fail(options: FormFailureOptions): FormFailurePayload<TData>
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
  fail(): FormFailurePayload<TData>
  fail(status?: number): FormFailurePayload<TData>
  fail(options: FormFailureOptions): FormFailurePayload<TData>
}

export type FormSubmissionResult<TData> = FormSubmissionSuccess<TData> | FormSubmissionFailure<TData>

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
  failureMetadata: FormFailureMetadata = {},
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
      ...(normalized.status === 429 ? failureMetadata : {}),
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

export function createSuccessfulSubmission<TShape extends SchemaInputShape>(
  schemaDefinition: FormSchema<TShape>,
  data: InferSchemaData<TShape>,
): FormSubmissionSuccess<InferSchemaData<TShape>> {
  void schemaDefinition
  return createSubmission<InferSchemaData<TShape>>(
    true,
    data,
    createErrorBag(),
    422,
    schemaDefinition,
  ) as FormSubmissionSuccess<InferSchemaData<TShape>>
}

export function createFailedSubmission<TShape extends SchemaInputShape>(
  schemaDefinition: FormSchema<TShape>,
  values: Partial<InferSchemaData<TShape>>,
  flattenedErrors: Record<string, readonly string[]>,
  status = 422,
  failureMetadata: FormFailureMetadata = {},
): FormSubmissionFailure<InferSchemaData<TShape>> {
  void schemaDefinition
  const normalizedStatus = normalizeStatus(status, 422)
  return createSubmission<InferSchemaData<TShape>>(
    false,
    values,
    createErrorBag<InferSchemaData<TShape>>(flattenedErrors),
    normalizedStatus,
    schemaDefinition,
    failureMetadata,
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

function isFormDataInput(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData
}

function isHeadersTupleArray(value: unknown): value is ReadonlyArray<readonly [string, string]> {
  return Array.isArray(value)
    && value.every(entry =>
      Array.isArray(entry)
      && entry.length === 2
      && typeof entry[0] === 'string'
      && typeof entry[1] === 'string')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

function isHeaderAccessorObject(value: unknown): value is {
  readonly get?: (name: string) => string | null | undefined
  readonly forEach?: (callback: (value: string, key: string) => void) => void
  readonly entries?: () => Iterable<readonly [string, string]>
} {
  if (!value || typeof value !== 'object' || isPlainObject(value)) {
    return false
  }

  const candidate = value as {
    readonly get?: unknown
    readonly forEach?: unknown
    readonly entries?: unknown
  }

  return typeof candidate.get === 'function'
    || typeof candidate.forEach === 'function'
    || typeof candidate.entries === 'function'
}

function isRequestLikeHeaders(value: unknown): value is RequestLikeHeaders {
  return value instanceof Headers || isHeadersTupleArray(value) || isHeaderAccessorObject(value)
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

  if (isHeaderAccessorObject(input)) {
    if (typeof input.forEach === 'function') {
      input.forEach((value, name) => {
        headers.append(name, value)
      })
      return headers
    }

    if (typeof input.entries === 'function') {
      for (const [name, value] of input.entries()) {
        headers.append(name, value)
      }
      return headers
    }

    throw new TypeError('get-only header accessor is not iterable.')
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

function createFormDataRequestHeaders(requestHeaders: Headers): Headers {
  const formHeaders = new Headers()

  requestHeaders.forEach((value, name) => {
    const normalizedName = name.toLowerCase()
    if (normalizedName !== 'content-length' && normalizedName !== 'content-type') {
      formHeaders.append(name, value)
    }
  })

  return formHeaders
}

function resolveAmbientRequestUrl(headers: Headers): string {
  const referer = headers.get('referer')
  if (referer) {
    try {
      return new URL(referer).href
    } catch {
      // Ignore malformed client-controlled Referer headers and fall back to trusted request headers.
    }
  }

  const protocol = headers.get('x-forwarded-proto') ?? 'http'
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost'

  return `${protocol}://${host}/`
}

function isNextHeadersModule(value: unknown): value is NextHeadersModule {
  return !!value
    && typeof value === 'object'
    && typeof (value as { readonly headers?: unknown }).headers === 'function'
}

async function importNextHeadersModule(): Promise<NextHeadersModule | undefined> {
  try {
    const runtime = globalThis as FormsRuntimeGlobal
    const module = runtime.__holoFormsNextHeadersImport__
      ? await runtime.__holoFormsNextHeadersImport__()
      : await import(/* @vite-ignore */ nextHeadersModuleSpecifier)

    /* v8 ignore next -- V8 marks this guard uncovered even though both branches are exercised. */
    if (isNextHeadersModule(module)) {
      return module
    }

    return undefined
  } catch {
    return undefined
  }
}

async function resolveAmbientFormDataRequest(input: unknown): Promise<Request | undefined> {
  if (!isFormDataInput(input)) {
    return undefined
  }

  const nextHeadersModule = await importNextHeadersModule()
  if (!nextHeadersModule) {
    return undefined
  }

  const requestHeaders = await nextHeadersModule.headers()

  return new Request(resolveAmbientRequestUrl(requestHeaders), {
    method: 'POST',
    headers: createFormDataRequestHeaders(requestHeaders),
    body: input,
  })
}

function getStructuredWebRequest(input: FormRequestLikeInput): StructuredRequestLikeObject | undefined {
  /* v8 ignore next -- normalizeRequestLikeInput returns embedded Request instances before this helper is reached. */
  return input.web?.request instanceof Request
    ? undefined
    : input.web?.request
}

function extractRequestLikeUrl(input: FormRequestLikeInput, headers: Headers): string {
  const webRequest = getStructuredWebRequest(input)
  const url = webRequest?.url
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
  const webRequest = getStructuredWebRequest(input)
  return webRequest?.method
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

  const webRequest = getStructuredWebRequest(input)
  const rawBody = webRequest?.body
    ?? input.body
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.body : undefined)
    ?? input.node?.req?.body
    ?? input.node?.req

  if (typeof rawBody === 'undefined' || rawBody === null) {
    return undefined
  }

  return normalizeRequestLikeBody(rawBody, headers)
}

async function resolveRequestLikeBody(
  input: FormRequestLikeInput,
  headers: Headers,
  method: string,
): Promise<RequestInit['body'] | null | undefined> {
  if (method === 'GET' || method === 'HEAD') {
    return undefined
  }

  const nodeRequest = input.node?.req as NodeRequestLikeObject | undefined
  const rawBody = nodeRequest?.[h3RawBodySymbol]
    ?? nodeRequest?.rawBody
    ?? extractRequestLikeBody(input, headers, method)

  return normalizeRequestLikeBody(await rawBody, headers)
}

function normalizeRequestLikeBody(
  rawBody: unknown,
  headers: Headers,
): RequestInit['body'] | null | undefined {
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

function isStructuredRequestLikeObject(value: unknown): value is StructuredRequestLikeObject {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as {
    readonly method?: unknown
    readonly path?: unknown
    readonly url?: unknown
    readonly headers?: unknown
    readonly body?: unknown
  }

  return typeof candidate.method === 'string'
    || typeof candidate.path === 'string'
    || typeof candidate.url === 'string'
    || candidate.url instanceof URL
    || isRequestLikeHeaders(candidate.headers)
    || typeof candidate.body !== 'undefined'
}

function isRequestLikeInput(input: unknown): input is FormRequestLikeInput {
  if (!input || typeof input !== 'object') {
    return false
  }

  const candidate = input as FormRequestLikeInput
  if (candidate.web?.request instanceof Request || candidate.req instanceof Request) {
    return true
  }

  if (isStructuredRequestLikeObject(candidate.web?.request)) {
    return true
  }

  if (isStructuredRequestLikeObject(candidate.req)) {
    return true
  }

  if (isStructuredRequestLikeObject(candidate.node?.req)) {
    return true
  }

  const hasRequestMetadata = typeof candidate.method === 'string'
    || typeof candidate.path === 'string'
    || typeof candidate.url === 'string'
    || candidate.url instanceof URL
  const hasStructuredHeaders = isRequestLikeHeaders(candidate.headers)
  const hasPlainHeaderRecord = isPlainObject(candidate.headers)
  const hasBody = typeof candidate.body !== 'undefined'

  return hasRequestMetadata && (hasStructuredHeaders || hasPlainHeaderRecord || hasBody)
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
    getStructuredWebRequest(input)?.headers
      ?? input.headers
      ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.headers : undefined)
      ?? input.node?.req?.headers,
  )
  const method = extractRequestLikeMethod(input)
  const body = extractRequestLikeBody(input, headers, method)

  return createRequestFromParts(input, headers, method, body)
}

async function normalizeRequestLikeInputForValidation(
  input: FormLikeValidationInput | FormRequestLikeInput | null | undefined,
): Promise<Request | undefined> {
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
    getStructuredWebRequest(input)?.headers
      ?? input.headers
      ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.headers : undefined)
      ?? input.node?.req?.headers,
  )
  const method = extractRequestLikeMethod(input)
  const body = await resolveRequestLikeBody(input, headers, method)

  return createRequestFromParts(input, headers, method, body)
}

function createRequestFromParts(
  input: FormRequestLikeInput,
  headers: Headers,
  method: string,
  body: RequestInit['body'] | null | undefined,
): Request {
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

function createSecurityFailureMetadata(error: Error & { readonly status: number }): FormFailureMetadata {
  if (error.status !== 429) {
    return {}
  }

  const candidate = error as {
    readonly retryAfterSeconds?: unknown
    readonly snapshot?: {
      readonly expiresAt?: unknown
    }
  }
  const retryAfterSeconds = typeof candidate.retryAfterSeconds === 'number' && Number.isFinite(candidate.retryAfterSeconds)
    ? candidate.retryAfterSeconds
    : undefined
  const retryAt = candidate.snapshot?.expiresAt instanceof Date
    ? candidate.snapshot.expiresAt.toISOString()
    : undefined

  return {
    ...(typeof retryAfterSeconds === 'number' ? { retryAfterSeconds } : {}),
    ...(typeof retryAt === 'string' ? { retryAt } : {}),
  }
}

async function createSecurityFailureSubmission<TShape extends SchemaInputShape>(
  input: Request,
  schemaDefinition: FormSchema<TShape>,
  error: Error & { readonly status: number },
): Promise<FormSubmissionFailure<InferSchemaData<TShape>>> {
  let values = {} as Partial<InferSchemaData<TShape>>
  let flattenedErrors: Record<string, readonly string[]> = {}

  try {
    const inspection = await safeParseInput(input.clone(), schemaDefinition as ValidationSchema<TShape>)

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
    createSecurityFailureMetadata(error),
  )
}

export async function safeParse<TShape extends SchemaInputShape>(
  input: FormLikeValidationInput | FormRequestLikeInput,
  schemaDefinition: FormSchema<TShape>,
  options: FormSecurityOptions = {},
): Promise<FormSubmissionResult<InferSchemaData<TShape>>> {
  let validatedSubmission:
    | FormSubmissionResult<InferSchemaData<TShape>>
    | undefined
  const throttle = typeof options.throttle === 'string' ? options.throttle : undefined
  const usesSecurityOptions = typeof throttle === 'string'
  const normalizedRequestInput = await normalizeRequestLikeInputForValidation(input)
    ?? (usesSecurityOptions ? await resolveAmbientFormDataRequest(input) : undefined)
  const validationInput = normalizedRequestInput ?? input

  if (usesSecurityOptions && !normalizedRequestInput) {
    throw new FormContractError(
      'Security-aware safeParse() options require a Request or request-like event input.',
    )
  }

  if (usesSecurityOptions) {
    const request = normalizedRequestInput as Request

    try {
      const { loadSecurityModule } = await import('./security')
      const security = await loadSecurityModule()
      const inspection = await safeParseInput(request.clone(), schemaDefinition as ValidationSchema<TShape>)
      const throttleValues = inspection.valid ? inspection.data : inspection.values
      validatedSubmission = inspection.valid
        ? createSuccessfulSubmission(schemaDefinition, inspection.data)
        : createFailedSubmission(schemaDefinition, inspection.values, inspection.errors.flatten())
      await security.rateLimit(throttle, {
        request,
        values: throttleValues,
      })
    } catch (error) {
      const { formsSecurityInternals } = await import('./security')
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
            createSecurityFailureMetadata(error),
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

  const result = await safeParseInput(validationInput as FormLikeValidationInput, schemaDefinition as ValidationSchema<TShape>)

  if (result.valid) {
    return createSuccessfulSubmission(schemaDefinition, result.data)
  }

  return createFailedSubmission(schemaDefinition, result.values, result.errors.flatten())
}

export async function validate<TShape extends SchemaInputShape>(
  input: FormLikeValidationInput | FormRequestLikeInput,
  schemaDefinition: FormSchema<TShape>,
  options: FormSecurityOptions = {},
): Promise<InferSchemaData<TShape>> {
  const result = await safeParse(input, schemaDefinition, options)

  if (result.valid) {
    return result.data
  }

  const failure = result.fail()
  const exception = validationInternals.setValidationExceptionValues(
    ValidationException.withMessages(result.errors.flatten(), {
      bag: options.bag,
    }),
    result.values,
  )

  validationInternals.setValidationExceptionStatus(exception, failure.status)
  validationInternals.setValidationExceptionMetadata(exception, {
    ...(typeof failure.retryAfterSeconds === 'number' ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    ...(typeof failure.retryAt === 'string' ? { retryAt: failure.retryAt } : {}),
  })

  return validationInternals.throwValidationException(exception)
}

export const formsInternals = {
  createSubmission,
  isRequestLikeHeaders,
  nextHeadersModuleSpecifier,
  normalizeRequestLikeInput,
  normalizeStatus,
  normalizeRequestHeaders,
  sanitizeFlashedInput,
  serializeSubmissionState,
}
