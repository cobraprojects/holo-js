# Clerk

The Clerk integration sends users to Clerk's hosted Account Portal to sign in or sign up. When they come back, Holo checks the Clerk session, saves the user in your own `users` table, and signs them in with a normal Holo session, so `user()`, guards, and [authorization](/authorization/) work as usual.

## Install

```bash
npx holo install auth --clerk
```

This adds `@holo-js/auth-clerk`, a `clerk` section in `config/auth.ts`, `.env` keys, and four routes:

| Route | Purpose |
| --- | --- |
| `GET /api/auth/clerk/login` | Send the user to the Clerk sign-in page |
| `GET /api/auth/clerk/register` | Send the user to the Clerk sign-up page |
| `GET /api/auth/clerk/callback` | Finish sign-in and create the Holo session |
| `POST /api/auth/clerk/logout` | Sign out of Holo and revoke the Clerk session |

Fill in the keys from the Clerk dashboard:

```dotenv [.env]
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_API_URL=
CLERK_FRONTEND_API=https://steady-newt-5.clerk.accounts.dev
CLERK_REDIRECT_URI=http://localhost:3000/api/auth/clerk/callback
CLERK_SESSION_COOKIE=__session
```

| Variable | Required | Value |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | yes | From the API keys page |
| `CLERK_SECRET_KEY` | yes | From the API keys page. Also used to revoke sessions on logout |
| `CLERK_FRONTEND_API` | yes | Your Frontend API URL, from the domains settings |
| `CLERK_REDIRECT_URI` | yes | Your callback URL, as a full URL |
| `CLERK_API_URL` | no | Only for a custom Clerk API base URL |
| `CLERK_SESSION_COOKIE` | no | Clerk's session cookie name, if it isn't `__session` |

In the Clerk dashboard, turn on the **Account Portal**. Holo builds the portal URL from `CLERK_FRONTEND_API` (for example `https://steady-newt-5.clerk.accounts.dev` becomes `https://steady-newt-5.accounts.dev`, and `https://clerk.example.com` becomes `https://accounts.example.com`). It opens `/sign-in` or `/sign-up` with `CLERK_REDIRECT_URI` as the return address, so you don't set a portal URL yourself.

The Account Portal's own fallback redirects are only used when someone visits Clerk's pages directly.

Then link to the routes from your login page:

```html
<a href="/api/auth/clerk/login">Continue with Clerk</a>
<a href="/api/auth/clerk/register">Sign up with Clerk</a>
```

## Configuration

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'

export default defineAuthConfig({
  clerk: {
    provider: env('AUTH_CLERK_PROVIDER', 'app'),
    app: {
      publishableKey: env('CLERK_PUBLISHABLE_KEY'),
      secretKey: env('CLERK_SECRET_KEY'),
      apiUrl: env('CLERK_API_URL'),
      frontendApi: env('CLERK_FRONTEND_API'),
      redirectUri: env('CLERK_REDIRECT_URI'),
      sessionCookie: env('CLERK_SESSION_COOKIE', '__session'),
    },
  },
})
```

`app` is a name you choose. You can define several Clerk instances side by side; `provider` picks the default one, and every route function accepts `{ provider: 'name' }` to use another.

| Option | Default | Description |
| --- | --- | --- |
| `publishableKey`, `secretKey` | | Clerk API keys |
| `frontendApi` | | Frontend API URL |
| `redirectUri` | | Callback URL. Must be a full URL |
| `apiUrl` | Clerk's API | Custom Backend API base URL |
| `sessionCookie` | `'__session'` | Clerk session cookie name |
| `authorizedParties` | `[]` | Origins allowed to have issued the Clerk session tokens that this app accepts. The origin of `redirectUri` is always allowed. Holo never takes an origin from the request's `Host` header, so a session token issued for another app on the same Clerk instance is rejected. With neither set, Clerk sessions are rejected, so set `redirectUri` or list your origin here |
| `guard` | default guard | Sign users in on this guard. Must be a `session` guard |
| `mapToProvider` | the guard's provider | Save users with this user provider |

## The routes

The login, register, and logout routes return a ready-made `Response`, so they're one line each:

::: code-group

```ts [Next.js]
// app/api/auth/clerk/login/route.ts
import { loginWithClerk } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  return await loginWithClerk(request)
}
```

```ts [Nuxt]
// server/api/auth/clerk/login.get.ts
import { loginWithClerk } from '@holo-js/auth-clerk'

export default defineEventHandler(async (event) => {
  return await loginWithClerk(event)
})
```

```ts [SvelteKit]
// src/routes/api/auth/clerk/login/+server.ts
import { loginWithClerk } from '@holo-js/auth-clerk'
import type { RequestHandler } from './$types'

export const GET = (async (event) => {
  return await loginWithClerk(event)
}) satisfies RequestHandler
```

:::

`registerWithClerk()` and `logoutWithClerk()` work the same way. The installed callback sends users to `/`; replace it with your own handler to choose where they land. (In Next.js, the installed `route.ts` files just re-export code from `.holo-js/generated`, so replace the file's contents rather than editing the generated file.)

::: code-group

```ts [Next.js]
// app/api/auth/clerk/callback/route.ts
import { redirect } from 'next/navigation'
import { completeClerkAuth } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  const { error } = await completeClerkAuth(request)
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.code)}`)
  }

  redirect('/dashboard')
}
```

```ts [Nuxt]
// server/api/auth/clerk/callback.get.ts
import { completeClerkAuth } from '@holo-js/auth-clerk'

export default defineEventHandler(async (event) => {
  const { error } = await completeClerkAuth(event)
  if (error) {
    return sendRedirect(event, `/login?error=${encodeURIComponent(error.code)}`, 303)
  }

  return sendRedirect(event, '/dashboard', 303)
})
```

```ts [SvelteKit]
// src/routes/api/auth/clerk/callback/+server.ts
import { redirect, type RequestHandler } from '@sveltejs/kit'
import { completeClerkAuth } from '@holo-js/auth-clerk'

export const GET = (async (event) => {
  const { error } = await completeClerkAuth(event)
  if (error) {
    redirect(303, `/login?error=${encodeURIComponent(error.code)}`)
  }

  redirect(303, '/dashboard')
}) satisfies RequestHandler
```

:::

`completeClerkAuth()` returns `{ data, error }`. On success, `data` has the local `user`, the `guard`, and a `status` of `'created'`, `'updated'`, `'linked'`, or `'relinked'`. On failure, `error` has a `code`, `message`, and `status`:

| Code | Status | Meaning |
| --- | --- | --- |
| `clerk_session_required` | 422 | The request has no active Clerk session |
| `clerk_identity_conflict` | 409 | A local user already has this email (see below) |
| `clerk_auth_failed` | 422 | Anything else |
| Clerk's own `error` value | 422 | Clerk sent the user back with an error |

## Log out

`logoutWithClerk()` revokes the Clerk session through Clerk's Backend API, ends the Holo session, and redirects. By default it redirects to `/`; pass `returnTo` to pick another path on your own site:

```ts
return await logoutWithClerk(request, { returnTo: '/login' })
```

Addresses on other sites are ignored. If the current session didn't come from Clerk, it just redirects to `/`. Show the Clerk logout button only for Clerk users by checking `provider`:

```tsx
{auth.provider === 'clerk' && (
  <form action="/api/auth/clerk/logout" method="post">
    <button type="submit">Log out</button>
  </form>
)}
```

The regular `logout()` also works for Clerk users. It ends the Holo session and clears Clerk's session cookie, but doesn't revoke the session at Clerk.

## Save extra user fields

By default Holo saves `email` and `name` on the local user. Pass a `user` function to `completeClerkAuth()` to save more:

```ts
const { error } = await completeClerkAuth(request, {
  user: (clerkUser) => ({
    email: clerkUser.email,
    name: clerkUser.name,
    avatar: clerkUser.imageUrl ?? null,
  }),
})
```

The function runs on every sign-in, and Holo updates the local user when a value changes. If you leave out `email` or `name`, Holo fills them in. Make sure each field is a column on your model.

`clerkUser` has `id`, `email` (the primary address), `emailVerified`, `name` (from first and last name, falling back to the email), `firstName`, `lastName`, `imageUrl`, `primaryEmailAddressId`, `emailAddresses`, and `raw`.

## How users are matched

The first time a Clerk user signs in, Holo creates a local user and links the Clerk ID to it in `auth_identities`. Later sign-ins load that same user. If two first sign-ins for the same Clerk user happen at once, both end up on the same local user.

::: warning
If a local user with the same verified email already exists and isn't linked to Clerk, Holo doesn't merge the accounts. The callback fails with `clerk_identity_conflict`. This stops someone from taking over a password account through a hosted provider.
:::

Holo copies Clerk's primary email to the local user only when Clerk reports it verified. An unverified address never replaces the stored email, and changing the stored email clears its `email_verified_at`.

When [email verification](/auth/email-verification) is required, Clerk users must have a verified email, so phone-only Clerk sign-ups fail. Users without an email get a placeholder like `<clerk-id>@clerk.hosted.local` when verification isn't required.

## Store links in your own table

Holo keeps Clerk links in `auth_identities`. To use another table, pass an `identityStore` with `findByProviderUserId`, `findByUserId`, `save`, and optionally `claim`:

```ts [config/auth.ts]
import { defineAuthConfig, type AuthHostedIdentityStore } from '@holo-js/auth'
import { externalIdentityStore } from '../server/lib/external-identities'

export default defineAuthConfig({
  clerk: {
    provider: 'app',
    identityStore: externalIdentityStore satisfies AuthHostedIdentityStore,
    app: { /* ... */ },
  },
})
```

Each method reads or writes an `AuthHostedIdentityRecord`: `provider`, `providerUserId`, `guard`, `authProvider`, `userId`, `email`, `emailVerified`, `profile`, `linkedAt`, and `updatedAt`. Holo calls `claim()` only when linking a new Clerk user; it should insert the record if no row exists for `(provider, providerUserId)` and return whichever record is stored. Give your table a unique index on those two columns. Without `claim()`, Holo uses `save()`.

## Lower-level functions

`@holo-js/auth-clerk` also exports `verifyRequest()`, `verifySession()`, `syncIdentity()`, and `authenticate()`. `authenticate(request)` verifies a Clerk session on any request, syncs the user, and creates the Holo session in one call, which is useful for API routes that receive a Clerk token in the `Authorization: Bearer` header.

## Signing keys

Holo caches each provider's signing keys for ten minutes, and an unknown key ID refreshes them at most once a minute. If a refresh fails, Holo keeps verifying with the keys it last loaded for at most ten minutes after that last successful fetch, then rejects tokens until a refresh succeeds. Failed refreshes never extend that window.

## Next steps

- [WorkOS](/auth/workos)
- [Social Login](/auth/social-login)
- [Current User on the Client](/auth/current-user)
