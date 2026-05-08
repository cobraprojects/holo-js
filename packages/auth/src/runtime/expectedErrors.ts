import type {
  AuthEmailVerificationConsumeErrorCode,
  AuthEmailVerificationResendErrorCode,
  AuthLoginErrorCode,
  AuthPasswordResetConsumeErrorCode,
  AuthPasswordResetRequestErrorCode,
  AuthRegistrationErrorCode,
} from '../contracts'

export const EXPECTED_LOGIN_ERRORS = [
  'credentials_identifier_missing',
  'invalid_credentials',
  'email_verification_required',
] as const satisfies readonly AuthLoginErrorCode[]

export const EXPECTED_REGISTRATION_ERRORS = [
  'credentials_identifier_missing',
  'password_confirmation_mismatch',
  'registration_identifier_taken',
] as const satisfies readonly AuthRegistrationErrorCode[]

export const EXPECTED_EMAIL_VERIFICATION_CONSUME_ERRORS = [
  'email_verification_token_invalid',
  'email_verification_token_expired',
  'auth_user_missing',
  'provider_update_unsupported',
] as const satisfies readonly AuthEmailVerificationConsumeErrorCode[]

export const EXPECTED_EMAIL_VERIFICATION_RESEND_ERRORS = [
  'email_verification_user_missing',
  'email_already_verified',
] as const satisfies readonly AuthEmailVerificationResendErrorCode[]

export const EXPECTED_PASSWORD_RESET_REQUEST_ERRORS = [
  'password_reset_email_required',
] as const satisfies readonly AuthPasswordResetRequestErrorCode[]

export const EXPECTED_PASSWORD_RESET_CONSUME_ERRORS = [
  'password_confirmation_mismatch',
  'password_reset_token_invalid',
  'password_reset_token_expired',
  'password_reset_user_missing',
  'auth_user_missing',
  'provider_update_unsupported',
] as const satisfies readonly AuthPasswordResetConsumeErrorCode[]
