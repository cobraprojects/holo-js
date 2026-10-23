export function resetVerificationOnEmailChange(
  current: { readonly email?: unknown },
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (
    typeof attributes.email === 'undefined'
    || attributes.email === current.email
    || typeof attributes.email_verified_at !== 'undefined'
  ) {
    return attributes
  }

  return Object.freeze({
    ...attributes,
    email_verified_at: null,
  })
}
