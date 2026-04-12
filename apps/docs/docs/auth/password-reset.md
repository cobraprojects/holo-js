# Password Reset

Password reset tokens let the application issue one-time credentials for resetting local passwords.

## Introduction

Password reset uses the configured broker and local provider:

```ts
passwords: {
  users: {
    provider: 'users',
    table: 'password_reset_tokens',
    expire: 60,
    throttle: 60,
  },
}
```

## Requesting A Reset Token

```ts
import { passwords } from '@holo-js/auth'

await passwords.request('ava@example.com')
```

The flow:

- looks up the user through the configured broker provider
- invalidates older tokens for that email
- creates a new hashed reset token
- sends the token through the configured delivery hook

## Resetting The Password

```ts
await passwords.consume({
  token: body.token,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

The reset flow verifies the token, hashes the new password, updates the local user record, and invalidates the used
token.

## Broker Selection

Use a non-default broker when needed:

```ts
await passwords.request('admin@example.com', {
  broker: 'admins',
})
```

## Delivery

Password reset delivery works the same way as email verification: auth creates the token, and notifications or
direct mail can own delivery.

For explicit delivery, send on-demand email routes through `notifyUsing()`:

```ts
import { defineNotification, notifyUsing } from '@holo-js/notifications'

const passwordResetRequested = (token: { plainTextToken: string }) => defineNotification({
  type: 'auth.password-reset',
  via() {
    return ['email'] as const
  },
  build: {
    email() {
      return {
        subject: 'Reset your password',
        lines: ['Use the link below to reset your password.'],
        action: {
          label: 'Reset password',
          url: `https://app.test/reset-password?token=${encodeURIComponent(token.plainTextToken)}`,
        },
      }
    },
  },
})

await notifyUsing()
  .channel('email', { email: 'ava@example.com', name: 'Ava' })
  .notify(passwordResetRequested(token))
```

If `@holo-js/auth` and `@holo-js/notifications` are both installed, core bridges the built-in auth delivery hook
through notifications automatically. If notifications are absent but `@holo-js/mail` is installed, core falls
back to direct mail delivery.
