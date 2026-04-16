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

After registration succeeds, the application should request a verification token and deliver it. This
example sends through `@holo-js/notifications` directly; auth-managed delivery only works after the
auth runtime has a delivery hook configured. See [Runtime Delivery Hook Configuration](#runtime-delivery-hook-configuration).

```ts
import { register, verification } from '@holo-js/auth'
import { defineNotification, notify } from '@holo-js/notifications'

const verificationCreated = (token: {
  id: string
  plainTextToken: string
  expiresAt: Date
}) => defineNotification({
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
    }
  },
})

const created = await register({
  email: body.email,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})

const token = await verification.create(created)

// This sends through notifications directly.
// Auth-managed delivery requires a configured AuthDeliveryHook.
await notify(created, verificationCreated(token))
```

## Delivery Integration

Package installation alone does not enable auth email delivery. The auth runtime must have an
`AuthDeliveryHook` bound before auth-managed verification emails can be sent.

See [Runtime Delivery Hook Configuration](#runtime-delivery-hook-configuration) for the runtime binding
you need when routing auth delivery through notifications or mail.

### Flexible Delivery Options
Once you call notify, you can send the verification through any available channel:
- **Email**: Primary delivery method for verification links (uses mail system when available)
- **Database**: Store verification records for internal tracking
- **Broadcast**: Real-time verification status updates via websocket
- **Custom Channels**: Extend verification delivery to Slack, SMS, or other services

### Queue-Friendly Delivery
Verification notifications can be queued for background processing:

```ts
await notify(created, verificationCreated(token))
  .onQueue('auth')
```

### Transaction Safety
Verification delivery respects database transactions:

```ts
await notify(created, verificationCreated(token))
  .afterCommit() // Send only after DB transaction commits
```

## Customizing Verification Emails

You can fully customize the verification notification by modifying the `build.email()` function:

```ts
const verificationCreated = (token: {
  id: string
  plainTextToken: string
  expiresAt: string | Date
}) => defineNotification({
  type: 'auth.email-verification',
  via() {
    return ['email', 'database'] as const // Send to both email and database
  },
  build: {
    email(user: { name?: string }) {
      return {
        subject: 'Verify your Holo JS account',
        greeting: `Hello ${user.name ?? 'there'},`,
        lines: [
          'Thanks for signing up! Please verify your email address to get started.',
          'This verification link will expire in 24 hours.'
        ],
        action: {
          label: 'Verify Email Address',
          url: `https://app.test/verify-email?token=${encodeURIComponent(token.plainTextToken)}`,
        },
        // Add any additional email-specific properties here
      }
    },
    database() {
      return {
        verificationTokenId: token.id,
        expiresAt: token.expiresAt,
        purpose: 'email-verification'
      }
    }
  }
})
```

## Delivery Mechanism

When the `notify()` function is called for email verification:

1. **If `@holo-js/notifications` is installed**: The notification is sent through the notifications system
2. **Notifications → Mail**: If the notifications email channel is configured to use mail, the email is sent through the mailer
3. **Auth Runtime Delivery Hook**: Built-in auth delivery requires a configured `AuthDeliveryHook`; otherwise auth logs a warning and skips delivery
4. **No Delivery Binding**: If no delivery hook is bound, verification tokens are created but are not sent automatically

## Installation

To enable email verification delivery through notifications or mail:

```bash
# For full notifications + mail integration (recommended)
bunx holo install notifications
bunx holo install mail

# For mail-only delivery
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

After registration succeeds, the application should request a verification token and deliver it. This
example again uses notifications directly; use [Runtime Delivery Hook Configuration](#runtime-delivery-hook-configuration)
if you want auth-managed delivery through notifications or mail.

```ts
import { register, verification } from '@holo-js/auth'
import { defineNotification, notify } from '@holo-js/notifications'

const verificationCreated = (token: {
  id: string
  plainTextToken: string
  expiresAt: string | Date
}) => defineNotification({
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

Auth delivery requires runtime configuration. Bind an `AuthDeliveryHook` through auth runtime bindings,
or follow [Runtime Delivery Hook Configuration](#runtime-delivery-hook-configuration), before relying on
notifications or mail for auth-managed verification emails.

Install notifications or mail into an existing project with:

```bash
bunx holo install notifications
bunx holo install mail
```

## Runtime Delivery Hook Configuration

Auth delivery is disabled until the auth runtime is given a delivery hook. Bind `delivery` with
`configureAuthRuntime({ delivery: ... })`, or follow the runtime bootstrap that wires auth, notifications,
and mail together before relying on the built-in auth delivery flows.

The manual `notify(created, verificationCreated(token))` example above does not use `AuthDeliveryHook`;
it sends through notifications directly.

## Protecting Application Routes

Route protection remains in your application. A simple pattern is:

```ts
import { user } from '@holo-js/auth'

const current = await user()
if (!current?.email_verified_at) {
  return Response.json({ message: 'Email verification required.' }, { status: 403 })
}
```
