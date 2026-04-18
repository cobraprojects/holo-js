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
  const serialize = () => serializeSubmissionState(valid, values, errors)

  const failure = (): FormFailurePayload<TData> => ({
    ok: false,
    status: failureStatus,
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

export function createSuccessfulSubmission<TShape extends SchemaInputShape, TSchema extends FormSchema<TShape>>(
  schemaDefinition: TSchema,
  data: InferSchemaData<TShape>,
): FormSubmissionSuccess<InferSchemaData<TShape>> {
  void schemaDefinition
  return createSubmission<InferSchemaData<TShape>>(true, data, createErrorBag()) as FormSubmissionSuccess<
    InferSchemaData<TShape>
  >
}

export function createFailedSubmission<TShape extends SchemaInputShape, TSchema extends FormSchema<TShape>>(
  schemaDefinition: TSchema,
  values: Partial<InferSchemaData<TShape>>,
  flattenedErrors: Record<string, readonly string[]>,
  status = 422,
): FormSubmissionFailure<InferSchemaData<TShape>> {
  void schemaDefinition
  return createSubmission<InferSchemaData<TShape>>(
    false,
    values,
    createErrorBag<InferSchemaData<TShape>>(flattenedErrors),
    status,
  ) as FormSubmissionFailure<InferSchemaData<TShape>>
}

function isRequestInput(input: FormLikeValidationInput): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request
}

async function createSecurityFailureSubmission<TShape extends SchemaInputShape, TSchema extends FormSchema<TShape>>(
  input: Request,
  schemaDefinition: TSchema,
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

export async function validate<TShape extends SchemaInputShape, TSchema extends FormSchema<TShape>>(
  input: FormLikeValidationInput,
  schemaDefinition: TSchema,
  options: FormSecurityOptions = {},
): Promise<FormSubmissionResult<InferSchemaData<TShape>>> {
  let validatedSubmission:
    | FormSubmissionResult<InferSchemaData<TShape>>
    | undefined
  const usesSecurityOptions = options.csrf === true || typeof options.throttle === 'string'

  if (usesSecurityOptions && !isRequestInput(input)) {
    throw new FormContractError(
      'Security-aware validate() options require a Request input.',
    )
  }

  if (usesSecurityOptions) {
    const request = input as Request

    try {
      const security = await loadSecurityModule()

      if (options.csrf === true) {
        await security.csrf.verify(request)
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

  const result = await validateInput(input, schemaDefinition as ValidationSchema<TShape>)

  if (result.valid) {
    return createSuccessfulSubmission(schemaDefinition, result.data)
  }

  return createFailedSubmission(schemaDefinition, result.values, result.errors.flatten())
}

export const formsInternals = {
  createSubmission,
  normalizeStatus,
  serializeSubmissionState,
}
