# WorkOS

WorkOS authentication keeps WorkOS as the hosted identity system while syncing the authenticated identity into a local
application model.

## What This Package Does

`@holo-js/auth-workos` is designed for applications that need:

- hosted sign-in and organization-aware identity flows
- a local `User` or `Admin` model
- synchronized identity linking
- guard-aware authentication into the local model

Think of the split like this:

- WorkOS proves who the user is
- Holo finds or creates your local user record
- Holo signs that local user into your configured guard

If you want the shortest answer to "how do I use this?":

- easy Holo way: call `authenticate(request, 'dashboard')`
- manual way: call `verifyRequest()`, then `syncIdentity()`, then `loginUsing()`

## Configuration

```ts
import { defineAuthConfig } from '@holo-js/config'

export default defineAuthConfig({
  workos: {
    dashboard: {
      clientId: process.env.WORKOS_CLIENT_ID,
      apiKey: process.env.WORKOS_API_KEY,
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD,
      redirectUri: 'https://app.example.com/auth/workos/callback',
      sessionCookie: 'wos-session',
      guard: 'web',
    },
  },
})
```

## Easy Holo Way

This is the normal Holo flow. One call does everything:

- read the WorkOS session from the request
- verify it
- find or create the local user
- link the hosted identity
- create the local Holo session

```ts
import { authenticate } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  const result = await authenticate(request, 'dashboard')

  if (!result) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  return Response.json({
    authenticated: true,
    user: result.user,
  })
}
```

### What `authenticate()` Returns

```ts
import { authenticate } from '@holo-js/auth-workos'
```

`authenticate()` returns:

- `result.user`
  Your local Holo user model after serialization. This is usually the value your app cares about most.
- `result.status`
  What happened during sync: `created`, `updated`, `linked`, or `relinked`.
- `result.identity`
  The stored hosted identity link row.
- `result.session`
  The verified WorkOS session data, including the hosted session token as `result.session.accessToken`.
- `result.authSession`
  The local Holo session that was established for the selected guard.

In practice:

- if you just want the signed-in local user, use `result.user`
- if you care whether the local user was newly created or reused, check `result.status`
- if you need hosted WorkOS details, inspect `result.session`

`result.session.accessToken` is the verified WorkOS session token. It is hosted-session state, not a Holo personal
access token and not a social-provider OAuth token.

## Manual Way

Use the manual flow when you want to control each step yourself.

```ts
import { loginUsing } from '@holo-js/auth'
import { syncIdentity, verifyRequest } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  const hosted = await verifyRequest(request, 'dashboard')

  if (!hosted) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  const linked = await syncIdentity(hosted, 'dashboard')

  if (linked.user.email !== 'allowed@app.test') {
    return Response.json({ message: 'Forbidden.' }, { status: 403 })
  }

  const authSession = await loginUsing(linked.user)

  return Response.json({
    authenticated: true,
    user: linked.user,
    status: linked.status,
  })
}
```

### What Each Manual Step Returns

- `verifyRequest(request, 'dashboard')`
  Returns the verified WorkOS session from the incoming request, or `null` if the request is not authenticated with WorkOS.
- `syncIdentity(hosted, 'dashboard')`
  Returns the local-user sync result. This includes `linked.user`, `linked.status`, `linked.identity`, and `linked.session`.
- `loginUsing(linked.user)`
  Returns the local Holo session result for your configured guard.

Use the manual flow when you need to:

- inspect the verified WorkOS session before local sign-in
- run your own authorization checks after identity sync
- allow WorkOS authentication but delay local login
- shape the response differently depending on `linked.status`

## Verifying A Token Instead Of A Request

If your route already has the WorkOS token, use `verifySession(token, provider)` instead of `verifyRequest(request, provider)`.

```ts
import { verifySession } from '@holo-js/auth-workos'

const hosted = await verifySession(token, 'dashboard')
```

This returns the same kind of hosted WorkOS session object as `verifyRequest()`, but starts from a token string instead of an incoming `Request`.

## Logging Out

Keep using the shared auth API:

```ts
import { logout } from '@holo-js/auth'

const signedOut = await logout()
```

When the guard is mapped to WorkOS, `logout()` clears:

- the local Holo auth session
- the configured WorkOS session cookie for that guard

That prevents the next request from silently re-authenticating from the WorkOS cookie alone.

## Conflict Handling

WorkOS sync is intentionally conservative. If a hosted identity conflicts with an existing linked user in a way the
runtime cannot safely resolve, the flow fails with an explicit error instead of silently reassigning ownership.
