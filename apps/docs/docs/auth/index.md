# Authentication

Authentication in Holo is built from a small set of composable packages:

- `@holo-js/session` for session state and cookie handling.
- `@holo-js/auth` for local user authentication, guards, providers, session auth, and personal access tokens.
- `@holo-js/auth-social` for the shared social sign-in runtime, plus one provider package per configured provider.
- `@holo-js/auth-workos` for hosted WorkOS identity synced into your local user model.
- `@holo-js/auth-clerk` for hosted Clerk identity synced into your local user model.

The application owns the route, request parsing, validation, and response shape. Holo exposes the authentication
operations and runtime services that your routes call.

## Server vs Client

`@holo-js/auth` is the server package.

Use it inside your server routes, actions, loaders, RPC handlers, jobs, and any other trusted backend code. It owns
operations that can create sessions, verify passwords, hash passwords, impersonate users, issue tokens, and mutate
auth state.

`@holo-js/auth/client` is the browser-friendly package.

Use it only to read current-auth state from your own endpoint. It does not expose login, trusted login, password
hashing, password verification, token creation, or impersonation helpers.

## Introduction

At the core of the auth system are two concepts: guards and providers.

- Guards define how an incoming request is authenticated.
- Providers define which local model a guard resolves into.

A session guard maintains login state using session storage and cookies. A token guard authenticates each request using
a personal access token. Both guards can point at different local models, such as `User` and `Admin`.

All auth flows resolve into a local model owned by your application. That includes:

- local email / phone / username login
- local session authentication
- personal access tokens
- social login
- WorkOS
- Clerk

This lets you keep one application-owned source of truth for users, admins, and any other model that participates in
authentication.

## Package Overview

Install only the packages you need:

```bash
npx holo install auth
npx holo install auth --social --provider google
npx holo install auth --social --provider github
npx holo install auth --social --provider google,github
npx holo install auth --workos
npx holo install auth --clerk
```

When `auth` is installed, `session` is installed with it automatically because session-backed auth depends on it.

## Authentication Quickstart

Start with the auth and session config files:

```ts
// config/auth.ts
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
      identifiers: ['email'],
    },
  },
})
```

```ts
// config/session.ts
import { defineSessionConfig } from '@holo-js/config'

export default defineSessionConfig({
  driver: 'database',
  cookie: {
    name: 'holo_session',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  },
})
```

Then use auth operations inside your own routes:

```ts
import { login, logout, refreshUser, register, user } from '@holo-js/auth'

export async function POST(request: Request) {
  const body = await request.json()

  const created = await register({
    name: body.name,
    email: body.email,
    password: body.password,
    passwordConfirmation: body.passwordConfirmation,
  })

  return Response.json(created, { status: 201 })
}

export async function PUT(request: Request) {
  const body = await request.json()

  await login({
    email: body.email,
    password: body.password,
    remember: body.remember === true,
  })

  return Response.json({
    authenticated: true,
    user: await refreshUser(),
  })
}

export async function DELETE() {
  await logout()

  return Response.json({
    authenticated: false,
    user: await user(),
  })
}
```

## Retrieving The Authenticated User

Use the default export or direct named exports:

```ts
import auth, { check, id, refreshUser, user } from '@holo-js/auth'

const authenticated = await check()
const currentUser = await user()
const currentUserId = await id()
const freshUser = await refreshUser()
const adminUser = await auth.guard('admin').user()
```

`user()` may return the current cached auth state for the active request context. `refreshUser()` forces a fresh model
lookup for the selected guard.

## Protecting Routes

Holo does not inject opinionated framework routes or route middleware for you. Route protection stays in your
application code.

```ts
import { check } from '@holo-js/auth'

export async function GET() {
  if (!(await check())) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  return Response.json({ ok: true })
}
```

To protect a non-default guard:

```ts
import auth from '@holo-js/auth'

export async function GET() {
  if (!(await auth.guard('admin').check())) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  return Response.json({ ok: true })
}
```

## Manual Authentication

Manual authentication is the normal Holo flow. Your application validates the request first, then passes the validated
payload to `login()` or `register()`.

```ts
import { login } from '@holo-js/auth'

await login({
  email: 'ava@example.com',
  password: 'secret-secret',
})
```

The auth runtime uses the validated payload itself. If your credentials are based on `phone`, pass `phone`.

```ts
await login({
  phone: '20123456789',
  password: 'secret-secret',
})
```

This keeps credential validation in your application and keeps auth configuration focused on guards and providers
instead of request field mapping.

## Logging Out

Session logout:

```ts
import { logout } from '@holo-js/auth'

const signedOut = await logout()
```

Guard-specific logout:

```ts
import auth from '@holo-js/auth'

const signedOut = await auth.guard('admin').logout()
```

`logout()` is still the only user-facing API. It clears the selected Holo auth guard and returns serialized
forget-cookie headers in `signedOut.cookies`.

When the guard is backed by Clerk or WorkOS, the same `logout()` call also clears the configured hosted-provider session
cookie for that guard so the next request does not transparently re-authenticate from the hosted cookie alone.

Token logout and revocation are covered in the personal access token guide.

## Choosing A Flow

Use session auth when:

- the request comes from your browser-based application
- you want cookie-based login state
- you want remember-me behavior

Use personal access tokens when:

- a mobile client or external client needs stateless API access
- the request will include a bearer token
- you want token abilities

Use WorkOS or Clerk when:

- the identity system is hosted remotely
- your application still needs a local user or admin model
- the local model should be synchronized from the hosted identity

Use social login when:

- the local user model is still canonical
- the user signs in through an OAuth provider
- the external identity should link into your local user model

## Next Steps

- [Session And Cookies](/auth/session-and-cookies)
- [Local Auth](/auth/local-auth)
- [Guards And Providers](/auth/guards-and-providers)
- [Personal Access Tokens](/auth/personal-access-tokens)
- [Social Login](/auth/social-login)
- [WorkOS](/auth/workos)
- [Clerk](/auth/clerk)
- [Email Verification](/auth/email-verification)
- [Password Reset](/auth/password-reset)
- [Current Auth Client](/auth/current-auth-client)
