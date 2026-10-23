# Password Reset

Password reset lets users who forgot their password choose a new one through an emailed link. You build two pages, "forgot password" and "reset password"; Holo creates the token, sends the email, and updates the password.

## Request a reset link

The forgot-password route calls `requestPasswordReset()` with the submitted email:

::: code-group

```ts [Next.js]
// app/api/forgot-password/route.ts
import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { forgotPasswordForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const input = await validate(request, forgotPasswordForm)

  await requestPasswordReset(input)

  return Response.json({
    ok: true,
    status: 200,
    data: { message: 'If an account exists for that email, a reset link has been sent.' },
  })
}
```

```ts [Nuxt]
// server/api/forgot-password.post.ts
import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { forgotPasswordForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, forgotPasswordForm)

  await requestPasswordReset(input)

  return {
    ok: true,
    status: 200,
    data: { message: 'If an account exists for that email, a reset link has been sent.' },
  }
})
```

```ts [SvelteKit]
// src/routes/api/forgot-password/+server.ts
import { json } from '@sveltejs/kit'
import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { forgotPasswordForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const input = await validate(request, forgotPasswordForm)

  await requestPasswordReset(input)

  return json({
    ok: true,
    status: 200,
    data: { message: 'If an account exists for that email, a reset link has been sent.' },
  })
}
```

:::

```ts [lib/schemas/auth.ts]
import { field, schema } from '@holo-js/validation'

export const forgotPasswordForm = schema({
  email: field.string().required().email(),
})

export const resetPasswordForm = schema({
  token: field.string().required(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})
```

`requestPasswordReset()` succeeds even when no account has that email, and when a link was already sent recently. That way the response never reveals which emails are registered. Show the same message every time. Every call also takes at least 200 ms, as Laravel does, whether or not an account exists. That floor doesn't cover mail that is sent while the request waits. When delivery is synchronous and the mail server takes longer than 200 ms, a real account's request takes longer than an unknown one, so timing can still reveal the account. Queue the reset email to close that gap (see [Customize the email](#customize-the-email)): the request returns once the job is stored, and the mail I/O happens in a worker, as Laravel's `ShouldQueue` notifications do. With a queued email, both paths do the same work in the request.

When a user is found, Holo deletes their older reset links, creates a new one, and emails it.

## Reset the password

The email links to `APP_URL` + the broker's `route` + `?token=...`, for example `http://localhost:3000/reset-password?token=...`. Put the token from the URL in a hidden field and submit it with the new password:

::: code-group

```ts [Next.js]
// app/api/reset-password/route.ts
import { resetPassword } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { resetPasswordForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const input = await validate(request, resetPasswordForm)

  await resetPassword(input)

  return Response.json({ ok: true, status: 200, data: { redirectTo: '/login' } })
}
```

```ts [Nuxt]
// server/api/reset-password.post.ts
import { resetPassword } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { resetPasswordForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, resetPasswordForm)

  await resetPassword(input)

  return { ok: true, status: 200, data: { redirectTo: '/login' } }
})
```

```ts [SvelteKit]
// src/routes/api/reset-password/+server.ts
import { json } from '@sveltejs/kit'
import { resetPassword } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { resetPasswordForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const input = await validate(request, resetPasswordForm)

  await resetPassword(input)

  return json({ ok: true, status: 200, data: { redirectTo: '/login' } })
}
```

:::

`resetPassword()` hashes and saves the new password and returns the user. It doesn't sign the user in; send them to the login page, or call [`loginUsing()`](/auth/local-auth#sign-in-a-user-you-already-trust) with the returned user if you want to.

A link works once. After a successful reset, every other reset link for that email stops working too.

The reset also cycles the user's remember token, the way Laravel does on password reset. A browser that was signed in with "remember me" can no longer restore its session from the old remember cookie.

The reset signs the user out everywhere else. Every other browser's session stops working on its next request, including sessions that were already signed in. The browser that submits the reset keeps its place: if it was signed in as this user, its session ID is rotated and it stays signed in. A browser that wasn't signed in gets no session.

## Configure the broker

A broker is a set of reset settings for one user provider. The installer creates a `users` broker:

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'

export default defineAuthConfig({
  defaults: {
    passwords: 'users',
  },
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
      route: env('AUTH_PASSWORD_RESET_ROUTE', '/reset-password'),
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `provider` | `'users'` | Which users this broker resets |
| `table` | `'password_reset_tokens'` | Where tokens are stored |
| `expire` | `60` | Minutes a link stays valid |
| `throttle` | `60` | Minutes before the same email can get another link. `0` turns it off |
| `route` | `'/reset-password'` | The path of your reset page |

Set `APP_URL` in `.env` so the link points at your site.

### Reset passwords for admins

Add a broker per provider and pass its name:

```ts [config/auth.ts]
passwords: {
  users: { provider: 'users' },
  admins: { provider: 'admins', route: '/admin/reset-password' },
},
```

```ts
await requestPasswordReset({ email }, { broker: 'admins' })
```

`requestPasswordReset()` also accepts `expiresAt` in that options object, to override `expire` for one link.

## Customize the email

Reset emails are sent the same way as verification emails: through notifications, through mail, or only logged if neither is installed. Run `npx holo auth:notifications:publish` to get an editable `server/notifications/auth/password-reset.ts`. Its email builder receives `email`, `url`, and `expiresAt`. See [Customize the email](/auth/email-verification#customize-the-email).

Queue the reset email in production. A queued email returns the request before mail I/O, which removes the timing difference described under [Request a reset link](#request-a-reset-link). Queueing needs a worker for the queue connection, as described in [Queueing notifications](/notifications/queueing).

## Errors

These throw a `ValidationException`, so they show up in your form:

| Code | When | Field | Status |
| --- | --- | --- | --- |
| `password_reset_email_required` | The email is blank | `email` | 422 |
| `password_reset_token_invalid` | The token is wrong | `token` | 422 |
| `password_reset_token_expired` | The link expired or was already used | `token` | 422 |
| `password_reset_user_missing` | The user was deleted | `token` | 422 |
| `password_confirmation_mismatch` | The passwords differ | `password`, `passwordConfirmation` | 422 |

A missing broker name throws an `AuthError` with code `password_broker_not_configured`.

## Next steps

- [Email Verification](/auth/email-verification)
- [Login and Registration](/auth/local-auth)
- [Rate Limiting](/basics/security/rate-limiting)
