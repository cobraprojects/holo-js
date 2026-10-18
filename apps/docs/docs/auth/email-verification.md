# Email Verification

Email verification makes users confirm they own their email address. Holo creates the token, emails the link, and marks the user as verified. You build the page the link opens.

## Turn it on

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'

export default defineAuthConfig({
  emailVerification: {
    required: true,
    route: env('AUTH_EMAIL_VERIFICATION_ROUTE', '/verify-email'),
  },
})
```

`emailVerification: true` is the same as `{ required: true, route: '/verify-email' }`.

Set `APP_URL` so Holo can build the link in the email:

```dotenv [.env]
APP_URL=http://localhost:3000
AUTH_EMAIL_VERIFICATION_ROUTE=/verify-email
```

The emailed link is `APP_URL` + `route` + `?token=...`, for example `http://localhost:3000/verify-email?token=...`. Users need an `email_verified_at` column; the auth migrations already add it.

## What changes when it's on

- `register()` sends the verification email automatically.
- `login()` and `loginUsing()` still sign unverified users in. The result has `emailVerificationRequired: true` and an `emailVerificationRoute` like `/verify-email?email=ava%40example.com`. Redirect there, as the [login examples](/auth/local-auth#log-a-user-in) do.
- [Social login](/auth/social-login) refuses new users whose provider doesn't report a verified email.

::: warning
Verification doesn't block any page by itself. Check `email_verified_at` wherever an unverified user shouldn't get in. See [Require a verified email](#require-a-verified-email).
:::

## Verify the token

The link opens your verification page with `?token=` in the URL. Pass that token to `verifyEmail()`:

::: code-group

```ts [Next.js]
// app/api/verify-email/route.ts
import { verifyEmail } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { verifyEmailForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const input = await validate(request, verifyEmailForm)

  await verifyEmail(input.token)

  return Response.json({ ok: true, status: 200, data: { redirectTo: '/dashboard' } })
}
```

```ts [Nuxt]
// server/api/verify-email.post.ts
import { verifyEmail } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { verifyEmailForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, verifyEmailForm)

  await verifyEmail(input.token)

  return { ok: true, status: 200, data: { redirectTo: '/dashboard' } }
})
```

```ts [SvelteKit]
// src/routes/verify-email/+page.server.ts
import { fail, redirect } from '@sveltejs/kit'
import { verifyEmail } from '@holo-js/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ url }) => {
    const token = url.searchParams.get('token')?.trim()
    if (!token) {
      return fail(422, { verificationError: 'Verification token is required.' })
    }

    await verifyEmail(token)

    redirect(303, '/dashboard')
  },
} satisfies Actions
```

:::

```ts [lib/schemas/auth.ts]
import { field, schema } from '@holo-js/validation'

export const verifyEmailForm = schema({
  token: field.string().required('Verification token is required.'),
})
```

On the page, read `token` from the URL and submit it, either automatically on load or with a "Verify my email" button. A button is safer, because some email scanners open links before the user does.

`verifyEmail()` returns the updated user. Each token works once; a second request with the same token fails.

## Resend the email

The `emailVerificationRoute` from login includes the user's email, so your page can offer a "Send again" button that posts it:

::: code-group

```ts [Next.js]
// app/api/verify-email/resend/route.ts
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { serializeValidationException } from '@holo-js/validation'
import { resendEmailVerificationForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const input = await validate(request, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  try {
    await resendEmailVerification(input.email)
  } catch (error) {
    if (!serializeValidationException(error)) throw error
  }

  return Response.json({ ok: true, status: 200, data: { message: 'If that address needs verifying, we sent a new link.' } })
}
```

```ts [Nuxt]
// server/api/verify-email/resend.post.ts
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { serializeValidationException } from '@holo-js/validation'
import { resendEmailVerificationForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  try {
    await resendEmailVerification(input.email)
  } catch (error) {
    if (!serializeValidationException(error)) throw error
  }

  return { ok: true, status: 200, data: { message: 'If that address needs verifying, we sent a new link.' } }
})
```

```ts [SvelteKit]
// src/routes/api/verify-email/resend/+server.ts
import { json } from '@sveltejs/kit'
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { serializeValidationException } from '@holo-js/validation'
import { resendEmailVerificationForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const input = await validate(request, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  try {
    await resendEmailVerification(input.email)
  } catch (error) {
    if (!serializeValidationException(error)) throw error
  }

  return json({ ok: true, status: 200, data: { message: 'If that address needs verifying, we sent a new link.' } })
}
```

:::

These routes always answer the same way, so nobody can use them to find out which emails have accounts. They also need an `emailVerificationResend` rate limiter in `config/security.ts`, which the installer doesn't add:

```ts [config/security.ts]
import { defineSecurityConfig, ip, limit } from '@holo-js/security'

export default defineSecurityConfig({
  // ...csrf and the rest of rateLimit stay as they are
  rateLimit: {
    limiters: {
      login: limit.perMinute(5).define(),
      register: limit.perHour(10).define(),
      emailVerificationResend: limit.perMinute(1).by(({ request, values }) => {
        const email = typeof values?.email === 'string' ? values.email.trim().toLowerCase() : 'unknown'
        return `email:${email}|client:${ip(request)}`
      }),
    },
  },
})
```

See [Rate Limiting](/basics/security/rate-limiting) for limiter options.

Call `resendEmailVerification()` with no arguments to send to the signed-in user. `sendEmailVerification()` does exactly the same thing; use whichever name reads better.

Each new link is valid for one hour. Pass `{ expiresAt }` as the second argument to change that:

```ts
await sendEmailVerification(undefined, { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
```

## Require a verified email

Check `email_verified_at` before sensitive actions:

```ts [app/api/billing/route.ts]
import { user } from '@holo-js/auth'

export async function POST() {
  const currentUser = await user()
  if (!currentUser?.email_verified_at) {
    return Response.json({ message: 'Verify your email address first.' }, { status: 403 })
  }

  return Response.json({ ok: true })
}
```

For page-level rules, an [authorization policy](/authorization/policies) can check the same field.

## Customize the email

Holo sends the email through [notifications](/notifications/) when `@holo-js/notifications` and a mailer are installed, or directly through [mail](/mail/) when only `@holo-js/mail` is installed. With neither, Holo still creates the token but only logs a warning instead of sending.

To change the subject, text, or queueing, publish the notification files:

```bash
npx holo auth:notifications:publish
```

This creates `server/notifications/auth/email-verification.ts` and `server/notifications/auth/password-reset.ts`. They are normal notifications, and Holo uses them automatically. The email builder receives:

| Field | Description |
| --- | --- |
| `email` | The recipient address |
| `name` | The user's name, if set |
| `url` | The full verification link |
| `expiresAt` | When the link expires |

Holo sends verification email the same way the rest of your app sends mail. If your mailer or notification is queued, so is this email.

## Errors

These throw a `ValidationException`, so they show up in forms like any validation error:

| Code | When | Field | Status |
| --- | --- | --- | --- |
| `email_verification_token_invalid` | The token is wrong or already used | `token` | 422 |
| `email_verification_token_expired` | The link expired | `token` | 422 |
| `email_verification_user_missing` | Resend found no user | `_root` | 401 |
| `email_already_verified` | Resend for a verified user | `_root` | 409 |

## Lower-level API

`verification` from `@holo-js/auth` gives direct access to tokens, for example to send a link for a user you just imported:

```ts
import { verification } from '@holo-js/auth'

await verification.create(user)
await verification.resend({ email: 'ava@example.com' })
await verification.consume(token)
```

`create()` and `resend()` accept `{ guard, expiresAt }`, and both replace the user's previous link and send the email. `consume()` is what `verifyEmail()` calls.

## Next steps

- [Password Reset](/auth/password-reset)
- [Login and Registration](/auth/local-auth)
- [Writing Notifications](/notifications/writing)
