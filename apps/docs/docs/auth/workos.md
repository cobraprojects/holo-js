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
  const { error } = await completeWorkosAuth(request)

  if (error) {
    return Response.redirect(new URL(`/login?error=${error.code}`, request.url))
  }

  return Response.redirect(new URL('/admin', request.url))
}
```

In Nuxt server routes, pass the event directly:

```ts
import { completeWorkosAuth } from '@holo-js/auth-workos'
import { sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  const { error } = await completeWorkosAuth(event)

  if (error) {
    return await sendRedirect(event, `/login?error=${error.code}`, 303)
  }

  return await sendRedirect(event, '/admin', 303)
})
```

Logout clears the local Holo session and returns the hosted WorkOS logout URL. WorkOS redirects to the Sign-out redirect configured in the WorkOS dashboard:

```ts
import { logoutWithWorkos } from '@holo-js/auth-workos'
import { provider } from '@holo-js/auth'

export async function POST(request: Request) {
  if (await provider() !== 'workos') {
    return Response.redirect(new URL('/', request.url), 303)
  }

  const { data, error } = await logoutWithWorkos(request)

  if (error) {
    return Response.json({ data, error }, { status: error.status })
  }

  return Response.redirect(data.url, 303)
}
```

Use `provider()` on the server, or `useAuth().provider` in framework client code, to show the WorkOS logout action only
when the current Holo session was created by WorkOS. Calling `logoutWithWorkos()` for a local, Clerk, or other session
returns a typed failure because there is no WorkOS session to end upstream.

## Mapping Local Fields

`completeWorkosAuth()` passes a fully typed WorkOS user to the optional mapper. Return any local user attributes you want Holo to save on create, update, or link.

```ts
const { error } = await completeWorkosAuth(request, {
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

## Identity Store

The default Holo runtime stores WorkOS links in `auth_identities`. Most apps should keep that default:

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

Add `identityStore` only when WorkOS identities live outside the default `auth_identities` table:

```ts
import { defineAuthConfig, env, type AuthHostedIdentityRecord, type AuthHostedIdentityStore } from '@holo-js/config'
import { DB } from '@holo-js/db'

type ExternalIdentityRow = {
  provider: string
  provider_user_id: string
  guard: string
  auth_provider: string
  user_id: string
  email: string | null
  email_verified: boolean | number
  profile: string | Readonly<Record<string, unknown>>
  created_at: Date | string
  updated_at: Date | string
}

function toHostedIdentity(row: ExternalIdentityRow): AuthHostedIdentityRecord {
  return {
    provider: row.provider,
    providerUserId: row.provider_user_id,
    guard: row.guard,
    authProvider: row.auth_provider,
    userId: row.user_id,
    email: row.email ?? undefined,
    emailVerified: row.email_verified === true || row.email_verified === 1,
    profile: typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile,
    linkedAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function toExternalIdentityRow(record: AuthHostedIdentityRecord) {
  return {
    provider: record.provider,
    provider_user_id: record.providerUserId,
    guard: record.guard,
    auth_provider: record.authProvider,
    user_id: String(record.userId),
    email: record.email ?? null,
    email_verified: record.emailVerified ? 1 : 0,
    profile: JSON.stringify(record.profile),
    created_at: record.linkedAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  }
}

async function findExternalIdentity(provider: string, providerUserId: string) {
  const row = await DB.table('external_identities')
    .where('provider', provider)
    .where('provider_user_id', providerUserId)
    .first<ExternalIdentityRow>()

  return row ? toHostedIdentity(row) : null
}

const externalIdentityStore = {
  async findByProviderUserId(provider, providerUserId) {
    return await findExternalIdentity(provider, providerUserId)
  },
  async findByUserId(provider, authProvider, userId) {
    const row = await DB.table('external_identities')
      .where('provider', provider)
      .where('auth_provider', authProvider)
      .where('user_id', String(userId))
      .first<ExternalIdentityRow>()

    return row ? toHostedIdentity(row) : null
  },
  async save(record) {
    await DB.table('external_identities').insertOrIgnore(toExternalIdentityRow(record))
    await DB.table('external_identities')
      .where('provider', record.provider)
      .where('provider_user_id', record.providerUserId)
      .update(toExternalIdentityRow(record))
  },
} satisfies AuthHostedIdentityStore

export default defineAuthConfig({
  workos: {
    provider: env('AUTH_WORKOS_PROVIDER', 'dashboard'),
    identityStore: externalIdentityStore,
    dashboard: {
      clientId: env('WORKOS_CLIENT_ID'),
      apiKey: env('WORKOS_API_KEY'),
      redirectUri: env('WORKOS_REDIRECT_URI'),
    },
  },
})
```
