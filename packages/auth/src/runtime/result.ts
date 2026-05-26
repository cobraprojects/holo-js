import {
  AuthError,
  isAuthError,
  type AuthErrorCode,
  type AuthFailure,
  type AuthFailureResult,
  type AuthFieldErrors,
  type AuthResult,
  type AuthSuccessResult,
} from '../contracts'
import { ValidationException, validationInternals } from '@holo-js/validation'

function createAuthError(
  code: AuthErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AuthError {
  return new AuthError(code, message, {
    details,
  })
}

export function throwAuthError(
  code: AuthErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw createAuthError(code, message, details)
}

function createAuthSuccess<TData>(data: TData): AuthSuccessResult<TData> {
  return Object.freeze({
    data,
    error: null,
  })
}

function createAuthFailure<TCode extends AuthErrorCode, TFields extends AuthFieldErrors>(
  error: AuthFailure<TCode, TFields>,
): AuthFailureResult<TCode, TFields> {
  return Object.freeze({
    data: null,
    error,
  })
}

function normalizeFieldErrors(fields: AuthFieldErrors): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, readonly string[]] => Array.isArray(entry[1])),
  )
}

export async function captureExpectedAuthResult<
  TData,
  TCode extends AuthErrorCode,
  TFields extends AuthFieldErrors,
>(
  operation: () => Promise<TData>,
  expectedCodes: readonly TCode[],
  mapError: (error: AuthError<TCode>) => AuthFailure<TCode, TFields>,
): Promise<AuthResult<TData, TCode, TFields>> {
  try {
    return createAuthSuccess(await operation())
  } catch (error) {
    if (isAuthError(error) && expectedCodes.includes(error.code as TCode)) {
      return createAuthFailure(mapError(error as AuthError<TCode>))
    }

    throw error
  }
}

export function unwrapExpectedAuthResult<TData, TCode extends AuthErrorCode, TFields extends AuthFieldErrors>(
  result: AuthResult<TData, TCode, TFields>,
): TData {
  if (result.error) {
    throw validationInternals.setValidationExceptionStatus(
      ValidationException.withMessages(normalizeFieldErrors(result.error.fields)),
      result.error.status,
    )
  }

  return result.data
}
