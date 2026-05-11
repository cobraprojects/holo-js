# Clerk

`@holo-js/auth-clerk` uses Clerk Account Portal as the hosted authentication UI, then syncs the authenticated Clerk user into your local Holo user model and logs that local user into the normal Holo session.

## Configuration

Install Clerk auth and enable the Clerk Account Portal in the Clerk Dashboard.

```ts
import { defineAuthConfig, env } from '@holo-js/config'

export default defineAuthConfig({
  clerk: {
    provider: env('AUTH_CLERK_PROVIDER', 'app'),
    app: {
      publishableKey: env('CLERK_PUBLISHABLE_KEY'),
      secretKey: env('CLERK_SECRET_KEY'),
      apiUrl: env('CLERK_API_URL'),
      frontendApi: env('CLERK_FRONTEND_API'),
      redirectUri: env('CLERK_REDIRECT_URI'),
    },
  },
})
```

Use these environment variables:

| Variable | Required | Value |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key, usually `pk_test_...` or `pk_live_...`. |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key, usually `sk_test_...` or `sk_live_...`. |
| `CLERK_FRONTEND_API` | Yes | Clerk Frontend API URL, for example `https://steady-newt-5.clerk.accounts.dev` in development or `https://clerk.example.com` in production. |
| `CLERK_REDIRECT_URI` | Yes | Your Holo callback URL, for example `http://localhost:3000/api/auth/clerk/callback`. |
| `CLERK_API_URL` | No | Clerk API base URL. Leave empty unless you are using a custom Clerk API base. |
| `CLERK_SESSION_COOKIE` | No | Clerk session cookie name. Defaults to `__session`. |

`CLERK_FRONTEND_API` is not the Account Portal sign-in URL. Holo derives the matching Account Portal URL from it, appends `/sign-in` or `/sign-up`, and sends `CLERK_REDIRECT_URI` as Clerk's `redirect_url` query parameter. You do not configure a separate `CLERK_ACCOUNT_PORTAL_URL`.

In the Clerk Dashboard:

1. Copy the publishable and secret keys from the API keys page.
2. Copy the Frontend API URL from the Clerk-provided domain settings.
3. Enable Account Portal.
4. Set Account Portal fallback redirects to your app pages, such as `/dashboard` after sign-in and `/onboarding` after sign-up.

The Account Portal fallback redirects are only used when users visit Clerk pages directly. Holo login and registration routes always pass `redirect_url`, so normal Holo sign-in returns to `CLERK_REDIRECT_URI`.

If your Holo app requires email verification, Clerk users must have a verified email address. Phone-only Clerk sign-up works only when your Holo auth config does not require email verification, or when you map the Clerk profile to a local user shape that your app can persist without a real email address.

## Routes

Login redirects the browser to the hosted Clerk sign-in form:

```ts
import { loginWithClerk } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  return await loginWithClerk(request)
}
```

Register redirects the browser to the hosted Clerk sign-up form:

```ts
import { registerWithClerk } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  return await registerWithClerk(request)
}
```

The callback verifies the Clerk session on the request, syncs or creates the local user, links the Clerk identity, and logs the user into Holo:

```ts
import { completeClerkAuth } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  const result = await completeClerkAuth(request)

  if (!result.ok) {
    return Response.redirect(new URL(`/login?error=${result.code}`, request.url))
  }

  return Response.redirect(new URL('/admin', request.url))
}
```

Logout clears the local Holo session, revokes the Clerk session through the Clerk Backend API, and returns the final redirect URL:

```ts
import { logoutWithClerk } from '@holo-js/auth-clerk'

export async function POST(request: Request) {
  const result = await logoutWithClerk(request, {
    returnTo: '/login',
  })

  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  return Response.redirect(result.url, 303)
}
```

## Mapping Local Fields

`completeClerkAuth()` passes a fully typed Clerk user to the optional mapper. Return any local user attributes you want Holo to save on create, update, or link.

```ts
const result = await completeClerkAuth(request, {
  user: (clerkUser) => ({
    email: clerkUser.email,
    name: clerkUser.name,
    avatarUrl: clerkUser.imageUrl,
    clerkUserId: clerkUser.id,
  }),
})
```

The normalized `clerkUser` includes `email` and `name`, derived from Clerk identity data with stable fallbacks. If no mapper is provided, Holo saves `email` and `name` by default. If your mapper omits either field, Holo still fills the missing `email` or `name` before writing the local user.

## Lower-Level APIs

Use `authenticate(request, provider)` when you already have a Clerk-authenticated request and want one call to verify the session, sync the identity, and create the Holo session.

Use `verifyRequest()`, `verifySession()`, and `syncIdentity()` when your route needs lower-level control before creating local auth state.
