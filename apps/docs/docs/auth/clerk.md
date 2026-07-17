# Clerk

`@holo-js/auth-clerk` uses Clerk Account Portal as the hosted authentication UI, then syncs the authenticated Clerk user into your local Holo user model and logs that local user into the normal Holo session.

## Configuration

Install Clerk auth and enable the Clerk Account Portal in the Clerk Dashboard.

```bash
npx holo install auth --clerk
```

The command wires the hosted-auth route scaffolding. Keep Account Portal enabled in Clerk so those routes can redirect to Clerk's hosted forms.

```ts
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
    },
  },
})
```

Use these environment variables:

| Variable | Required | Value |
| --- | --- | --- |
| `AUTH_CLERK_PROVIDER` | No | Clerk provider key from `defineAuthConfig({ clerk })`. Defaults to `app`; valid values are the configured provider keys such as `app` or `org`. |
| `CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key, usually `pk_test_...` or `pk_live_...`. |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key, usually `sk_test_...` or `sk_live_...`. |
| `CLERK_FRONTEND_API` | Yes | Clerk Frontend API URL, for example `https://steady-newt-5.clerk.accounts.dev` in development or `https://clerk.example.com` in production. |
| `CLERK_REDIRECT_URI` | Yes | Your Holo callback URL, for example `http://localhost:3000/api/auth/clerk/callback`. |
| `CLERK_API_URL` | No | Clerk API base URL. Leave empty unless you are using a custom Clerk API base. |
| `CLERK_SESSION_COOKIE` | No | Clerk session cookie name. Defaults to `__session`. |

`CLERK_FRONTEND_API` is not the Account Portal sign-in URL. Holo derives the matching Account Portal URL from it, appends `/sign-in` or `/sign-up`, and sends `CLERK_REDIRECT_URI` as Clerk's `redirect_url` query parameter. You do not configure a separate `CLERK_ACCOUNT_PORTAL_URL`.

`CLERK_SESSION_COOKIE` is optional and defaults to `__session`; you only need to set it if your Clerk instance uses a different session cookie name.

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
  const { error } = await completeClerkAuth(request)

  if (error) {
    return Response.redirect(new URL(`/login?error=${error.code}`, request.url))
  }

  return Response.redirect(new URL('/', request.url))
}
```

Logout clears the local Holo session, revokes the Clerk session through the Clerk Backend API, and returns the final redirect URL:

```ts
import { logoutWithClerk } from '@holo-js/auth-clerk'
import { provider } from '@holo-js/auth'

export async function POST(request: Request) {
  if (await provider() !== 'clerk') {
    return Response.redirect(new URL('/', request.url), 303)
  }

  const { data, error } = await logoutWithClerk(request, {
    returnTo: '/login',
  })

  if (error) {
    return Response.json({ data, error }, { status: error.status })
  }

  return Response.redirect(data.url, 303)
}
```

Use `provider()` on the server, or `useAuth().provider` in framework client code, to show the Clerk logout action only
when the current Holo session was created by Clerk. Calling `logoutWithClerk()` for a local, WorkOS, or other session
returns a typed failure because there is no Clerk session to revoke upstream.

## Mapping Local Fields

`completeClerkAuth()` passes a fully typed Clerk user to the optional mapper. Return any local user attributes you want Holo to save on create, update, or link.

```ts
const { error } = await completeClerkAuth(request, {
  user: (clerkUser) => ({
    email: clerkUser.email,
    name: clerkUser.name,
    avatarUrl: clerkUser.imageUrl,
    clerkUserId: clerkUser.id,
  }),
})
```

The normalized `clerkUser` includes `email` and `name`, derived from Clerk identity data with stable fallbacks. If no mapper is provided, Holo saves `email` and `name` by default. If your mapper omits either field, Holo still fills the missing `email` or `name` before writing the local user.

## Identity Store

The default Holo runtime stores Clerk links in `auth_identities`. It uses the scaffolded unique index on `provider` and
`provider_user_id` to claim a Clerk identity once, so two first sign-ins for the same Clerk user reuse the same local
identity.

Most apps should not configure an identity store:

```ts
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'
export default defineAuthConfig({
  clerk: {
    provider: env('AUTH_CLERK_PROVIDER', 'app'),
    app: {
      publishableKey: env('CLERK_PUBLISHABLE_KEY'),
      secretKey: env('CLERK_SECRET_KEY'),
      frontendApi: env('CLERK_FRONTEND_API'),
      redirectUri: env('CLERK_REDIRECT_URI'),
    },
  },
})
```

Add `identityStore` only when Clerk identities live outside the default `auth_identities` table. The key is optional and
does not change the Clerk route API.

```ts
import { defineAuthConfig, type AuthHostedIdentityRecord, type AuthHostedIdentityStore } from '@holo-js/auth'
import { env } from '@holo-js/config'
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
  async claim(record) {
    await DB.table('external_identities').insertOrIgnore(toExternalIdentityRow(record))

    const claimed = await findExternalIdentity(record.provider, record.providerUserId)
    if (!claimed) {
      throw new Error('Clerk identity was not stored.')
    }

    return claimed
  },
  async save(record) {
    await DB.table('external_identities')
      .where('provider', record.provider)
      .where('provider_user_id', record.providerUserId)
      .update(toExternalIdentityRow(record))
  },
} satisfies AuthHostedIdentityStore

export default defineAuthConfig({
  clerk: {
    provider: env('AUTH_CLERK_PROVIDER', 'app'),
    identityStore: externalIdentityStore,
    app: {
      publishableKey: env('CLERK_PUBLISHABLE_KEY'),
      secretKey: env('CLERK_SECRET_KEY'),
      frontendApi: env('CLERK_FRONTEND_API'),
      redirectUri: env('CLERK_REDIRECT_URI'),
    },
  },
})
```

`toHostedIdentity()` should return Holo's hosted identity shape: `provider`, `providerUserId`, `guard`, `authProvider`,
`userId`, optional `email`, `emailVerified`, `profile`, `linkedAt`, and `updatedAt`. `toExternalIdentityRow()` should
persist the same data in your custom table's column names. If you provide `claim()`, make sure your custom table has a
unique index on `(provider, provider_user_id)`. Holo calls `claim()` only when linking a new Clerk identity. It calls
`save()` when refreshing an already-linked identity.

## Lower-Level APIs

Use `authenticate(request, provider)` when you already have a Clerk-authenticated request and want one call to verify the session, sync the identity, and create the Holo session.

Use `verifyRequest()`, `verifySession()`, and `syncIdentity()` when your route needs lower-level control before creating local auth state.
