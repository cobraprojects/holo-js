# Personal Access Tokens

Personal access tokens provide stateless API authentication for token guards.

## Introduction

Use a token guard when requests are authenticated by a bearer token instead of a session cookie.

```ts
guards: {
  api: {
    driver: 'token',
    provider: 'users',
  },
}
```

Tokens are created in plain text once, hashed at rest, and validated on each incoming request.

## Token Login

Use the token guard's normal `login()` method when a user submits credentials and the response should be a bearer token
instead of a session cookie:

```ts
import auth from '@holo-js/auth'

const { data: token, error } = await auth.guard('api').login({
  email: 'ava@example.com',
  password: 'secret-secret',
  abilities: ['orders.read'],
})

if (error) {
  return Response.json({
    ok: false,
    message: 'Invalid credentials.',
  }, { status: 401 })
}

return Response.json({
  ok: true,
  token: token.plainTextToken,
  tokenId: token.id,
  abilities: token.abilities,
}, {
  headers: {
    'Cache-Control': 'no-store',
  },
})
```

For token guards, `auth.guard('api').login(...)` verifies the credentials, creates a personal access token for the
authenticated user, and returns the token result.

## Token Registration

Use `register()` on a token guard when the registration response should immediately return a bearer token:

```ts
import auth from '@holo-js/auth'

const { data: token, error } = await auth.guard('api').register({
  name: 'Ava',
  email: 'ava@example.com',
  password: 'secret-secret',
  passwordConfirmation: 'secret-secret',
  abilities: ['orders.read'],
})

if (error) {
  return Response.json(error, { status: error.status })
}

return Response.json({
  ok: true,
  token: token.plainTextToken,
  tokenId: token.id,
  abilities: token.abilities,
}, {
  headers: {
    'Cache-Control': 'no-store',
  },
})
```

For session guards, `login()` and `register()` still return session results. For token guards, they return personal
access token results. TypeScript infers the guard driver from `config/auth.ts` through the generated `holo prepare`
types, so `auth.guard('api')` is token-backed when the `api` guard uses `driver: 'token'`.

## Sending Tokens On Requests

Send the token on protected API requests with the standard `Authorization` header:

```ts
await fetch('/api/v1/orders', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
})
```

Framework adapters read the bearer token from the request and make it available to the selected token guard. Server
routes can then use the normal guard APIs:

```ts
import auth from '@holo-js/auth'

export async function GET() {
  const currentUser = await auth.guard('api').user()

  if (!currentUser) {
    return Response.json({ ok: false, message: 'Unauthenticated.' }, { status: 401 })
  }

  if (!currentUser.can('orders.read')) {
    return Response.json({ ok: false, message: 'Forbidden.' }, { status: 403 })
  }

  const token = await auth.guard('api').currentAccessToken()

  return Response.json({
    ok: true,
    userId: currentUser.id,
    abilities: token?.abilities ?? [],
  })
}
```

The ability check should match the abilities you issue during token creation. In the login example above, the token gets
`orders.read`, so routes that expose order data should call `currentUser.can('orders.read')` before returning it. The
current token also exposes `token.can('orders.read')` when the route needs to inspect the token directly. A token with
`*` passes individual ability checks.

`check()` follows the same guard context:

```ts
if (!await auth.guard('api').check()) {
  return Response.json({ ok: false, message: 'Unauthenticated.' }, { status: 401 })
}
```

## Manual Token Creation

Use the lower-level `tokens.create(...)` API when the user is already authenticated or trusted and your application
needs to issue a token manually, such as from an account settings screen.

```ts
import { tokens } from '@holo-js/auth'

const created = await tokens.create(user, {
  name: 'mobile-app',
  abilities: ['orders.read'],
})
```

The result contains:

- token metadata
- `plainTextToken`

Show the plain text token to the user immediately after creation. The unhashed secret should be treated as write-only.

## Manual Token Authentication

```ts
import { tokens } from '@holo-js/auth'

const actor = await tokens.authenticate(created.plainTextToken)
```

The runtime validates the token id and secret, updates `lastUsedAt`, and resolves the local user model.

Most framework routes should use `auth.guard('api').user()` or `auth.guard('api').check()` instead. Use
`tokens.authenticate(...)` when you are outside a Holo request context or implementing a custom token transport.

## Token Abilities

```ts
await tokens.can(created.plainTextToken, 'orders.read')
await tokens.can(created.plainTextToken, 'orders.write')
```

Abilities can be:

- explicit abilities such as `orders.read`
- `*` for full access

## Listing Tokens

```ts
const allTokens = await tokens.list(user)
```

Use this when showing token management screens in your application.

## Revoking The Current Token

The current token should be revoked from the authenticated request context.

```ts
import auth from '@holo-js/auth'

const current = await auth.guard('api').currentAccessToken()
await current?.delete()
```

The facade helper is also available:

```ts
import { tokens } from '@holo-js/auth'

await tokens.revoke({ guard: 'api' })
```

This revokes the currently authenticated token for the selected token guard.

## Revoking All Tokens For A User

```ts
await tokens.revokeAll(user)
await tokens.revokeAll(user, { guard: 'api' })
```

Use this when a user rotates credentials, reports account compromise, or signs out from all token-based clients.

## Current Access Token

The current token is only available on token guards:

```ts
import auth, { currentAccessToken } from '@holo-js/auth'

await currentAccessToken()
await auth.guard('api').currentAccessToken()
```

On a session guard, this resolves to `null`.
