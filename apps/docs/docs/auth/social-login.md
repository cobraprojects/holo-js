# Social Login

Social login lets users authenticate through an OAuth provider while still resolving into a local application-owned
user model.

## Introduction

`@holo-js/auth-social` manages:

- redirect URL generation
- state and PKCE handling
- callback token exchange
- provider profile normalization
- local identity linking
- optional encrypted provider token storage

The local provider remains canonical. The external identity is linked into `auth_identities`.

Built-in providers resolve by package naming convention: `@holo-js/auth-social-<provider>`.
Custom providers can override that with `social.<name>.runtime`.

## Installing Providers

Social login uses one shared runtime package plus one package per provider. Install only the providers your app
actually uses.

```bash
npx holo install auth --social
npx holo install auth --social --provider google
npx holo install auth --social --provider github
npx holo install auth --social --provider google,github
```

If you pass `--social` without `--provider`, Holo installs Google by default. In other words,
`npx holo install auth --social` is equivalent to `npx holo install auth --social --provider google`.

Each social provider has its own package. Holo only installs the provider packages you specify:

- Google uses `@holo-js/auth-social-google`
- GitHub uses `@holo-js/auth-social-github`
- Discord uses `@holo-js/auth-social-discord`
- Facebook uses `@holo-js/auth-social-facebook`
- Apple uses `@holo-js/auth-social-apple`
- LinkedIn uses `@holo-js/auth-social-linkedin`

Providers that are not listed are not installed, are not added to `config/auth.ts`, and do not get env keys. You can
add another provider later by running the install command again:

```bash
npx holo install auth --social --provider github
```

That adds GitHub support on top of the existing auth setup. It does not remove already configured providers such as
Google.

Supported first-party providers:

- Google
- GitHub
- Discord
- Facebook
- Apple
- LinkedIn

Only configured providers are installed by the CLI, and only configured providers are loaded by the runtime.

## Provider Matrix

Use the provider key in `config/auth.ts`, in your redirect route, and in your callback route. The same key maps to the
provider package installed by the CLI.

| Provider | Install Command | Config Key | Package | Default Scopes |
| --- | --- | --- | --- | --- |
| Google | `npx holo install auth --social --provider google` | `google` | `@holo-js/auth-social-google` | `openid email profile` |
| GitHub | `npx holo install auth --social --provider github` | `github` | `@holo-js/auth-social-github` | `read:user user:email` |
| Discord | `npx holo install auth --social --provider discord` | `discord` | `@holo-js/auth-social-discord` | `identify email` |
| Facebook | `npx holo install auth --social --provider facebook` | `facebook` | `@holo-js/auth-social-facebook` | `email public_profile` |
| Apple | `npx holo install auth --social --provider apple` | `apple` | `@holo-js/auth-social-apple` | `name email` |
| LinkedIn | `npx holo install auth --social --provider linkedin` | `linkedin` | `@holo-js/auth-social-linkedin` | `openid profile email` |

Those default scopes come from the first-party provider packages. Override them only when your application needs a
different upstream permission set.

## Configuration

```ts
import { defineAuthConfig } from '@holo-js/auth'
export default defineAuthConfig({
  social: {
    google: {
      clientId: process.env.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.AUTH_GOOGLE_REDIRECT_URI,
      scopes: ['openid', 'email', 'profile'],
      guard: 'web',
    },
  },
})
```

The route the user clicks is the start route, for example `/auth/google`.

The URL registered with the provider is the redirect URI, for example `/auth/google/callback`. This is the URL Google
calls the "Authorized redirect URI", and it is the same value you put in `AUTH_GOOGLE_REDIRECT_URI`.

Provider keys map to first-party packages:

- `google` -> `@holo-js/auth-social-google`
- `github` -> `@holo-js/auth-social-github`
- `discord` -> `@holo-js/auth-social-discord`
- `facebook` -> `@holo-js/auth-social-facebook`
- `apple` -> `@holo-js/auth-social-apple`
- `linkedin` -> `@holo-js/auth-social-linkedin`

Custom providers can point at any package that exports a social runtime:

```ts
import { defineAuthConfig } from '@holo-js/auth'
export default defineAuthConfig({
  social: {
    slack: {
      runtime: '@acme/holo-auth-social-slack',
      clientId: process.env.AUTH_SLACK_CLIENT_ID,
      clientSecret: process.env.AUTH_SLACK_CLIENT_SECRET,
      redirectUri: 'https://app.example.com/auth/slack/callback',
      scopes: ['openid', 'profile', 'email'],
    },
  },
})
```

That package must export a `SocialProviderRuntime` as either the default export, `socialProvider`, or
`slackSocialProvider`.

## Configuring Multiple Providers

Configure only the providers your app actually uses:

```ts
import { defineAuthConfig } from '@holo-js/auth'
export default defineAuthConfig({
  social: {
    google: {
      clientId: process.env.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET,
      redirectUri: 'https://app.example.com/auth/google/callback',
      scopes: ['openid', 'email', 'profile'],
    },
    github: {
      clientId: process.env.AUTH_GITHUB_CLIENT_ID,
      clientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET,
      redirectUri: 'https://app.example.com/auth/github/callback',
      scopes: ['read:user', 'user:email'],
    },
  },
})
```

If you use a non-default guard, set it per provider:

```ts
social: {
  google: {
    clientId: process.env.AUTH_GOOGLE_CLIENT_ID,
    clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/admin/auth/google/callback',
    scopes: ['openid', 'email', 'profile'],
    guard: 'admin',
  },
}
```

That makes the social login resolve into the local model behind the `admin` guard instead of the default `web` guard.

## Route Shape

Social login needs two app-owned routes per provider:

| Purpose | Google Example | GitHub Example |
| --- | --- | --- |
| Start the OAuth redirect | `GET /auth/google` | `GET /auth/github` |
| Handle the provider callback | `GET /auth/google/callback` | `GET /auth/github/callback` |

The provider name in `redirect('google', input)` and `callback('google', input)` must match the provider key in
`config/auth.ts`.

For a local app running on `http://localhost:3000`, put this in the provider dashboard:

```text
http://localhost:3000/auth/google/callback
http://localhost:3000/auth/github/callback
```

And put the same redirect URIs in your app env:

```ini
AUTH_GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
AUTH_GITHUB_REDIRECT_URI=http://localhost:3000/auth/github/callback
```

## Redirect Helper

Use `redirect(provider, input)` from `@holo-js/auth-social` in the route the user clicks.

```ts
import { redirect } from '@holo-js/auth-social'

const response = await redirect('google', requestOrEvent)
```

It returns:

```ts
Promise<Response>
```

The returned response is a `302` redirect to the upstream provider authorization URL. Holo also stores the pending
OAuth state and PKCE verifier so the callback can be validated later.

At runtime it looks like:

```ts
const response = {
  status: 302,
  headers: {
    location: 'https://accounts.google.com/o/oauth2/v2/auth?...&state=...&code_challenge=...',
  },
}
```

The helper accepts:

- a standard `Request`
- a Nuxt/H3 event
- an event-like object that exposes `request`, `web.request`, `req`, `node.req`, or `url`/`method`/`headers`

Use the native request object for your framework. Do not build a separate request adapter in app code.

## Callback Helper

Use `callback(provider, input)` from `@holo-js/auth-social` in the provider callback route.

```ts
import { callback } from '@holo-js/auth-social'

const result = await callback('google', requestOrEvent)
```

It returns:

```ts
type SocialCallbackResult =
  | {
      readonly ok: true
      readonly guard: string
      readonly authProvider: string
      readonly provider: string
      readonly user: AuthUserLike
    }
  | {
      readonly ok: false
      readonly status: 400
      readonly message: string
    }
```

The success result does not redirect and does not create a session by itself. It gives your route the resolved local
user and selected guard so your route can use the framework's native redirect API after signing the user in.

The user has the local auth provider's serialized shape:

```ts
type AuthUserLike = {
  readonly id?: string | number
  readonly email?: string
  readonly name?: string
  readonly [key: string]: unknown
}
```

For a normal `users` provider, the object usually includes `id`, `email`, `name`, and any fields your provider
serializer exposes, such as `avatar` or `email_verified_at`. The external provider profile is linked in
`auth_identities`; app code should continue treating the local Holo user as canonical.

At runtime a successful callback result looks like:

```ts
{
  ok: true,
  guard: 'web',
  authProvider: 'users',
  provider: 'google',
  user: {
    id: 1,
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    avatar: 'https://provider.example/avatar.png',
    email_verified_at: new Date(),
  },
}
```

An invalid callback result looks like:

```ts
{
  ok: false,
  status: 400,
  message: 'Invalid or expired OAuth state.',
}
```

The callback helper:

- reads the upstream `code` and `state` from the callback request
- validates the saved state
- validates PKCE data when the provider flow uses it
- exchanges the authorization code with the provider package
- normalizes the provider profile
- resolves or creates a local user
- links the social identity
- returns the selected guard, local auth provider, provider key, and local user

## Framework Examples

The examples below use Google. Replace `google` with another configured provider key when creating routes for GitHub,
Discord, Facebook, Apple, or LinkedIn.

### Next.js

Create the redirect route at `app/auth/google/route.ts`:

```ts
import { redirect } from '@holo-js/auth-social'

export function GET(request: Request): Promise<Response> {
  return redirect('google', request)
}
```

Create the callback route at `app/auth/google/callback/route.ts`:

```ts
import { redirect } from 'next/navigation'
import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'

export async function GET(request: Request) {
  const result = await callback('google', request)
  if (!result.ok) {
    return Response.json({
      message: result.message,
    }, {
      status: result.status,
    })
  }

  await auth.guard(result.guard).loginUsing(result.user)
  redirect('/admin')
}
```

### Nuxt

Nuxt server helpers such as `defineEventHandler`, `setResponseStatus`, and `sendRedirect` are available in Nuxt server
routes. Import them from `h3` if your project does not use Nuxt auto-imports.

Create the redirect route at `server/routes/auth/google.get.ts`:

```ts
import { redirect } from '@holo-js/auth-social'

export default defineEventHandler((event) => {
  return redirect('google', event)
})
```

Create the callback route at `server/routes/auth/google/callback.get.ts`:

```ts
import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'

export default defineEventHandler(async (event) => {
  const result = await callback('google', event)
  if (!result.ok) {
    setResponseStatus(event, result.status)
    return {
      message: result.message,
    }
  }

  await auth.guard(result.guard).loginUsing(result.user)
  return sendRedirect(event, '/admin', 303)
})
```

Nuxt routes should pass the H3 event directly. Holo reads the method, URL, and headers from the event-like input.

### SvelteKit

Create the redirect route at `src/routes/auth/google/+server.ts`:

```ts
import { redirect } from '@holo-js/auth-social'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = ({ request }) => {
  return redirect('google', request)
}
```

Create the callback route at `src/routes/auth/google/callback/+server.ts`:

```ts
import { json, redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ request }) => {
  const result = await callback('google', request)
  if (!result.ok) {
    return json({
      message: result.message,
    }, {
      status: result.status,
    })
  }

  await auth.guard(result.guard).loginUsing(result.user)
  throw redirect(303, '/admin')
}
```

Use `loginUsing()` when the selected guard is session-based, then redirect with your framework's native redirect API.
Token guard flows can create a token from the returned user instead of creating a session.

Each provider package handles its own upstream field mapping. Holo does not guess raw provider response shapes across
different services.

## Provider Examples

### Google

Install:

```bash
npx holo install auth --social --provider google
```

Config:

```ts
social: {
  google: {
    clientId: process.env.AUTH_GOOGLE_CLIENT_ID,
    clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/auth/google/callback',
    scopes: ['openid', 'email', 'profile'],
  },
}
```

Use Google when you want OpenID Connect style profile data with `openid`, `email`, and `profile`.

### GitHub

Install:

```bash
npx holo install auth --social --provider github
```

Config:

```ts
social: {
  github: {
    clientId: process.env.AUTH_GITHUB_CLIENT_ID,
    clientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/auth/github/callback',
    scopes: ['read:user', 'user:email'],
  },
}
```

GitHub uses a user profile request plus an email request. Keep `user:email` when you want Holo to resolve the local
user by email.

### Discord

Install:

```bash
npx holo install auth --social --provider discord
```

Config:

```ts
social: {
  discord: {
    clientId: process.env.AUTH_DISCORD_CLIENT_ID,
    clientSecret: process.env.AUTH_DISCORD_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/auth/discord/callback',
    scopes: ['identify', 'email'],
  },
}
```

Use `identify` for the account itself and `email` when you want local account resolution through the Discord email
address.

### Facebook

Install:

```bash
npx holo install auth --social --provider facebook
```

Config:

```ts
social: {
  facebook: {
    clientId: process.env.AUTH_FACEBOOK_CLIENT_ID,
    clientSecret: process.env.AUTH_FACEBOOK_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/auth/facebook/callback',
    scopes: ['email', 'public_profile'],
  },
}
```

Facebook uses Graph API profile fields. Keep `email` when your app needs local account resolution by email.

### Apple

Install:

```bash
npx holo install auth --social --provider apple
```

Config:

```ts
social: {
  apple: {
    clientId: process.env.AUTH_APPLE_CLIENT_ID,
    clientSecret: process.env.AUTH_APPLE_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/auth/apple/callback',
    scopes: ['name', 'email'],
  },
}
```

Apple uses the `id_token` returned from the token exchange to normalize the external identity. The callback still goes
through the same Holo `callback('apple', request)` flow.

### LinkedIn

Install:

```bash
npx holo install auth --social --provider linkedin
```

Config:

```ts
social: {
  linkedin: {
    clientId: process.env.AUTH_LINKEDIN_CLIENT_ID,
    clientSecret: process.env.AUTH_LINKEDIN_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/auth/linkedin/callback',
    scopes: ['openid', 'profile', 'email'],
  },
}
```

LinkedIn uses its user info endpoint and normalizes the result into the same Holo social profile shape as the other
providers.

## Verified Email Requirements

If social auth returns a verified email, the local model is marked as verified. If the provider does not return a
verified email and email verification is required, the social login flow is blocked until a verified email is
available.

Do not assume every provider returns the same raw fields. Each first-party provider package decides how upstream email,
verification state, display name, avatar, and external id are normalized before the auth runtime continues.

## Linked Identities

Each linked record stores:

- provider name
- provider user id
- local provider
- local user id
- email and verification state
- provider profile data
- provider tokens when token storage is enabled

## Token Encryption

Provider tokens may be encrypted before storage:

```ts
social: {
  google: {
    encryptTokens: true,
  },
}
```

## Choosing Scopes

Use the default scopes first unless your app has a clear reason to change them.

- Google: `openid email profile`
- GitHub: `read:user user:email`
- Discord: `identify email`
- Facebook: `email public_profile`
- Apple: `name email`
- LinkedIn: `openid profile email`

If you remove the email-related scopes for a provider, Holo may not be able to match or create the local user the way
you expect.
