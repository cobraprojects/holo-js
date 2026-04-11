# Clerk

Clerk authentication keeps Clerk as the hosted identity provider while resolving into a local Holo user model.

## Introduction

`@holo-js/auth-clerk` is useful when:

- the sign-in UX is handled by Clerk
- your application still owns a local `User` or `Admin` model
- the local model needs to stay in sync with the hosted identity

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

## Verifying Hosted Sessions

```ts
import { verifyRequest, verifySession } from '@holo-js/auth-clerk'
```

These helpers validate Clerk-backed requests before the local sync step runs.

## Syncing The Local Model

```ts
import { syncIdentity } from '@holo-js/auth-clerk'
```

The sync flow:

- resolves the selected guard and provider
- loads an existing linked identity when one exists
- matches by verified email when appropriate
- creates or updates the local user model
- stores the hosted identity relationship in `auth_identities`

## Authenticating The Local User

```ts
import { authenticate } from '@holo-js/auth-clerk'
```

After verification and sync, the package authenticates the linked local user through the configured guard.

## Session Cookie

By default Clerk uses `__session`. This can be customized through the auth config when the application needs a
different session cookie name.
