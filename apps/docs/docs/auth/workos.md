# WorkOS

The WorkOS integration sends users to the hosted WorkOS AuthKit page to sign in or sign up, which gives you SSO, social login, and passkeys without building forms. When they come back, Holo saves the user in your own `users` table and signs them in with a normal Holo session, so `user()`, guards, and [authorization](/authorization/) work as usual.

## Install

```bash
npx holo install auth --workos
```

This adds `@holo-js/auth-workos`, a `workos` section in `config/auth.ts`, `.env` keys, and four routes:

| Route | Purpose |
| --- | --- |
| `GET /api/auth/workos/login` | Send the user to the WorkOS sign-in page |
| `GET /api/auth/workos/register` | Send the user to the WorkOS sign-up page |
| `GET /api/auth/workos/callback` | Finish sign-in and create the Holo session |
| `POST /api/auth/workos/logout` | Sign out of Holo and WorkOS |

Fill in the keys from your WorkOS dashboard:

```dotenv [.env]
AUTH_WORKOS_PROVIDER=dashboard
WORKOS_CLIENT_ID=client_...
WORKOS_API_KEY=sk_...
WORKOS_REDIRECT_URI=http://localhost:3000/api/auth/workos/callback
```

In the WorkOS dashboard:

1. Add `WORKOS_REDIRECT_URI` to the list of redirect URIs.
2. Set a sign-out redirect. That's where WorkOS sends users after logout.
3. Set the WorkOS session length to match your Holo `absoluteLifetime` (see [Sessions and Cookies](/auth/session-and-cookies#session-lifetime)), so users don't stay signed in to one after the other has expired.

Then link to the routes from your login page:

```html
<a href="/api/auth/workos/login">Continue with WorkOS</a>
<a href="/api/auth/workos/register">Sign up with WorkOS</a>
```

You don't configure a WorkOS cookie password or session cookie. Holo uses its own session cookie.

The short-lived cookie that checks the sign-in callback is marked `Secure` when the request is HTTPS or when `session.cookie.secure` is `true`. Behind a proxy that terminates TLS, the request counts as HTTPS only when the proxy is listed in [`trustedProxies`](/basics/security/cors-and-proxies#trusted-proxies).

## Configuration

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'

export default defineAuthConfig({
  workos: {
    provider: env('AUTH_WORKOS_PROVIDER', 'dashboard'),
    dashboard: {
      clientId: env('WORKOS_CLIENT_ID'),
      apiKey: env('WORKOS_API_KEY'),
      redirectUri: env('WORKOS_REDIRECT_URI'),
    },
  },
})
```

`dashboard` is a name you choose. You can define several WorkOS environments side by side; `provider` picks the default one, and every route function accepts `{ provider: 'name' }` to use another.

| Option | Description |
| --- | --- |
| `clientId` | WorkOS client ID |
| `apiKey` | WorkOS API key |
| `redirectUri` | Your callback URL |
| `guard` | Sign users in on this guard instead of the default. Must be a `session` guard |
| `mapToProvider` | Save users with this user provider instead of the guard's |

## The routes

The login, register, and logout routes return a ready-made `Response`, so they're one line each:

::: code-group

```ts [Next.js]
// app/api/auth/workos/login/route.ts
import { loginWithWorkos } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  return await loginWithWorkos(request)
}
```

```ts [Nuxt]
// server/api/auth/workos/login.get.ts
import { loginWithWorkos } from '@holo-js/auth-workos'

export default defineEventHandler(async (event) => {
  return await loginWithWorkos(event)
})
```

```ts [SvelteKit]
// src/routes/api/auth/workos/login/+server.ts
import { loginWithWorkos } from '@holo-js/auth-workos'
import type { RequestHandler } from './$types'

export const GET = (async (event) => {
  return await loginWithWorkos(event)
}) satisfies RequestHandler
```

:::

`registerWithWorkos()` and `logoutWithWorkos()` work the same way. The callback is the route you'll edit most, to choose where users land. The installed callback sends users to `/`; replace it with your own handler. (In Next.js, the installed `route.ts` files just re-export code from `.holo-js/generated`, so replace the file's contents rather than editing the generated file.)

::: code-group

```ts [Next.js]
// app/api/auth/workos/callback/route.ts
import { redirect } from 'next/navigation'
import { completeWorkosAuth } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  const { error } = await completeWorkosAuth(request)
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.code)}`)
  }

  redirect('/dashboard')
}
```

```ts [Nuxt]
// server/api/auth/workos/callback.get.ts
import { completeWorkosAuth } from '@holo-js/auth-workos'

export default defineEventHandler(async (event) => {
  const { error } = await completeWorkosAuth(event)
  if (error) {
    return sendRedirect(event, `/login?error=${encodeURIComponent(error.code)}`, 303)
  }

  return sendRedirect(event, '/dashboard', 303)
})
```

```ts [SvelteKit]
// src/routes/api/auth/workos/callback/+server.ts
import { redirect, type RequestHandler } from '@sveltejs/kit'
import { completeWorkosAuth } from '@holo-js/auth-workos'

export const GET = (async (event) => {
  const { error } = await completeWorkosAuth(event)
  if (error) {
    redirect(303, `/login?error=${encodeURIComponent(error.code)}`)
  }

  redirect(303, '/dashboard')
}) satisfies RequestHandler
```

:::

`completeWorkosAuth()` returns `{ data, error }`. On success, `data` has the local `user`, the `guard`, and a `status` of `'created'`, `'updated'`, `'linked'`, or `'relinked'`. On failure, `error` has a `code`, `message`, and `status`:

| Code | Status | Meaning |
| --- | --- | --- |
| `workos_state_mismatch` | 422 | The callback doesn't match the login that started it |
| `workos_code_required` | 422 | No authorization code in the callback |
| `workos_identity_conflict` | 409 | A local user already has this email (see below) |
| `workos_auth_failed` | 422 | Anything else, such as a rejected code |
| WorkOS's own `error` value | 422 | WorkOS sent the user back with an error |

## Log out

`logoutWithWorkos()` ends the Holo session and redirects to WorkOS to end the WorkOS session too. WorkOS then sends the user to the sign-out redirect from your dashboard. Pass `returnTo` to override it with a path on your own site:

```ts
return await logoutWithWorkos(request, { returnTo: '/goodbye' })
```

Holo ends the WorkOS session with the session ID WorkOS returns at sign-in. WorkOS always returns one, in the WorkOS session ID shape. Logout sends a stored value upstream only when it has the shape of a WorkOS session ID (`session_` followed by letters, digits, `_` or `-`). Any other stored value ends the local session only. If a response has none, sign-in fails with `workos_auth_failed` and no session is created, rather than sending the access token or authorization code to WorkOS in its place.

If the current session didn't come from WorkOS, it just redirects to `/`. Show the WorkOS logout button only for WorkOS users by checking `provider`:

```tsx
{auth.provider === 'workos' && (
  <form action="/api/auth/workos/logout" method="post">
    <button type="submit">Log out</button>
  </form>
)}
```

The regular `logout()` also works for WorkOS users. It signs them out of Holo only, so the next visit to the login route may sign them straight back in.

## Save extra user fields

By default Holo saves `email` and `name` on the local user. Pass a `user` function to `completeWorkosAuth()` to save more:

```ts
const { error } = await completeWorkosAuth(request, {
  user: (workosUser) => ({
    email: workosUser.email,
    name: workosUser.name,
    avatar: workosUser.profilePictureUrl ?? null,
    workos_organization_id: workosUser.organizationId ?? null,
  }),
})
```

The function runs on every sign-in, and Holo updates the local user when a value changes. If you leave out `email` or `name`, Holo fills them in. Make sure each field is a column on your model.

`workosUser` has `id`, `email`, `emailVerified`, `name` (from first and last name, falling back to the email), `firstName`, `lastName`, `profilePictureUrl`, `organizationId`, `externalId`, `metadata`, and `raw`.

## How users are matched

The first time a WorkOS user signs in, Holo creates a local user and links the WorkOS ID to it in `auth_identities`. Later sign-ins load that same user.

::: warning
If a local user with the same verified email already exists and isn't linked to WorkOS, Holo doesn't merge the accounts. The callback fails with `workos_identity_conflict`. This stops someone from taking over a password account through a hosted provider.
:::

When [email verification](/auth/email-verification) is required, WorkOS users must have a verified email, or sign-in fails.

## Store links in your own table

Holo keeps WorkOS links in `auth_identities`. To use another table, pass an object with `findByProviderUserId`, `findByUserId`, and `save` as `identityStore`:

```ts [config/auth.ts]
import { defineAuthConfig, type AuthHostedIdentityStore } from '@holo-js/auth'
import { externalIdentityStore } from '../server/lib/external-identities'

export default defineAuthConfig({
  workos: {
    provider: 'dashboard',
    identityStore: externalIdentityStore satisfies AuthHostedIdentityStore,
    dashboard: { /* ... */ },
  },
})
```

Each method reads or writes an `AuthHostedIdentityRecord`: `provider`, `providerUserId`, `guard`, `authProvider`, `userId`, `email`, `emailVerified`, `profile`, `linkedAt`, and `updatedAt`.

## Lower-level functions

`@holo-js/auth-workos` also exports `verifyRequest()`, `verifySession()`, `syncIdentity()`, and `authenticate()`, for when you already have a WorkOS session token and need to verify it or sync the user yourself.

## Next steps

- [Clerk](/auth/clerk)
- [Social Login](/auth/social-login)
- [Current User on the Client](/auth/current-user)
