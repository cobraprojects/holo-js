# WorkOS

`@holo-js/auth-workos` uses WorkOS/AuthKit as the hosted authentication UI, then syncs the authenticated WorkOS user into your local Holo user model and logs that local user into the normal Holo session.

## Configuration

```ts
import { defineAuthConfig, env } from '@holo-js/config'

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

`WORKOS_REDIRECT_URI` is the callback route registered in the WorkOS dashboard Redirect URIs list, for example `http://localhost:3000/api/auth/workos/callback`.

Do not configure a WorkOS cookie password or WorkOS session cookie name. Holo uses the app key for its own encryption needs, hides WorkOS hosted cookie internals, and authenticates the application through the normal Holo session cookie.

> **Session lifetime**
>
> After WorkOS login succeeds, Holo creates its own application session. To avoid users staying logged into Holo after their WorkOS session has already expired, configure the WorkOS session lifetime in the WorkOS dashboard to match your Holo session lifetime.

## Routes

Login redirects the browser to the hosted WorkOS sign-in form:

```ts
import { loginWithWorkos } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  return await loginWithWorkos(request)
}
```

Register redirects the browser to the hosted WorkOS sign-up form:

```ts
import { registerWithWorkos } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  return await registerWithWorkos(request)
}
```

The callback completes the WorkOS code exchange, syncs or creates the local user, links the WorkOS identity, and logs the user into Holo:

```ts
import { completeWorkosAuth } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  const result = await completeWorkosAuth(request)

  if (!result.ok) {
    return Response.redirect(new URL(`/login?error=${result.code}`, request.url))
  }

  return Response.redirect(new URL('/admin', request.url))
}
```

In Nuxt server routes, pass the event directly:

```ts
import { completeWorkosAuth } from '@holo-js/auth-workos'
import { sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  const result = await completeWorkosAuth(event)

  if (!result.ok) {
    return await sendRedirect(event, `/login?error=${result.code}`, 303)
  }

  return await sendRedirect(event, '/admin', 303)
})
```

Logout clears the local Holo session and returns the hosted WorkOS logout URL. WorkOS redirects to the Sign-out redirect configured in the WorkOS dashboard:

```ts
import { logoutWithWorkos } from '@holo-js/auth-workos'

export async function POST(request: Request) {
  const result = await logoutWithWorkos(request)

  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  return Response.redirect(result.url, 303)
}
```

## Mapping Local Fields

`completeWorkosAuth()` passes a fully typed WorkOS user to the optional mapper. Return any local user attributes you want Holo to save on create, update, or link.

```ts
const result = await completeWorkosAuth(request, {
  user: (workosUser) => ({
    email: workosUser.email,
    name: workosUser.name,
    avatarUrl: workosUser.profilePictureUrl,
    timezone: workosUser.metadata.timezone,
    workosOrganizationId: workosUser.organizationId,
  }),
})
```

The normalized `workosUser` includes `name`, derived from `firstName` and `lastName`, falling back to email. It also exposes WorkOS fields such as `id`, `emailVerified`, `profilePictureUrl`, `organizationId`, `metadata`, and the raw WorkOS payload.

If no mapper is provided, Holo saves `email` and `name` by default. If your mapper omits either field, Holo still fills the missing `email` or `name` before writing the local user.
