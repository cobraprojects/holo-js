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
the notifications system (which automatically integrates with mail when both packages are installed):

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
    }
  },
})

const created = await register({
  email: body.email,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})

const token = await verification.create(created)

// When both @holo-js/auth and @holo-js/notifications are installed,
// core automatically bridges the notification through the notifications system
await notify(created, verificationCreated(token))
```

## Delivery Integration

While the application still needs to call notify to trigger delivery, the integration between packages happens automatically:

### Automatic Package Bridging
When both @holo-js/auth and @holo-js/notifications are installed, the framework automatically handles the integration between them - you don't need to write any glue code to connect auth tokens to notifications.

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
const verificationCreated = (token: { plainTextToken: string }) => defineNotification({
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
        verificationToken: token.plainTextToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        purpose: 'email-verification'
      }
    }
  }
})
```

## Delivery Mechanism

When the `notify()` function is called for email verification:

1. **If `@holo-js/notifications` is installed**: The notification is sent through the notifications system
2. **Notifications → Mail Bridge**: If `@holo-js/mail` is also installed, notifications email channel automatically uses the mail system
3. **Direct Mail Fallback**: If only `@holo-js/mail` is installed (no notifications), core falls back to direct mail delivery
4. **No Packages**: If neither is installed, verification tokens are created but not automatically delivered

## Installation

To enable automatic email verification delivery:

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
