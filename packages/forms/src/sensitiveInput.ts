import { validationInternals, type FieldDefinition, type SchemaInputShape, type ValidationSchema } from '@holo-js/validation'

const DEFAULT_DONT_FLASH_FIELDS = validationInternals.DONT_FLASH_FIELDS

const DEFAULT_DONT_FLASH_FIELD_SET = new Set<string>(DEFAULT_DONT_FLASH_FIELDS)

type SensitiveSchema = Pick<ValidationSchema<SchemaInputShape>, 'fields'>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function isFieldDefinition(value: unknown): value is FieldDefinition {
  return isPlainObject(value)
    && typeof value.kind === 'string'
    && Array.isArray(value.rules)
}

function isSchemaField(value: unknown): value is { readonly kind: 'field', readonly definition: FieldDefinition } {
  return isPlainObject(value)
    && value.kind === 'field'
    && isFieldDefinition(value.definition)
}

function collectSensitivePathsFromFields(
  fields: Record<string, unknown>,
  prefix = '',
  output: string[] = [],
): string[] {
  for (const [key, value] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (DEFAULT_DONT_FLASH_FIELD_SET.has(key)) {
      output.push(path)
    }

    if (isSchemaField(value)) {
      if (value.definition.sensitive === true || value.definition.kind === 'file') {
        output.push(path)
      }
      continue
    }

    if (isPlainObject(value)) {
      collectSensitivePathsFromFields(value, path, output)
    }
  }

  return output
}

function collectSensitivePaths(schemaDefinition: SensitiveSchema | undefined): readonly string[] {
  if (!schemaDefinition) {
    return []
  }

  return collectSensitivePathsFromFields(schemaDefinition.fields as Record<string, unknown>)
}

function clearPath(root: Record<string, unknown>, path: string): void {
  const parts = path.split('.').filter(Boolean)
  const leaf = parts.at(-1)
  if (!leaf) {
    return
  }

  let cursor: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor)) {
      return
    }

    cursor = cursor[part]
  }

  if (isPlainObject(cursor) && leaf in cursor) {
    cursor[leaf] = ''
  }
}

export function sanitizeFlashedInput<TData>(
  values: Partial<TData> | TData,
  schemaDefinition?: SensitiveSchema,
): Partial<TData> | TData {
  return validationInternals.stripSensitiveInput(values, schemaDefinition?.fields, { files: true })
}

export function clearSensitiveInputValues<TData>(values: TData, schemaDefinition?: SensitiveSchema): TData {
  if (!isPlainObject(values)) {
    return values
  }

  const mutableValues: Record<string, unknown> = values

  for (const field of DEFAULT_DONT_FLASH_FIELD_SET) {
    if (field in mutableValues) {
      mutableValues[field] = ''
    }
  }

  for (const path of collectSensitivePaths(schemaDefinition)) {
    clearPath(mutableValues, path)
  }

  return values
}

export const sensitiveInputInternals = {
  collectSensitivePaths,
  DEFAULT_DONT_FLASH_FIELDS,
}
