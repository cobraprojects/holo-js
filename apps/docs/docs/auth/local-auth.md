# Local Authentication

This guide covers local auth backed by your application-owned models and database tables.

## Introduction

Local auth is the default auth flow for self-hosted applications. It provides:

- a local `User` model and migration story
- session-based authentication
- personal access tokens
- remember-me support
- local password hashing and verification
- optional email verification and password reset flows

The package does not require hardcoded request fields such as `email`. The credentials you pass to `login()` and
`register()` are the credentials used by the provider lookup.

## Configuration

Define a session guard and a provider:

```ts
import { defineAuthConfig } from '@holo-js/config'

export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
    api: {
      driver: 'token',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
  emailVerification: {
    required: false,
  },
})
```

## Database Preparation

The local model should have at least:

- a primary key
- a password column
- an `email_verified_at` column when email verification is enabled

The installer generates the related auth tables:

- `users`
- `sessions`
- `auth_identities`
- `personal_access_tokens`
- `password_reset_tokens`
- `email_verification_tokens`

## Registering Users

Use `register()` inside your route after validation succeeds:

```ts
import { register } from '@holo-js/auth'

const created = await register({
  name: body.name,
  email: body.email,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

The local provider creates the model record and hashes the password before it is stored.

If your application uses another identifier, pass that identifier instead:

```ts
await register({
  phone: body.phone,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

## Logging In Users

```ts
import { login } from '@holo-js/auth'

await login({
  email: body.email,
  password: body.password,
  remember: body.remember === true,
})
```

On successful login, the session guard:

- invalidates the previous active session for that guard
- creates a new session
- stores the authenticated user payload in session state
- optionally issues a remember-me token

## Remembering Users

Set `remember: true` during login:

```ts
await login({
  email: body.email,
  password: body.password,
  remember: true,
})
```

Remember-me lifetime is controlled by the session config.

## Retrieving User State

```ts
import auth, { check, id, refreshUser, user } from '@holo-js/auth'

await check()
await user()
await refreshUser()
await id()
await auth.guard('admin').user()
```

Use `refreshUser()` when the local model may have changed during the request lifecycle and you need a fresh record.

## Logging Out

```ts
import { logout } from '@holo-js/auth'

await logout()
```

Or for another guard:

```ts
import auth from '@holo-js/auth'

await auth.guard('admin').logout()
```

## Route Integration

Your framework route owns parsing and response formatting. The auth package only performs auth operations.

```ts
import { login } from '@holo-js/auth'

export async function POST(request: Request) {
  const body = await request.json()

  await login({
    email: body.email,
    password: body.password,
  })

  return Response.json({ ok: true })
}
```

## Related Guides

- [Session And Cookies](/auth/session-and-cookies)
- [Guards And Providers](/auth/guards-and-providers)
- [Personal Access Tokens](/auth/personal-access-tokens)
- [Email Verification](/auth/email-verification)
- [Password Reset](/auth/password-reset)
