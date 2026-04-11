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
`register()` are matched against the provider's configured `identifiers`.

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
      identifiers: ['email'],
    },
  },
  emailVerification: {
    required: false,
  },
})
```

## Identifiers

Identifiers are the fields auth uses to find and de-duplicate users.

Examples of identifiers:

- `email`
- `phone`
- `username`

Examples of fields that are usually not identifiers:

- `name`
- `country`
- `dob`
- `avatar`

If your users sign in with either email or phone, configure both:

```ts
providers: {
  users: {
    model: 'User',
    identifiers: ['email', 'phone'],
  },
}
```

That means:

- `login({ email, password })` looks up by email
- `login({ phone, password })` looks up by phone
- `register(...)` checks for duplicates on `email` and `phone`
- profile fields like `country` and `dob` are stored on the user record but are not used as auth identifiers

## Database Preparation

The local model should have at least:

- a primary key
- a password column
- a unique constraint or unique index for every configured identifier column
- an `email_verified_at` column when email verification is enabled

If you configure:

```ts
identifiers: ['email', 'phone']
```

then both `email` and `phone` should be unique in your database schema.

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
  phone: body.phone,
  country: body.country,
  dob: body.dob,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

The local provider creates the model record and hashes the password before it is stored. Extra fields like `country`
and `dob` are saved as attributes, but they are not treated as auth identifiers unless you explicitly add them to the
provider's `identifiers`.

If your application uses another identifier, pass that identifier instead:

```ts
await register({
  phone: body.phone,
  country: body.country,
  password: body.password,
  passwordConfirmation: body.passwordConfirmation,
})
```

## Logging In Users

These APIs are server-side APIs from `@holo-js/auth`. They are not available from `@holo-js/auth/client`.

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

## Signing In Trusted Users

Use trusted login when your application has already resolved the user and should establish a local session without
password verification.

This is a server-only capability. It changes authenticated state and writes session cookies, so it belongs in trusted
backend code only.

```ts
import auth, { loginUsing, loginUsingId } from '@holo-js/auth'

await loginUsing(user, { remember: true })
await loginUsingId(user.id)
await auth.guard('admin').loginUsing(adminUser)
await auth.guard('web').loginUsingId(invitedUserId)
```

This is the right fit for:

- social or hosted identity callbacks
- magic-link or invite flows
- admin-created accounts that should be signed in immediately
- impersonation features where an already trusted actor may assume another local session

`loginUsing()` and `loginUsingId()` trust the user resolution you already performed. They do not verify a password or
enforce email verification checks on their own.

That distinction matters:

- use `login()` when the user is proving identity with credentials now
- use `loginUsing()` when your application already proved identity some other way

Examples of `loginUsing()`:

- after a social provider callback already resolved the local user
- after a magic-link token or invite token was validated
- after an admin created a user and intentionally wants to sign them in
- inside an impersonation flow where an authenticated actor is allowed to assume another session

## Password Helpers

Use the public password helpers when you need to hash or verify passwords outside the built-in register and reset
flows.

These are also server-only helpers. They use your configured auth password hasher.

```ts
import { hashPassword, needsPasswordRehash, verifyPassword } from '@holo-js/auth'

const digest = await hashPassword(body.password)
const matches = await verifyPassword(body.password, digest)
const rotateHash = await needsPasswordRehash(digest)
```

This is useful when:

- seeding or importing local users manually
- storing password history rows in another table
- validating custom password change flows before saving a new digest

### `hashPassword(password)`

Use this when you need a password digest but you are not going through `register()` or `passwords.consume()`.

Typical cases:

- importing users from another system into your local `users` table
- writing your own admin-only “create user” flow
- storing a new password digest in a password-history table

### `verifyPassword(password, digest)`

Use this when you need to check a plaintext password against an existing stored digest.

Typical cases:

- custom password change forms that require the current password first
- checking a new password against rows in `password_history`
- validating imported or manually-created password digests

### `needsPasswordRehash(digest)`

This helper answers one question:

"Was this password hash created with old hashing settings, so it should be replaced the next time the user proves
their password?"

Today the default hasher returns `false`, but the helper is still important because custom or future hashers may decide
that an older digest should be upgraded.

Why that matters:

- you may increase hashing cost later
- you may change hash format or parameters later
- you may migrate from one algorithm policy to another without forcing every user to reset their password

The usual pattern is:

1. call `verifyPassword(plain, digest)`
2. if it succeeds, call `needsPasswordRehash(digest)`
3. if that returns `true`, hash the plaintext again with `hashPassword(plain)` and store the new digest

That lets you upgrade password hashes gradually on successful login or password confirmation instead of doing a risky
one-time migration.

Example:

```ts
const currentDigest = account.password
const matches = await verifyPassword(body.currentPassword, currentDigest)

if (!matches) {
  throw new Error('Current password is invalid.')
}

if (await needsPasswordRehash(currentDigest)) {
  account.password = await hashPassword(body.currentPassword)
  await account.save()
}
```

## Impersonating Users

Impersonation establishes a trusted local session for another user while remembering who the actor was.

This is a server-only admin capability. It should be protected by your own authorization rules before calling it.

```ts
import auth, { impersonate, impersonateById, impersonation, stopImpersonating } from '@holo-js/auth'

await impersonate(user)
await impersonateById(user.id)
await auth.guard('web').impersonateById(user.id, { actorGuard: 'admin' })

const active = await impersonation()
await stopImpersonating()
```

Use `actorGuard` when the authenticated actor lives on a different guard than the user being impersonated, such as an
admin on `admin` impersonating an application user on `web`.

What each helper is for:

- `impersonate(user)`:
  You already resolved the target model.
- `impersonateById(id)`:
  You only have the target primary key.
- `impersonation()`:
  Inspect whether the current guard is impersonating and who the actor/original user are.
- `stopImpersonating()`:
  Return to the original session when one existed, or clear the impersonated guard when it did not.

Typical flow:

1. authenticate an admin on `admin`
2. authorize that admin to impersonate users
3. call `auth.guard('web').impersonateById(userId, { actorGuard: 'admin' })`
4. show an impersonation banner in your app using `impersonation()`
5. call `stopImpersonating()` to restore the previous state

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

const signedOut = await logout()
```

Or for another guard:

```ts
import auth from '@holo-js/auth'

const signedOut = await auth.guard('admin').logout()
```

`logout()` is server-only for the same reason `login()` is server-only: it changes authenticated state and emits cookie
headers. The returned `signedOut.cookies` array contains serialized forget-cookie headers for the route layer when it
needs them.

If the selected guard is associated with Clerk or WorkOS, `logout()` also clears that provider's configured session
cookie behind the same API. Applications do not need a separate `logoutFromClerk()` or `logoutFromWorkos()` helper.

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
