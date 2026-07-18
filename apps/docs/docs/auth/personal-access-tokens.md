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

const token = await auth.guard('api').login({
  email: 'ava@example.com',
  password: 'secret-secret',
})

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
authenticated user, and returns the token result. Token abilities are chosen by trusted server configuration or by
explicit server-side token creation, not by the login request body.

Invalid token-guard credentials throw a `ValidationException` with status `401`. Handle it through the Forms adapter
or serialize it at the API boundary with `isValidationException(error)` and `error.toJSON()`.

When no token abilities are provided by the server, personal access tokens use the configured default abilities. The
default is `['*']`. Set `personalAccessTokens.defaultAbilities` to `[]` when a token should receive no scopes unless
server code grants them explicitly.

## Token Registration

Use `register()` on a token guard when the registration response should immediately return a bearer token:

```ts
import auth from '@holo-js/auth'

const token = await auth.guard('api').register({
  name: 'Ava',
  email: 'ava@example.com',
  password: 'secret-secret',
  passwordConfirmation: 'secret-secret',
})

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

For session guards, `login()` returns an established session and `register()` returns the created user. For token guards,
both operations return personal access token results. TypeScript infers the guard driver from `config/auth.ts` through
generated discovery types, so `auth.guard('api')` is token-backed when the `api` guard uses `driver: 'token'`.
Run `npx holo prepare` after changing guard configuration so those generated types stay current.

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
import Order from '@/server/models/Order'

export async function GET() {
  const currentUser = await auth.guard('api').user()

  if (!currentUser) {
    return Response.json({ ok: false, message: 'Unauthenticated.' }, { status: 401 })
  }

  if (!await currentUser.can('viewAny', Order)) {
    return Response.json({ ok: false, message: 'Forbidden.' }, { status: 403 })
  }

  const token = await auth.guard('api').currentAccessToken()

  if (!token?.can('orders.read')) {
    return Response.json({ ok: false, message: 'Token scope missing.' }, { status: 403 })
  }

  return Response.json({
    ok: true,
    userId: currentUser.id,
    abilities: token?.abilities ?? [],
  })
}
```

`currentUser.can(action, target)` runs the same authorization policy check as `authorization.forUser(user).can(action,
target)`. Token scope checks belong on the current token handle through `token.can('orders.read')`. A token with `*`
passes individual token scope checks.

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
- prefix wildcards such as `orders.*`
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
