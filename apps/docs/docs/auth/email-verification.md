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

`verifyEmail()` returns the updated user. Each token works once; a second request with the same token fails. A token only verifies the address it was sent to: if the user changes their email after the link was sent, the old link fails with `email_verification_token_expired`. Send a new link to the new address.

## Resend the email

Resending works only for a signed-in user, and it sends the link to that user's own address. The unverified user is signed in after login, so the verification page can offer a "Send again" button that posts to a route which checks the session first. Rate limit that route per user, so one account can't flood its own inbox:

::: code-group

```ts [Next.js]
// app/api/verify-email/resend/route.ts
import { resendEmailVerification, user } from '@holo-js/auth'
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'
import { serializeValidationException } from '@holo-js/validation'

export async function POST() {
  const current = await user()
  if (!current) {
    return Response.json({ ok: false, status: 401, errors: { _root: ['Sign in before requesting another verification email.'] } }, { status: 401 })
  }

  try {
    await rateLimit('emailVerificationResend', { key: `user:${String(current.id)}` })
    await resendEmailVerification()
  } catch (error) {
    if (error instanceof SecurityRateLimitError) {
      return Response.json({ ok: false, status: 429, errors: { _root: [error.message] } }, { status: 429 })
    }

    const payload = serializeValidationException(error)
    if (!payload) throw error
    return Response.json(payload, { status: payload.status })
  }

  return Response.json({ ok: true, status: 200, data: { message: 'A fresh verification email has been sent.' } })
}
```

```ts [Nuxt]
// server/api/verify-email/resend.post.ts
import { resendEmailVerification, user } from '@holo-js/auth'
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'
import { serializeValidationException } from '@holo-js/validation'

export default defineEventHandler(async (event) => {
  const current = await user()
  if (!current) {
    setResponseStatus(event, 401)
    return { ok: false, status: 401, errors: { _root: ['Sign in before requesting another verification email.'] } }
  }

  try {
    await rateLimit('emailVerificationResend', { key: `user:${String(current.id)}` })
    await resendEmailVerification()
  } catch (error) {
    if (error instanceof SecurityRateLimitError) {
      setResponseStatus(event, 429)
      return { ok: false, status: 429, errors: { _root: [error.message] } }
    }

    const payload = serializeValidationException(error)
    if (!payload) throw error
    setResponseStatus(event, payload.status)
    return payload
  }

  return { ok: true, status: 200, data: { message: 'A fresh verification email has been sent.' } }
})
```

```ts [SvelteKit]
// src/routes/api/verify-email/resend/+server.ts
import { json } from '@sveltejs/kit'
import { resendEmailVerification, user } from '@holo-js/auth'
import { rateLimit, SecurityRateLimitError } from '@holo-js/security'
import { serializeValidationException } from '@holo-js/validation'

export async function POST() {
  const current = await user()
  if (!current) {
    return json({ ok: false, status: 401, errors: { _root: ['Sign in before requesting another verification email.'] } }, { status: 401 })
  }

  try {
    await rateLimit('emailVerificationResend', { key: `user:${String(current.id)}` })
    await resendEmailVerification()
  } catch (error) {
    if (error instanceof SecurityRateLimitError) {
      return json({ ok: false, status: 429, errors: { _root: [error.message] } }, { status: 429 })
    }

    const payload = serializeValidationException(error)
    if (!payload) throw error
    return json(payload, { status: payload.status })
  }

  return json({ ok: true, status: 200, data: { message: 'A fresh verification email has been sent.' } })
}
```

:::

The route needs a limiter named `emailVerificationResend` in `config/security.ts`, which the installer doesn't add. Six sends per minute per user is enough for a slow human and too few for a script:

```ts [config/security.ts]
import { defineSecurityConfig, limit } from '@holo-js/security'

export default defineSecurityConfig({
  // ...csrf and the rest of rateLimit stay as they are
  rateLimit: {
    limiters: {
      login: limit.perMinute(5).define(),
      register: limit.perHour(10).define(),
      emailVerificationResend: limit.perMinute(6).define(),
    },
  },
})
```

See [Rate Limiting](/basics/security/rate-limiting) for limiter options.

`resendEmailVerification()` and `sendEmailVerification()` do the same thing; use whichever name reads better. Neither accepts an email address. Without a signed-in user they throw `email_verification_user_missing` with status 401, so a guest can't use them to send mail to an address they type in.

Each new link is valid for one hour. Pass `{ expiresAt }` to change that:

```ts
await sendEmailVerification({ expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
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
| `email_verification_token_expired` | The link expired, or the user's email changed after it was sent | `token` | 422 |
| `email_verification_user_missing` | Resend has no signed-in user | `_root` | 401 |
| `email_already_verified` | Resend for a verified user | `_root` | 409 |

## Lower-level API

`verification` from `@holo-js/auth` gives direct access to tokens, for example to send a link for a user you just imported:

```ts
import { verification } from '@holo-js/auth'

await verification.create(user)
await verification.resend()
await verification.consume(token)
```

`create()` and `resend()` accept `{ guard, expiresAt }`, and both replace the user's previous link and send the email. `resend()` sends to the signed-in user only. `consume()` is what `verifyEmail()` calls.

## Next steps

- [Password Reset](/auth/password-reset)
- [Login and Registration](/auth/local-auth)
- [Writing Notifications](/notifications/writing)
