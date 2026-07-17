import type { AuthError, AuthErrorCode, AuthFailure, AuthFieldErrors } from '../contracts'

export type InputFieldName<TInput extends Readonly<Record<string, unknown>>> = Extract<keyof TInput, string>

export function hasInputField<TInput extends Readonly<Record<string, unknown>>>(
  input: TInput,
  field: string,
): field is InputFieldName<TInput> {
  return Object.prototype.hasOwnProperty.call(input, field)
}

export function pickInputField<TInput extends Readonly<Record<string, unknown>>>(
  input: TInput,
  candidates: readonly string[],
): InputFieldName<TInput> | undefined {
  for (const candidate of candidates) {
    if (hasInputField(input, candidate)) {
      return candidate
    }
  }

  return undefined
}

export function createFieldErrors<TField extends string>(
  fields: readonly TField[],
  message: string,
): AuthFieldErrors<TField> {
  return Object.freeze(
    Object.fromEntries(fields.map(field => [field, Object.freeze([message])])) as AuthFieldErrors<TField>,
  )
}

export function createAuthFailurePayload<TCode extends AuthErrorCode, TFields extends AuthFieldErrors>(
  code: TCode,
  message: string,
  status: number,
  fields: TFields,
): AuthFailure<TCode, TFields> {
  return Object.freeze({
    code,
    message,
    status,
    fields,
  })
}

export function createPasswordConfirmationMismatchFailure<
  TCode extends AuthErrorCode,
  TInput extends Readonly<Record<string, unknown>>,
>(
  code: TCode,
  message: string,
  input: TInput,
): AuthFailure<TCode, Partial<Record<InputFieldName<TInput>, readonly string[]>>> {
  const fields = [
    pickInputField(input, ['password']),
    pickInputField(input, ['passwordConfirmation']),
  ].filter((field): field is InputFieldName<TInput> => typeof field === 'string')

  return createAuthFailurePayload(
    code,
    message,
    422,
    createFieldErrors(fields, message),
  )
}

export function resolveIdentifierFieldName<TInput extends Readonly<Record<string, unknown>>>(
  input: TInput,
  error: AuthError,
): InputFieldName<TInput> | undefined {
  const identifier = error.details?.identifier
  if (typeof identifier === 'string' && hasInputField(input, identifier)) {
    return identifier
  }

  return pickInputField(input, ['email', 'username', 'phone'])
}

export function resolveRequiredFieldName<TInput extends Readonly<Record<string, unknown>>>(
  input: TInput,
  candidates: readonly string[],
): InputFieldName<TInput> {
  const field = pickInputField(input, candidates)
  if (!field) {
    throw new Error('[@holo-js/auth] Expected auth failure mapping to resolve at least one input field.')
  }

  return field
}
