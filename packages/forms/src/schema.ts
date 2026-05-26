import {
  type InferSchemaData,
  type SchemaInputShape,
  type ValidationSchema,
  defineSchema,
  isValidationSchema,
} from '@holo-js/validation'

export interface FormSchema<TShape extends SchemaInputShape = SchemaInputShape> extends ValidationSchema<TShape> {
  readonly mode: 'form'
  readonly fields: ValidationSchema<TShape>['fields']
  readonly $values?: Partial<InferSchemaData<TShape>>
}

export type InferFormData<TSchema extends FormSchema>
  = TSchema extends FormSchema<infer TShape>
    ? InferSchemaData<TShape>
    : never

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

export {
  createErrorBag,
  DEFAULT_VALIDATION_BAG,
  defineSchema,
  field,
  isValidationException,
  parse,
  safeParse,
  ValidationException,
  validationInternals,
} from '@holo-js/validation'

export type {
  ErrorTree,
  ErrorTreeNode,
  FieldDefinition,
  FieldRule,
  InferSchemaData,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
  SerializedValidationException,
  ValidationErrorBag,
  ValidationExceptionOptions,
  ValidationFailure,
  ValidationResult,
  ValidationSchema,
  ValidationSuccess,
  WebFileLike,
} from '@holo-js/validation'
