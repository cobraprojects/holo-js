import type { FieldDefinition, SchemaInputShape, ValidationSchema } from '@holo-js/validation'

const DEFAULT_DONT_FLASH_FIELDS = Object.freeze([
  'confirm_password',
  'confirmPassword',
  'current_password',
  'currentPassword',
  'new_password',
  'newPassword',
  'password',
  'password_confirmation',
  'passwordConfirmation',
])

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
      if (value.definition.sensitive === true) {
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

function deletePath(root: Record<string, unknown>, path: string): void {
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

  if (isPlainObject(cursor)) {
    delete cursor[leaf]
  }
}

function sanitizePlainObject<TData>(
  values: TData,
  sensitivePaths: readonly string[],
): TData {
  if (!isPlainObject(values)) {
    return values
  }

  const output = structuredClone(values) as Record<string, unknown>

  for (const field of DEFAULT_DONT_FLASH_FIELD_SET) {
    delete output[field]
  }

  for (const path of sensitivePaths) {
    deletePath(output, path)
  }

  return output as TData
}

export function sanitizeFlashedInput<TData>(
  values: Partial<TData> | TData,
  schemaDefinition?: SensitiveSchema,
): Partial<TData> | TData {
  return sanitizePlainObject(values, collectSensitivePaths(schemaDefinition))
}

export function clearSensitiveInputValues<TData>(values: TData, schemaDefinition?: SensitiveSchema): TData {
  if (!isPlainObject(values)) {
    return values
  }

  for (const field of DEFAULT_DONT_FLASH_FIELD_SET) {
    delete values[field]
  }

  for (const path of collectSensitivePaths(schemaDefinition)) {
    deletePath(values, path)
  }

  return values
}

export const sensitiveInputInternals = {
  collectSensitivePaths,
  DEFAULT_DONT_FLASH_FIELDS,
}
