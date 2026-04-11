# Clerk

Clerk authentication keeps Clerk as the hosted identity provider while resolving into a local Holo user model.

## What This Package Does

`@holo-js/auth-clerk` is useful when:

- the sign-in UX is handled by Clerk
- your application still owns a local `User` or `Admin` model
- the local model needs to stay in sync with the hosted identity

Think of the split like this:

- Clerk proves who the user is
- Holo finds or creates your local user record
- Holo signs that local user into your configured guard

If you want the shortest answer to "how do I use this?":

- easy Holo way: call `authenticate(request, 'app')`
- manual way: call `verifyRequest()`, then `syncIdentity()`, then `loginUsing()`

## Configuration

```ts
import { defineAuthConfig } from '@holo-js/config'

export default defineAuthConfig({
  clerk: {
    app: {
      publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
      secretKey: process.env.CLERK_SECRET_KEY,
      jwtKey: process.env.CLERK_JWT_KEY,
      sessionCookie: '__session',
      guard: 'web',
    },
  },
})
```

## Easy Holo Way

This is the normal Holo flow. One call does everything:

- read the Clerk session from the request
- verify it
- find or create the local user
- link the hosted identity
- create the local Holo session

```ts
import { authenticate } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  const result = await authenticate(request, 'app')

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
import { authenticate } from '@holo-js/auth-clerk'
```

`authenticate()` returns:

- `result.user`
  Your local Holo user model after serialization.
- `result.status`
  What happened during sync: `created`, `updated`, `linked`, or `relinked`.
- `result.identity`
  The stored hosted identity link row.
- `result.session`
  The verified Clerk session data, including the hosted session token as `result.session.accessToken`.
- `result.authSession`
  The local Holo session that was established for the selected guard.

In practice:

- if you just want the signed-in local user, use `result.user`
- if you care whether the local user was just created or reused, check `result.status`
- if you need hosted Clerk details, inspect `result.session`

`result.session.accessToken` is the verified Clerk session token. It is hosted-session state, not a Holo personal
access token and not a social-provider OAuth token.

## Manual Way

Use the manual flow when your route needs full control over each step.

```ts
import { loginUsing } from '@holo-js/auth'
import { syncIdentity, verifyRequest } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  const hosted = await verifyRequest(request, 'app')

  if (!hosted) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  const linked = await syncIdentity(hosted, 'app')

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

- `verifyRequest(request, 'app')`
  Returns the verified Clerk session from the incoming request, or `null` if the request is not authenticated with Clerk.
- `syncIdentity(hosted, 'app')`
  Returns the local-user sync result. This includes `linked.user`, `linked.status`, `linked.identity`, and `linked.session`.
- `loginUsing(linked.user)`
  Returns the local Holo session result for your configured guard.

Use the manual flow when you need to:

- inspect the verified Clerk session before creating local auth state
- enforce your own checks after identity sync
- allow Clerk authentication but delay local login
- shape the response differently depending on `linked.status`

## Verifying A Token Instead Of A Request

If your route already has the Clerk session token, use `verifySession(token, provider)` instead of `verifyRequest(request, provider)`.

```ts
import { verifySession } from '@holo-js/auth-clerk'

const hosted = await verifySession(token, 'app')
```

This returns the same kind of hosted Clerk session object as `verifyRequest()`, but starts from a token string instead of an incoming `Request`.

## Logging Out

Keep using the shared auth API:

```ts
import { logout } from '@holo-js/auth'

const signedOut = await logout()
```

When the guard is mapped to Clerk, `logout()` clears:

- the local Holo auth session
- the configured Clerk session cookie for that guard

This keeps logout behavior consistent with local auth while avoiding immediate re-authentication from the hosted cookie.

## Session Cookie

By default Clerk uses `__session`. This can be customized through the auth config when the application needs a
different session cookie name.
