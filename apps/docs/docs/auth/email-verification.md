# Email Verification

Email verification lets the application require a verified address while keeping the delivery flow automatic.

## Introduction

When email verification is enabled:

- registration automatically creates and sends a verification email
- login is still allowed
- the returned session tells the route that verification is still required
- the framework-generated email link uses `APP_URL` plus the configured verification route

Enable it in `config/auth.ts`:

```ts
import { defineAuthConfig, env } from '@holo-js/config'

export default defineAuthConfig({
  emailVerification: {
    required: true,
    route: env('AUTH_EMAIL_VERIFICATION_ROUTE', '/verify-email'),
  },
})
```

The local model should have an `email_verified_at` column.

## Environment

Set the application URL and optional route override:

```dotenv
APP_URL=http://localhost:3000
AUTH_EMAIL_VERIFICATION_ROUTE=/verify-email
```

`APP_URL` is used when the framework builds the email link. Applications should not manually construct the
verification URL in normal usage.

The application still owns the verification page and the route that calls `verifyEmail(token)`. The framework
owns the redirect target and the generated email link.

## Registration Flow

Registration automatically starts email verification when `emailVerification.required` is `true`:

```ts
import { register } from '@holo-js/auth'

const { data: created, error } = await register({
  name: body.name,
  email: body.email,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

Expected registration failures come back in `error`. On success, the local user is created and the verification
message is delivered automatically through the configured auth delivery integration.

Applications do not need to call `verification.create(...)` after registration just to send the first email.

## Login Flow

Unverified users can still sign in. The returned session includes verification state:

```ts
import { login } from '@holo-js/auth'

const { data: session, error } = await login({
  email: body.email,
  password: body.password,
  remember: body.remember === true,
})
```

When verification is still required, successful login includes:

- `emailVerificationRequired: true`
- `emailVerificationRoute: '/verify-email?email=ava%40example.com'`

Typical route handling:

```ts
if (error) {
  return Response.json({
    ok: false,
    status: error.status,
    valid: false,
    values: body,
    errors: error.fields,
  }, { status: error.status })
}

return Response.json({
  ok: true,
  data: {
    message: session.emailVerificationRequired
      ? 'Signed in. Verify your email address to continue.'
      : 'Signed in successfully.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
  },
})
```

That lets the app redirect the signed-in user to the verify page instead of rejecting the login attempt.

## Consuming Verification Tokens

Verification pages verify the token from the emailed link:

```ts
import { verifyEmail } from '@holo-js/auth'

const { data: verifiedUser, error } = await verifyEmail(token)
```

The verification flow marks the local user as verified and invalidates the token.

## Resending Verification Emails

Applications can resend another verification email with a direct email argument:

```ts
import { resendEmailVerification } from '@holo-js/auth'

const { error } = await resendEmailVerification(body.email)
```

This is the intended verify-page flow when the user lands on `/verify-email?email=...` after login.

When you are sending a verification email outside a resend route, use the same API shape with the send-oriented name:

```ts
import { sendEmailVerification } from '@holo-js/auth'

const { error } = await sendEmailVerification(body.email)
```

Expected resend failures come back in `error`, for example:

- `email_verification_user_missing`
- `email_already_verified`

## Delivery

Verification delivery is automatic once auth delivery is available.

- if `@holo-js/notifications` is installed, core can route auth delivery through notifications
- if notifications are absent but `@holo-js/mail` is installed, core can send directly through mail
- if no delivery integration is installed, auth logs the skipped delivery instead of building links in app code

The generated verification email includes:

- an HTML body
- a text fallback
- a link built from `APP_URL`
- the configured verification route
- the signed verification token

Applications do not need to manually compose `https://app.test/verify-email?token=...` links in normal usage.

## Protecting Application Routes

Route protection still belongs to the application. Email verification does not automatically block arbitrary pages.

```ts
import { user } from '@holo-js/auth'

const current = await user()
if (!current?.email_verified_at) {
  return Response.json({ message: 'Email verification required.' }, { status: 403 })
}
```

## Related Guides

- [Local Authentication](/auth/local-auth)
- [Password Reset](/auth/password-reset)
