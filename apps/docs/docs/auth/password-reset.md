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

As with email verification, the default delivery behavior is temporary. Production applications should wire password
reset delivery into their own notification or mail layer.
