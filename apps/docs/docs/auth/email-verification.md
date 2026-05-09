# Email Verification

Email verification lets an application require a verified address while Holo handles token creation, delivery, and
verification-link generation.

## Introduction

When email verification is enabled, the framework owns the token lifecycle and the application owns the HTTP routes and
pages that users interact with.

The usual flow is:

- `register(...)` creates the user and sends the first verification email automatically
- `login(...)` can still succeed for unverified users
- the login result tells the route when the user should be sent to the verification page
- the emailed link is built from `APP_URL` plus the configured verification route

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

The local user model should have an `email_verified_at` column.

## Environment

Set the application URL and optional route override:

```dotenv
APP_URL=http://localhost:3000
AUTH_EMAIL_VERIFICATION_ROUTE=/verify-email
```

`APP_URL` is used when the framework builds the email link. Applications should not manually construct the
verification URL in normal usage.

The application owns the page and API routes. The framework owns token storage, delivery, and the generated email link.

## Form Schemas

Use form schemas for request payloads so route handlers receive typed, validated data before calling auth:

```ts
import { field, schema } from '@holo-js/forms/schema'

export const verifyEmailForm = schema({
  token: field.string().required('Verification token is required.'),
})

export const resendEmailVerificationForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
})
```

## Registration Flow

Registration automatically starts email verification when `emailVerification.required` is `true`. Validate the request,
then pass the typed form data to `register(...)`:

```ts
import { register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, registerForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { data: session, error } = await register(submission.data)

  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: session.emailVerificationRequired
      ? 'Account created. Check your email to verify your address.'
      : 'Account created.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
  }))
}
```

Expected registration failures come back in `error`. On success, the local user is created and the verification
message is delivered automatically through the configured auth delivery integration.

::: tip Automatic verification email
Applications do not need to send the first verification email manually after registration. When
`emailVerification.required` is enabled, a successful `register(...)` call starts the verification delivery flow.
:::

## Login Flow

Unverified users can still sign in. Validate the login payload, then inspect the returned session:

```ts
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, loginForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { data: session, error } = await login(submission.data)

  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: session.emailVerificationRequired
      ? 'Signed in. Verify your email address to continue.'
      : 'Signed in successfully.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
  }))
}
```

When verification is still required, successful login includes:

- `emailVerificationRequired: true`
- `emailVerificationRoute: '/verify-email?email=ava%40example.com'`

That lets the app redirect the signed-in user to the verify page instead of rejecting the login attempt.

## Consuming Verification Tokens

Verification pages submit the token from the emailed link. Validate the payload, then call `verifyEmail(token)`:

```ts
import { verifyEmail } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { verifyEmailForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, verifyEmailForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { data: verifiedUser, error } = await verifyEmail(submission.data.token)

  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: 'Email verified.',
    user: verifiedUser,
  }))
}
```

The verification flow marks the local user as verified and invalidates the token.

## Resending Verification Emails

The verify page can submit an email address to request a fresh verification email. Validate the resend payload, then pass
the typed email string to `resendEmailVerification(email)`:

```ts
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, resendEmailVerificationForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await resendEmailVerification(submission.data.email)

  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: 'A fresh verification email has been sent.',
  }))
}
```

This is the intended verify-page flow when the user lands on `/verify-email?email=...` after login. The route receives
validated form data, so it can pass `submission.data.email` directly to auth without manual body parsing.

When the route is not specifically a resend action, use the same parameter shape with the send-oriented name:

```ts
import { sendEmailVerification } from '@holo-js/auth'

const { error } = await sendEmailVerification(email)
```

Expected resend failures come back in `error`, for example:

- `email_verification_user_missing`
- `email_already_verified`

## Delivery

Verification delivery is automatic once auth delivery is available.

- if `@holo-js/notifications` is installed with mail support, core routes auth delivery through notifications
- if notifications are absent but `@holo-js/mail` is installed, core sends directly through mail
- if no delivery integration is installed, auth creates the token and logs the skipped delivery

When auth and notifications are scaffolded together, Holo creates editable notification files:

```txt
server/notifications/auth/email-verification.ts
server/notifications/auth/password-reset.ts
```

Existing applications can publish those files later:

```bash
holo auth:notifications:publish
```

The published verification notification is a normal `defineNotification(...)` file. Its email builder receives a small
app-facing input with `email`, optional `name`, generated `url`, and `expiresAt`. Edit the file to change the subject,
body, action text, queue settings, or delay behavior.

::: warning Delivery package required
Publishing notification files only gives the application editable message definitions. Email delivery still needs
`@holo-js/mail` or another configured notification mailer. Without delivery, auth creates the verification token and
logs that the email was skipped.
:::

The default verification email includes:

- an HTML body
- a text fallback
- a link built from `APP_URL`
- the configured verification route
- the signed verification token

Applications do not need to manually compose `https://app.test/verify-email?token=...` links in normal usage.

Verification emails are queued only when the configured notifications or mail runtime is queued. Auth itself does not
force queueing.

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
