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
): FormSubmissionResult<TData> {
  const serialize = () => serializeSubmissionState(valid, values, errors)

  const failure = (): FormFailurePayload<TData> => ({
    ok: false,
    status: 422,
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
): FormSubmissionFailure<InferSchemaData<TShape>> {
  void schemaDefinition
  return createSubmission<InferSchemaData<TShape>>(
    false,
    values,
    createErrorBag<InferSchemaData<TShape>>(flattenedErrors),
  ) as FormSubmissionFailure<InferSchemaData<TShape>>
}

export async function validate<TShape extends SchemaInputShape, TSchema extends FormSchema<TShape>>(
  input: FormLikeValidationInput,
  schemaDefinition: TSchema,
): Promise<FormSubmissionResult<InferSchemaData<TShape>>> {
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
