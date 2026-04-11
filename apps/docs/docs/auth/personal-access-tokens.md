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

## Creating Tokens

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

## Sending Tokens On Requests

The application should pass the token as a bearer token or another transport of its choice, then assign it to the
token guard context before using the auth runtime for that request.

## Authenticating Tokens

```ts
import { tokens } from '@holo-js/auth'

const actor = await tokens.authenticate(created.plainTextToken)
```

The runtime validates the token id and secret, updates `lastUsedAt`, and resolves the local user model.

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
