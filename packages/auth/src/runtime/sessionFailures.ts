import type {
  AuthCredentials,
  AuthError,
  AuthFailure,
  AuthLoginErrorCode,
  AuthRegistrationErrorCode,
  AuthRegistrationInput,
} from '../contracts'
import {
  type InputFieldName,
  createAuthFailurePayload,
  createFieldErrors,
  hasInputField,
  pickInputField,
  resolveIdentifierFieldName,
  resolveRequiredFieldName,
} from './failureFields'

export function createLoginFailure<TCredentials extends AuthCredentials>(
  error: AuthError<AuthLoginErrorCode>,
  credentials: TCredentials,
): AuthFailure<AuthLoginErrorCode, Partial<Record<InputFieldName<TCredentials>, readonly string[]>>> {
  switch (error.code) {
    case 'invalid_credentials': {
      const message = 'These credentials do not match our records.'
      const fields = [
        resolveIdentifierFieldName(credentials, error),
        hasInputField(credentials, 'password') ? 'password' : undefined,
      ].filter((field): field is InputFieldName<TCredentials> => typeof field === 'string')

      return createAuthFailurePayload(
        error.code,
        message,
        401,
        createFieldErrors(fields.length > 0 ? fields : [resolveRequiredFieldName(credentials, ['password'])], message),
      )
    }

    case 'email_verification_required': {
      const message = 'Verify your email address before signing in.'
      const field = resolveIdentifierFieldName(credentials, error) ?? resolveRequiredFieldName(credentials, ['password'])
      return createAuthFailurePayload(error.code, message, 403, createFieldErrors([field], message))
    }

    case 'credentials_identifier_missing':
    default: {
      const field = resolveRequiredFieldName(credentials, ['email', 'username', 'phone', 'password'])
      return createAuthFailurePayload(error.code, error.message, 422, createFieldErrors([field], error.message))
    }
  }
}

export function createRegistrationFailure<TInput extends AuthRegistrationInput>(
  error: AuthError<AuthRegistrationErrorCode>,
  input: TInput,
): AuthFailure<AuthRegistrationErrorCode, Partial<Record<InputFieldName<TInput>, readonly string[]>>> {
  switch (error.code) {
    case 'registration_identifier_taken': {
      const field = resolveIdentifierFieldName(input, error) ?? resolveRequiredFieldName(input, ['email', 'username', 'phone', 'password'])
      return createAuthFailurePayload(error.code, error.message, 422, createFieldErrors([field], error.message))
    }

    case 'password_confirmation_mismatch': {
      const message = error.message
      const fields = [
        pickInputField(input, ['password']),
        pickInputField(input, ['passwordConfirmation']),
      ].filter((field): field is InputFieldName<TInput> => typeof field === 'string')

      return createAuthFailurePayload(
        error.code,
        message,
        422,
        createFieldErrors(fields.length > 0 ? fields : [resolveRequiredFieldName(input, ['password'])], message),
      )
    }

    case 'credentials_identifier_missing':
    default: {
      const field = resolveRequiredFieldName(input, ['email', 'username', 'phone', 'password'])
      return createAuthFailurePayload(error.code, error.message, 422, createFieldErrors([field], error.message))
    }
  }
}
