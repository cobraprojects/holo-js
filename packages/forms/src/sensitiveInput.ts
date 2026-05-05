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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

export function sanitizeFlashedInput<TData>(
  values: Partial<TData> | TData,
): Partial<TData> | TData {
  if (!isPlainObject(values)) {
    return values
  }

  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !DEFAULT_DONT_FLASH_FIELD_SET.has(key)),
  ) as Partial<TData> | TData
}

export function clearSensitiveInputValues<TData>(values: TData): TData {
  if (!isPlainObject(values)) {
    return values
  }

  for (const field of DEFAULT_DONT_FLASH_FIELD_SET) {
    delete values[field]
  }

  return values
}

export const sensitiveInputInternals = {
  DEFAULT_DONT_FLASH_FIELDS,
}
