# Email Verification

Email verification lets the application require verified email addresses before a user can continue.

## Introduction

When email verification is enabled, login is blocked until the local user model has a verification timestamp.

```ts
emailVerification: {
  required: true,
}
```

The local model should have an `email_verified_at` column.

## Creating Verification Tokens

```ts
import { verification } from '@holo-js/auth'

const token = await verification.create(user)
```

The token store records:

- provider
- user id
- email
- hashed token secret
- creation time
- expiration time

## Consuming Verification Tokens

```ts
await verification.consume(token.plainTextToken)
```

The verification flow marks the local user as verified and invalidates the token.

## Registration Flow

After registration succeeds, the application should request a verification token and deliver it through
notifications or direct mail:

```ts
import { register, verification } from '@holo-js/auth'
import { defineNotification, notify } from '@holo-js/notifications'

const verificationCreated = (token: { plainTextToken: string }) => defineNotification({
  type: 'auth.email-verification',
  via() {
    return ['email'] as const
  },
  build: {
    email(user: { name?: string }) {
      return {
        subject: 'Verify your email address',
        greeting: `Hello ${user.name ?? 'there'},`,
        lines: ['Please verify your email address to continue.'],
        action: {
          label: 'Verify email',
          url: `https://app.test/verify-email?token=${encodeURIComponent(token.plainTextToken)}`,
        },
      }
    },
  },
})

const created = await register({
  email: body.email,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})

const token = await verification.create(created)

await notify(created, verificationCreated(token))
```

## Delivery

If `@holo-js/auth` and `@holo-js/notifications` are both installed, core bridges auth delivery through
notifications automatically. If notifications are absent but `@holo-js/mail` is installed, core falls back to
direct mail delivery instead.

Install notifications or mail into an existing project with:

```bash
bunx holo install notifications
bunx holo install mail
```

## Protecting Application Routes

Route protection remains in your application. A simple pattern is:

```ts
import { user } from '@holo-js/auth'

const current = await user()
if (!current?.email_verified_at) {
  return Response.json({ message: 'Email verification required.' }, { status: 403 })
}
```
