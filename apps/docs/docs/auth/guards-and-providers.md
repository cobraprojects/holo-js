# Guards And Providers

Guards and providers define how auth works for each part of your application.

## Introduction

- A guard decides how a request is authenticated.
- A provider decides which local model is used.

This separation lets you authenticate different models with different strategies.

Common examples:

- `web` session auth for `User`
- `admin` session auth for `Admin`
- `api` token auth for `User`

## Defining Guards

```ts
import { defineAuthConfig } from '@holo-js/config'

export default defineAuthConfig({
  defaults: {
    guard: 'web',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
    admin: {
      driver: 'session',
      provider: 'admins',
    },
    api: {
      driver: 'token',
      provider: 'users',
    },
  },
  providers: {
    users: { model: 'User', identifiers: ['email'] },
    admins: { model: 'Admin', identifiers: ['email'] },
  },
})
```

Supported guard drivers:

- `session`
- `token`

## Defining Providers

Providers stay intentionally small:

```ts
providers: {
  users: { model: 'User', identifiers: ['email'] },
  admins: { model: 'Admin', identifiers: ['email'] },
}
```

The provider points at the local model and declares which fields are auth identifiers.

Example:

```ts
providers: {
  users: {
    model: 'User',
    identifiers: ['email', 'phone'],
  },
}
```

That means auth may look users up by `email` or `phone`, while other fields on the user model remain plain profile
attributes.

## Using Multiple Guards

```ts
import auth from '@holo-js/auth'

await auth.guard('web').login({
  email: 'ava@example.com',
  password: 'secret-secret',
})

await auth.guard('admin').login({
  email: 'admin@example.com',
  password: 'admin-secret',
})
```

Each guard tracks its own authenticated state.

```ts
await auth.guard('web').user()
await auth.guard('admin').user()
await auth.guard('api').currentAccessToken()
```

## Default Guard

Named exports use the configured default guard:

```ts
import { check, login, logout, refreshUser, user } from '@holo-js/auth'
```

If the default guard is `web`, those operations resolve through `web` unless you explicitly choose another guard with
`auth.guard(name)`.

## Password Brokers

Password reset configuration is separate from guards and providers:

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

The default broker is selected from `defaults.passwords`.

## Hosted Identity Providers

Social login, WorkOS, and Clerk all resolve through guards and providers:

- social providers pick a guard or fall back to the default guard
- WorkOS picks a guard or falls back to the default guard
- Clerk picks a guard or falls back to the default guard

Each hosted identity still maps into a local provider model.
