import { isFieldDefinition, isPlainObject, isValidationField } from './contracts-support'
import type { FieldArrayItemDefinition, FieldDefinition } from './contracts-types'

export const DONT_FLASH_FIELDS = Object.freeze([
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

const DONT_FLASH_FIELD_SET = new Set<string>(DONT_FLASH_FIELDS)

type SensitiveShape = Readonly<Record<string, unknown>>

export interface StripSensitiveInputOptions {
  readonly files?: boolean
}

function isOmittedDefinition(definition: FieldDefinition, options: StripSensitiveInputOptions): boolean {
  if (definition.sensitive === true || (options.files === true && definition.kind === 'file')) {
    return true
  }

  return definition.kind === 'array'
    && isFieldDefinition(definition.item)
    && isOmittedDefinition(definition.item, options)
}

function stripArrayItems(
  items: readonly unknown[],
  item: FieldArrayItemDefinition | undefined,
  options: StripSensitiveInputOptions,
): unknown[] {
  return items.map(value => isFieldDefinition(item)
    ? stripFieldValue(item, value, options)
    : stripValue(value, item, options))
}

function stripFieldValue(definition: FieldDefinition, value: unknown, options: StripSensitiveInputOptions): unknown {
  return definition.kind === 'array' && Array.isArray(value)
    ? stripArrayItems(value, definition.item, options)
    : stripValue(value, undefined, options)
}

function stripValue(value: unknown, shape: SensitiveShape | undefined, options: StripSensitiveInputOptions): unknown {
  if (Array.isArray(value)) {
    return value.map(item => stripValue(item, undefined, options))
  }

  if (!isPlainObject(value) || value instanceof Date || value instanceof Blob) {
    return value
  }

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (DONT_FLASH_FIELD_SET.has(key)) {
      continue
    }

    const definition = shape?.[key]
    if (isValidationField(definition)) {
      if (!isOmittedDefinition(definition.definition, options)) {
        output[key] = stripFieldValue(definition.definition, item, options)
      }
      continue
    }

    output[key] = stripValue(item, isPlainObject(definition) ? definition : undefined, options)
  }

  return output
}

export function stripSensitiveInput<TValue>(
  value: TValue,
  shape?: SensitiveShape,
  options: StripSensitiveInputOptions = {},
): TValue {
  return stripValue(value, shape, options) as TValue
}
