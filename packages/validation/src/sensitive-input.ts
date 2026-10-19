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

interface SensitiveInputWalk extends StripSensitiveInputOptions {
  readonly clear: boolean
}

function isOmittedDefinition(definition: FieldDefinition, options: StripSensitiveInputOptions): boolean {
  if (definition.sensitive === true || (options.files === true && definition.kind === 'file')) {
    return true
  }

  return definition.kind === 'array'
    && isFieldDefinition(definition.item)
    && isOmittedDefinition(definition.item, options)
}

function walkArrayItems(
  items: readonly unknown[],
  item: FieldArrayItemDefinition | undefined,
  options: SensitiveInputWalk,
): unknown[] {
  return items.map(value => isFieldDefinition(item)
    ? walkFieldValue(item, value, options)
    : walkValue(value, item, options))
}

function walkFieldValue(definition: FieldDefinition, value: unknown, options: SensitiveInputWalk): unknown {
  return definition.kind === 'array' && Array.isArray(value)
    ? walkArrayItems(value, definition.item, options)
    : walkValue(value, undefined, options)
}

function clearedValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(clearedValue) : ''
}

function walkValue(value: unknown, shape: SensitiveShape | undefined, options: SensitiveInputWalk): unknown {
  if (Array.isArray(value)) {
    return value.map(item => walkValue(item, undefined, options))
  }

  if (!isPlainObject(value) || value instanceof Date || value instanceof Blob) {
    return value
  }

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const definition = shape?.[key]
    if (DONT_FLASH_FIELD_SET.has(key) || (isValidationField(definition) && isOmittedDefinition(definition.definition, options))) {
      if (options.clear) {
        output[key] = clearedValue(item)
      }
      continue
    }

    if (isValidationField(definition)) {
      output[key] = walkFieldValue(definition.definition, item, options)
      continue
    }

    output[key] = walkValue(item, isPlainObject(definition) ? definition : undefined, options)
  }

  return output
}

export function stripSensitiveInput<TValue>(
  value: TValue,
  shape?: SensitiveShape,
  options: StripSensitiveInputOptions = {},
): TValue {
  return walkValue(value, shape, { ...options, clear: false }) as TValue
}

export function clearSensitiveInput<TValue>(
  value: TValue,
  shape?: SensitiveShape,
  options: StripSensitiveInputOptions = {},
): TValue {
  return walkValue(value, shape, { ...options, clear: true }) as TValue
}
