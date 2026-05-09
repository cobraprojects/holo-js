import { FormContractError } from './errors'

export type FormFailureErrors = Readonly<Partial<Record<string, readonly string[]>>>

export interface FormFailureOptions {
  readonly status?: number
  readonly errors?: FormFailureErrors
}

export type FormFailureInput = number | FormFailureOptions | undefined

export function normalizeStatus(value: number | undefined, fallback: number): number {
  if (typeof value === 'undefined') {
    return fallback
  }

  if (!Number.isInteger(value) || value < 100) {
    throw new FormContractError('HTTP status codes must be integers greater than or equal to 100.')
  }

  return value
}

export function normalizeFailureInput(input: FormFailureInput, fallbackStatus: number): {
  readonly status: number
  readonly errors?: FormFailureErrors
} {
  if (typeof input === 'number') {
    return {
      status: normalizeStatus(input, fallbackStatus),
    }
  }

  return {
    status: normalizeStatus(input?.status, fallbackStatus),
    errors: input?.errors,
  }
}

export function normalizeFailureErrors(
  fallback: Record<string, readonly string[]>,
  override: FormFailureErrors | undefined,
): Record<string, readonly string[]> {
  if (!override) {
    return fallback
  }

  const normalized: Record<string, readonly string[]> = { ...fallback }

  for (const [field, messages] of Object.entries(override)) {
    if (typeof messages !== 'undefined') {
      normalized[field] = messages
    }
  }

  return normalized
}
