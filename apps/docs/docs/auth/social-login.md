# Social Login

Social login adds "Continue with Google" (or GitHub, Discord, Facebook, Apple, LinkedIn) buttons to your app. Holo handles the OAuth redirect, state and PKCE checks, the code exchange, and creating or finding the matching user in your `users` table. You add two small routes per provider and sign the user in with your guard.

## Install a provider

```bash
npx holo install auth --social --provider google
```

Pass several providers at once with `--provider google,github`, or run the command again later to add one. `--social` on its own installs Google. Each provider is its own package, and the command adds only the ones you ask for, along with their `config/auth.ts` entry and `.env` keys:

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'

export default defineAuthConfig({
  social: {
    google: {
      clientId: env('AUTH_GOOGLE_CLIENT_ID'),
      clientSecret: env('AUTH_GOOGLE_CLIENT_SECRET'),
      redirectUri: env('AUTH_GOOGLE_REDIRECT_URI'),
      scopes: ['openid', 'email', 'profile'],
    },
  },
})
```

```dotenv [.env]
AUTH_GOOGLE_CLIENT_ID=your-client-id
AUTH_GOOGLE_CLIENT_SECRET=your-client-secret
AUTH_GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
```

In the provider's developer console, register the same URL as the redirect (callback) URI.

## Add the routes

Each provider needs a route that starts the login and a route the provider sends the user back to. The provider name you pass (`'google'`) is the key from `config/auth.ts`.

### Start route

`redirect()` returns a `302` to the provider's sign-in page:

::: code-group

```ts [Next.js]
// app/auth/google/route.ts
import { redirect } from '@holo-js/auth-social'

export function GET(request: Request): Promise<Response> {
  return redirect('google', request)
}
```

```ts [Nuxt]
// server/routes/auth/google.get.ts
import { redirect } from '@holo-js/auth-social'

export default defineEventHandler((event) => {
  return redirect('google', event)
})
```

```ts [SvelteKit]
// src/routes/auth/google/+server.ts
import { redirect } from '@holo-js/auth-social'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = ({ request }) => {
  return redirect('google', request)
}
```

:::

Link to it from your login page: `<a href="/auth/google">Continue with Google</a>`.

### Callback route

`callback()` checks the response, finds or creates the local user, and returns it. It doesn't sign the user in; you do that with `loginUsing()`, then redirect with your framework:

::: code-group

```ts [Next.js]
// app/auth/google/callback/route.ts
import { redirect } from 'next/navigation'
import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'

export async function GET(request: Request): Promise<Response> {
  const result = await callback('google', request)
  if (!result.ok) {
    return Response.json({ message: result.message }, { status: result.status })
  }

  const session = await auth.guard(result.guard).loginUsing(result.user)

  redirect(session.multiFactorChallenge?.route ?? '/dashboard')
}
```

```ts [Nuxt]
// server/routes/auth/google/callback.get.ts
import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'

export default defineEventHandler(async (event) => {
  const result = await callback('google', event)
  if (!result.ok) {
    setResponseStatus(event, result.status)
    return { message: result.message }
  }

  const session = await auth.guard(result.guard).loginUsing(result.user)

  return sendRedirect(event, session.multiFactorChallenge?.route ?? '/dashboard', 303)
})
```

```ts [SvelteKit]
// src/routes/auth/google/callback/+server.ts
import { json, redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ request }) => {
  const result = await callback('google', request)
  if (!result.ok) {
    return json({ message: result.message }, { status: result.status })
  }

  const session = await auth.guard(result.guard).loginUsing(result.user)

  redirect(303, session.multiFactorChallenge?.route ?? '/dashboard')
}
```

:::

Copy both routes for each provider, changing the name and path. The `multiFactorChallenge` check only matters if you use [multi-factor auth](/auth/multi-factor).

A successful `callback()` returns:

```ts
{
  ok: true,
  guard: 'web',
  authProvider: 'users',
  provider: 'google',
  user: { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', avatar: 'https://...', email_verified_at: '...' },
}
```

A failed one returns `{ ok: false, status: 400, message }`, for example `'Invalid or expired OAuth state.'` when the user took longer than 10 minutes or the callback was opened in another browser. Errors from the provider itself, such as a rejected code exchange, are thrown.

## Providers

| Provider | Package | Default scopes | Email counts as verified when |
| --- | --- | --- | --- |
| `google` | `@holo-js/auth-social-google` | `openid email profile` | Google reports `email_verified` |
| `github` | `@holo-js/auth-social-github` | `read:user user:email` | The primary GitHub email is verified |
| `discord` | `@holo-js/auth-social-discord` | `identify email` | Discord reports the account `verified` |
| `facebook` | `@holo-js/auth-social-facebook` | `email public_profile` | Never |
| `apple` | `@holo-js/auth-social-apple` | `name email` | Apple's ID token reports `email_verified` |
| `linkedin` | `@holo-js/auth-social-linkedin` | `openid profile email` | LinkedIn reports `email_verified` |

Install each with `npx holo install auth --social --provider <name>`. The `.env` keys follow the same pattern for every provider: `AUTH_<NAME>_CLIENT_ID`, `AUTH_<NAME>_CLIENT_SECRET`, and `AUTH_<NAME>_REDIRECT_URI`.

Keep the email scope for each provider. Without an email, Holo can't match the social account to an existing user.

### Apple

Apple sends users back with a `POST` form instead of a `GET`. Export your callback handler as `POST` (or use a `.post.ts` file in Nuxt), and exclude the callback path from [CSRF protection](/basics/security/csrf), since the request comes from Apple's site. On HTTPS, Holo sets the state cookie with `SameSite=None; Secure` so the browser sends it with Apple's cross-site `POST`; the state is still checked on every callback. Over plain HTTP the cookie stays `SameSite=Lax`, because browsers reject `SameSite=None` without `Secure`. Apple only includes the user's name the first time they sign in. Holo reads the user's email only from the signed `id_token`, never from the form's `user` field, which Apple doesn't sign. If the `id_token` has no email, the profile has none, and what happens depends on [email verification](/auth/email-verification):

- When `emailVerification.required` is `false`, Holo creates the user with the placeholder address `<id>@apple.social.local` and no verified email.
- When it's `true`, Holo refuses to create the user, and the callback throws `Social sign-in with "apple" requires a verified email address.`

To keep the real address, capture it on the first authorization. Apple sends the name and email in the form's `user` field only then, and Holo doesn't trust that field. Read it from the request in your callback, sign the user in, then save the address as the user's email and call `sendEmailVerification()`. The address is only verified after the user follows the link. Queue the verification email in production, as described in [Customize the email](/auth/email-verification#customize-the-email). Apple's client secret is a signed JWT that you generate from your Apple key; put it in `AUTH_APPLE_CLIENT_SECRET`. Holo sends it as-is and doesn't generate it for you.

### Facebook

Holo never treats a Facebook email as verified. If `emailVerification.required` is `true`, new users can't sign up with Facebook. If it's `false`, new Facebook users get a placeholder email (`<id>@facebook.social.local`) instead of being linked to an existing account by email.

## Signing keys

Holo caches each provider's signing keys for ten minutes, and an unknown key ID refreshes them at most once a minute. If a refresh fails, Holo keeps verifying with the keys it last loaded for at most ten minutes after that last successful fetch, then rejects tokens until a refresh succeeds. Failed refreshes never extend that window.

## How Holo finds the local user

1. If this social account signed in before, Holo loads the user it's linked to.
2. Otherwise, if the provider gives a verified email and a user with that email exists, Holo links the social account to that user, but only when the user has verified that email in your app too. If the user hasn't, the callback throws a `SocialAuthConflictError`. See [Link an existing account](#link-an-existing-account).
3. Otherwise Holo creates a user with the profile's `name`, `email`, and `avatar`, a `null` password, and `email_verified_at` set when the email is verified. Without a verified email, the user gets a placeholder email like `<id>@github.social.local`.

The link is stored in the `auth_identities` table, along with the profile and the provider's access tokens.

::: warning
When [email verification](/auth/email-verification) is required, Holo refuses to create a user from a social account without a verified email. The callback throws instead of returning a user.
:::

Your `users` table needs nullable `password` and `avatar` columns for this, which the auth migrations include.

### Link an existing account

Holo never links a social account to a user whose email isn't verified, because anyone can sign up with an address they don't own. If a provider's verified email matches such a user, `callback()` throws a `SocialAuthConflictError` with `code` (`social_identity_conflict`), `provider`, `providerUserId`, and `email`. Catch it in your callback route and tell the user how to link the accounts:

::: code-group

```ts [Next.js]
// app/auth/google/callback/route.ts
import { redirect } from 'next/navigation'
import auth from '@holo-js/auth'
import { callback, SocialAuthConflictError } from '@holo-js/auth-social'

export async function GET(request: Request): Promise<Response> {
  const result = await callback('google', request).catch((error: unknown) => {
    if (error instanceof SocialAuthConflictError) {
      return { ok: false, status: 409, message: 'Sign in with your password and verify your email to link this account.' } as const
    }
    throw error
  })
  if (!result.ok) {
    return Response.json({ message: result.message }, { status: result.status })
  }

  const session = await auth.guard(result.guard).loginUsing(result.user)

  redirect(session.multiFactorChallenge?.route ?? '/dashboard')
}
```

```ts [Nuxt]
// server/routes/auth/google/callback.get.ts
import auth from '@holo-js/auth'
import { callback, SocialAuthConflictError } from '@holo-js/auth-social'

export default defineEventHandler(async (event) => {
  const result = await callback('google', event).catch((error: unknown) => {
    if (error instanceof SocialAuthConflictError) {
      return { ok: false, status: 409, message: 'Sign in with your password and verify your email to link this account.' } as const
    }
    throw error
  })
  if (!result.ok) {
    setResponseStatus(event, result.status)
    return { message: result.message }
  }

  const session = await auth.guard(result.guard).loginUsing(result.user)

  return sendRedirect(event, session.multiFactorChallenge?.route ?? '/dashboard', 303)
})
```

```ts [SvelteKit]
// src/routes/auth/google/callback/+server.ts
import { json, redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { callback, SocialAuthConflictError } from '@holo-js/auth-social'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ request }) => {
  const result = await callback('google', request).catch((error: unknown) => {
    if (error instanceof SocialAuthConflictError) {
      return { ok: false, status: 409, message: 'Sign in with your password and verify your email to link this account.' } as const
    }
    throw error
  })
  if (!result.ok) {
    return json({ message: result.message }, { status: result.status })
  }

  const session = await auth.guard(result.guard).loginUsing(result.user)

  redirect(303, session.multiFactorChallenge?.route ?? '/dashboard')
}
```

:::

To link the accounts, the user signs in with their password and [verifies their email](/auth/email-verification). The next time they continue with the provider, Holo links the social account to them.

## Provider options

| Option | Description |
| --- | --- |
| `clientId`, `clientSecret` | Credentials from the provider |
| `redirectUri` | Your callback URL. Must match the provider console |
| `scopes` | Overrides the default scopes |
| `guard` | Sign users in on this guard instead of the default. See [Guards and Providers](/auth/guards-and-providers#choose-a-guard-for-social-and-hosted-login) |
| `mapToProvider` | Store users in this user provider instead of the guard's |
| `encryptTokens` | Encrypt the provider's access and refresh tokens in `auth_identities`. Uses `socialEncryptionKey`, which defaults to `APP_KEY` |
| `runtime` | Package name for a custom provider |

## Add a custom provider

Any OAuth provider works if a package exports a `SocialProviderRuntime`. Point `runtime` at it:

```ts [config/auth.ts]
social: {
  slack: {
    runtime: '@acme/holo-auth-social-slack',
    clientId: env('AUTH_SLACK_CLIENT_ID'),
    clientSecret: env('AUTH_SLACK_CLIENT_SECRET'),
    redirectUri: env('AUTH_SLACK_REDIRECT_URI'),
    scopes: ['openid', 'profile', 'email'],
  },
},
```

The package must export the runtime as its default export, as `slackSocialProvider` (the config key plus `SocialProvider`), or as `socialProvider`. Without `runtime`, Holo loads `@holo-js/auth-social-<name>`.

A runtime has two methods:

| Method | Receives | Returns |
| --- | --- | --- |
| `buildAuthorizationUrl(context)` | `config`, `state`, `codeChallenge`, `codeVerifier`, `request` | The provider's sign-in URL. Include `state`, and `codeChallenge` with method `S256` if the provider supports PKCE |
| `exchangeCode(context)` | `config`, `code`, `codeVerifier`, `request` | `{ profile, tokens }` |

`profile` is `{ id, email?, emailVerified?, name?, avatar? }`, and `tokens` is `{ accessToken, refreshToken?, expiresAt? }`. Import the `SocialProviderRuntime` type from `@holo-js/auth-social`, and use the first-party packages as examples.

## Next steps

- [WorkOS](/auth/workos) and [Clerk](/auth/clerk) for hosted sign-in pages
- [Login and Registration](/auth/local-auth)
- [Email Verification](/auth/email-verification)
