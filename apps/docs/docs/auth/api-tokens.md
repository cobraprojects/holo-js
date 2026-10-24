# API Tokens

API tokens (personal access tokens) authenticate requests with an `Authorization: Bearer` header instead of a cookie. Use them for mobile apps, CLIs, and other clients that can't keep a browser session. Holo shows each token once, stores only a hash, and lets you limit what a token can do.

## Add a token guard

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  guards: {
    web: { driver: 'session', provider: 'users' },
    api: { driver: 'token', provider: 'users' },
  },
  personalAccessTokens: {
    defaultAbilities: [],
  },
})
```

Tokens live in the `personal_access_tokens` table, which the auth migrations create. Run `npx holo prepare` after adding the guard so `auth.guard('api')` is typed as a token guard.

## Issue a token at login

On a token guard, `login()` checks the credentials and returns a new token instead of setting a cookie:

::: code-group

```ts [Next.js]
// app/api/v1/tokens/route.ts
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const input = await validate(request, loginForm, { throttle: 'login' })

  const token = await auth.guard('api').login(input)

  return Response.json({
    token: token.plainTextToken,
    abilities: token.abilities,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
```

```ts [Nuxt]
// server/api/v1/tokens.post.ts
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, { throttle: 'login' })

  const token = await auth.guard('api').login(input)

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    token: token.plainTextToken,
    abilities: token.abilities,
  }
})
```

```ts [SvelteKit]
// src/routes/api/v1/tokens/+server.ts

import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '#lib/schemas/auth.js'

export async function POST({ request }: { request: Request }) {
  const input = await validate(request, loginForm, { throttle: 'login' })

  const token = await auth.guard('api').login(input)

  return Response.json({
    token: token.plainTextToken,
    abilities: token.abilities,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
```

:::

Wrong credentials throw a `ValidationException` with status `401` and the message on `_root`. `auth.guard('api').register(input)` works the same way: it creates the user and returns a token.

::: warning
`plainTextToken` is the only time you can see the secret. Return it once, with `Cache-Control: no-store`, and never log it.
:::

If your app has CSRF protection on, exclude token routes in `config/security.ts` (for example `except: ['/api/v1/*']`). Bearer requests don't send the CSRF cookie. See [CSRF Protection](/basics/security/csrf).

## Authenticate requests

Clients send the token in the `Authorization` header:

```ts
await fetch('/api/v1/orders', {
  headers: { Authorization: `Bearer ${token}` },
})
```

Holo reads the header for you. Use the guard as usual in your route:

```ts [app/api/v1/orders/route.ts]
import auth from '@holo-js/auth'

export async function GET() {
  const currentUser = await auth.guard('api').user()
  if (!currentUser) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  const token = await auth.guard('api').currentAccessToken()
  if (!token?.can('orders.read')) {
    return Response.json({ message: 'Token scope missing.' }, { status: 403 })
  }

  return Response.json({ userId: currentUser.id })
}
```

To make `api` the guard used by `user()` and `check()` everywhere, set `defaults.guard: 'api'`.

## Limit what a token can do

Each token has a list of abilities (scopes). Tokens from `login()` and `register()` get `personalAccessTokens.defaultAbilities`. The default is `['*']`, which allows everything; set it to `[]` so tokens can do nothing until you grant abilities on purpose.

| Ability | Matches |
| --- | --- |
| `'orders.read'` | Exactly `orders.read` |
| `'orders.*'` | `orders.read`, `orders.write`, and anything else starting with `orders.` |
| `'*'` | Everything |

Check abilities on the current token with `token.can()`, or on any token string with `tokens.can()`:

```ts
import { tokens } from '@holo-js/auth'

const allowed = await tokens.can(plainTextToken, 'orders.write')
```

Token abilities limit the token. They don't replace [authorization](/authorization/): check both. A signed-in user also has `currentUser.can(action, target)`, which runs your [policies](/authorization/policies).

## Create tokens from your app

Use `tokens.create()` for an "API keys" settings page, where the signed-in user names a token and picks its abilities:

```ts
import { tokens, user } from '@holo-js/auth'

const currentUser = await user()

const created = await tokens.create(currentUser, {
  name: 'Deploy script',
  abilities: ['deployments.create'],
  expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
})
```

| Option | Description |
| --- | --- |
| `name` | Label shown in your UI |
| `abilities` | Defaults to `personalAccessTokens.defaultAbilities` |
| `expiresAt` | Optional `Date`. The token stops working after it |
| `guard` | Store the token for this guard's provider. Without it, Holo uses the provider the user came from |

`tokens.list(user)` returns the user's tokens with `id`, `name`, `abilities`, `createdAt`, `lastUsedAt`, and `expiresAt`. The secret can't be recovered; only its hash is stored.

## Revoke tokens

```ts
import auth, { tokens } from '@holo-js/auth'

await auth.guard('api').logout()

const revokedOthers = await tokens.revokeOthers({ guard: 'api' })

const revokedAll = await tokens.revokeAll(user, { guard: 'api' })
```

- `logout()` on a token guard deletes the token used for this request. Other tokens keep working.
- `tokens.revoke({ guard })` does the same, and `(await auth.guard('api').currentAccessToken())?.delete()` is a third way.
- `tokens.revokeOthers({ guard })` deletes every token of the current user except the one making the request, and returns how many it removed.
- `tokens.revokeAll(user, { guard })` deletes all of a user's tokens, for example after a password change.

Revoking tokens never signs out browser sessions. For those, use [`logoutOtherDevices()`](/auth/session-and-cookies#log-out-other-devices).

## Authenticate a token yourself

Outside a request, for example in a WebSocket handshake or a job, resolve a token string directly:

```ts
import { tokens } from '@holo-js/auth'

const tokenUser = await tokens.authenticate(plainTextToken)
```

It returns the user or `null`, and updates the token's `lastUsedAt`.

## Reference

| Function | Description |
| --- | --- |
| `auth.guard('api').login(credentials)` | Check credentials and return a new token |
| `auth.guard('api').register(input)` | Create a user and return a new token |
| `auth.guard('api').currentAccessToken()` | The request's token, with `can(ability)` and `delete()`. `null` on session guards |
| `currentAccessToken()` | Same, for the default guard |
| `tokens.create(user, options)` | Create a token |
| `tokens.list(user, { guard? })` | List a user's tokens |
| `tokens.can(token, ability)` | Check an ability on a token string |
| `tokens.authenticate(token)` | Resolve a token string to its user |
| `tokens.revoke({ guard? })` | Delete the request's token |
| `tokens.revokeOthers({ guard? })` | Delete the user's other tokens |
| `tokens.revokeAll(user, { guard? })` | Delete all of a user's tokens |

The token result from `login()`, `register()`, and `create()` has `id`, `name`, `abilities`, `createdAt`, `expiresAt`, and `plainTextToken`.

## Next steps

- [Guards and Providers](/auth/guards-and-providers)
- [Authorization](/authorization/)
- [CORS and Proxies](/basics/security/cors-and-proxies)
