import type {
  AuthEmailVerificationConsumeErrorCode,
  AuthEmailVerificationResendErrorCode,
  AuthError,
  AuthFailure,
  AuthFieldErrors,
  AuthPasswordResetConsumeErrorCode,
  AuthPasswordResetInput,
  AuthPasswordResetRequestErrorCode,
  AuthPasswordResetRequestInput,
} from '../contracts'
import {
  type InputFieldName,
  createAuthFailurePayload,
  createFieldErrors,
  createPasswordConfirmationMismatchFailure,
  resolveRequiredFieldName,
} from './failureFields'

export function createEmailVerificationResendFailure(
  error: AuthError<AuthEmailVerificationResendErrorCode>,
): AuthFailure<AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>> {
  switch (error.code) {
    case 'email_already_verified':
      return createAuthFailurePayload(error.code, error.message, 409, createFieldErrors(['_root'], error.message))
    case 'email_verification_user_missing':
    default:
      return createAuthFailurePayload(error.code, error.message, 401, createFieldErrors(['_root'], error.message))
  }
}

export function createPasswordResetRequestFailure<TInput extends AuthPasswordResetRequestInput>(
  error: AuthError<AuthPasswordResetRequestErrorCode>,
  input: TInput,
): AuthFailure<AuthPasswordResetRequestErrorCode, Partial<Record<InputFieldName<TInput>, readonly string[]>>> {
  const field = resolveRequiredFieldName(input, ['email'])
  return createAuthFailurePayload(error.code, error.message, 422, createFieldErrors([field], error.message))
}

export function createEmailVerificationConsumeFailure(
  error: AuthError<AuthEmailVerificationConsumeErrorCode>,
): AuthFailure<AuthEmailVerificationConsumeErrorCode, AuthFieldErrors<'token'>> {
  switch (error.code) {
    case 'provider_update_unsupported':
      return createAuthFailurePayload(error.code, error.message, 500, createFieldErrors(['token'], error.message))
    case 'email_verification_token_invalid':
      return createAuthFailurePayload(error.code, error.message, 422, createFieldErrors(['token'], error.message))
    case 'email_verification_token_expired': {
      const message = 'This verification link is invalid or has expired.'
      return createAuthFailurePayload(error.code, message, 422, createFieldErrors(['token'], message))
    }
    case 'auth_user_missing':
    default:
      return createAuthFailurePayload(error.code, error.message, 422, createFieldErrors(['token'], error.message))
  }
}

export function createPasswordResetConsumeFailure<TInput extends AuthPasswordResetInput>(
  error: AuthError<AuthPasswordResetConsumeErrorCode>,
  input: TInput,
): AuthFailure<AuthPasswordResetConsumeErrorCode, Partial<Record<InputFieldName<TInput>, readonly string[]>>> {
  switch (error.code) {
    case 'password_confirmation_mismatch': {
      return createPasswordConfirmationMismatchFailure(error.code, error.message, input)
    }
    case 'provider_update_unsupported': {
      const field = resolveRequiredFieldName(input, ['token'])
      return createAuthFailurePayload(error.code, error.message, 500, createFieldErrors([field], error.message))
    }
    case 'password_reset_token_expired': {
      const message = 'This password reset link is invalid or has expired.'
      const field = resolveRequiredFieldName(input, ['token'])
      return createAuthFailurePayload(error.code, message, 422, createFieldErrors([field], message))
    }
    case 'password_reset_token_invalid':
    case 'password_reset_user_missing':
    case 'auth_user_missing':
    default: {
      const field = resolveRequiredFieldName(input, ['token'])
      return createAuthFailurePayload(error.code, error.message, 422, createFieldErrors([field], error.message))
    }
  }
}
