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

After registration succeeds, the application can request a verification token and deliver it through its own
notification layer:

```ts
import { register, verification } from '@holo-js/auth'

const created = await register({
  email: body.email,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})

await verification.create(created)
```

## Delivery

The current default delivery behavior is temporary. Until the notification package is in place, production
applications should configure a delivery hook and send the verification token through their own mail or notification
system.

## Protecting Application Routes

Route protection remains in your application. A simple pattern is:

```ts
import { user } from '@holo-js/auth'

const current = await user()
if (!current?.email_verified_at) {
  return Response.json({ message: 'Email verification required.' }, { status: 403 })
}
```
