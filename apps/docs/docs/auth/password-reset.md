# Password Reset

Password reset tokens let the application issue one-time credentials for resetting local passwords.

## Introduction

Password reset uses the configured broker and local provider:

```ts
import { defineAuthConfig, env } from '@holo-js/config'

export default defineAuthConfig({
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

Set the route and base app URL in the environment:

```dotenv
APP_URL=http://localhost:3000
AUTH_PASSWORD_RESET_ROUTE=/reset-password
```

The framework-generated reset email uses `APP_URL` plus the configured broker route automatically.

The application still owns the reset page and the route that calls `resetPassword(...)`. The framework owns the
generated link target and delivery URL composition.

## Requesting A Reset Token

```ts
import { requestPasswordReset } from '@holo-js/auth'

const { error } = await requestPasswordReset({
  email: 'ava@example.com',
})
```

If the request fails for an expected auth reason, `error` is plain data:

```ts
{
  code: 'password_reset_email_required',
  message: 'Email is required to request a password reset.',
  status: 422,
  fields: {
    email: ['Email is required to request a password reset.'],
  },
}
```

The flow:

- looks up the user through the configured broker provider
- invalidates older tokens for that email
- creates a new hashed reset token
- sends the reset email through the configured delivery hook

## Resetting The Password

```ts
import { resetPassword } from '@holo-js/auth'

const { data: resetUser, error } = await resetPassword({
  token: body.token,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

`error.fields` targets the submitted auth fields directly, such as `token`, `password`, and
`passwordConfirmation`.

The reset flow verifies the token, hashes the new password, updates the local user record, and invalidates the used
token.

## Broker Selection

Use a non-default broker when needed:

```ts
const { error } = await requestPasswordReset({
  email: 'admin@example.com',
}, {
  broker: 'admins',
})
```

## Delivery

Password reset delivery works the same way as email verification:

- auth creates the token
- core builds the reset URL automatically from `APP_URL` and the configured broker route
- notifications or direct mail deliver the message when those integrations are installed

If `@holo-js/auth` and `@holo-js/notifications` are both installed, core bridges the built-in auth delivery hook
through notifications automatically. If notifications are absent but `@holo-js/mail` is installed, core falls
back to direct mail delivery.

Applications do not need to manually create `reset-password?token=...` URLs in normal usage.
