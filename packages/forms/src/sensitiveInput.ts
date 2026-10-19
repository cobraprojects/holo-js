import { validationInternals, type SchemaInputShape, type ValidationSchema } from '@holo-js/validation'

type SensitiveSchema = Pick<ValidationSchema<SchemaInputShape>, 'fields'>

export function sanitizeFlashedInput<TData>(
  values: Partial<TData> | TData,
  schemaDefinition?: SensitiveSchema,
): Partial<TData> | TData {
  return validationInternals.stripSensitiveInput(values, schemaDefinition?.fields, { files: true })
}

export function clearSensitiveInputValues<TData>(values: TData, schemaDefinition?: SensitiveSchema): TData {
  return validationInternals.clearSensitiveInput(values, schemaDefinition?.fields, { files: true })
}
