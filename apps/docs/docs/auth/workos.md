# WorkOS

WorkOS authentication keeps WorkOS as the hosted identity system while syncing the authenticated identity into a local
application model.

## Introduction

`@holo-js/auth-workos` is designed for applications that need:

- hosted sign-in and organization-aware identity flows
- a local `User` or `Admin` model
- synchronized identity linking
- guard-aware authentication into the local model

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

## Verifying Hosted Sessions

```ts
import { verifyRequest, verifySession } from '@holo-js/auth-workos'
```

Use these helpers when your route receives a WorkOS-backed request and needs to confirm the hosted session before
mapping it into the local model.

## Syncing The Local Model

```ts
import { syncIdentity } from '@holo-js/auth-workos'
```

The sync flow:

- resolves the configured local guard and provider
- finds an existing linked identity
- matches by verified email when needed
- creates or updates the local model
- stores the hosted identity link in `auth_identities`

## Authenticating The Local User

```ts
import { authenticate } from '@holo-js/auth-workos'
```

After verification and sync, the package authenticates the linked local user through the selected guard.

## Conflict Handling

WorkOS sync is intentionally conservative. If a hosted identity conflicts with an existing linked user in a way the
runtime cannot safely resolve, the flow fails with an explicit error instead of silently reassigning ownership.
