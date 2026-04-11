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
bunx holo install auth --social --provider google
bunx holo install auth --social --provider github
bunx holo install auth --social --provider google,github
```

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
| Google | `bunx holo install auth --social --provider google` | `google` | `@holo-js/auth-social-google` | `openid email profile` |
| GitHub | `bunx holo install auth --social --provider github` | `github` | `@holo-js/auth-social-github` | `read:user user:email` |
| Discord | `bunx holo install auth --social --provider discord` | `discord` | `@holo-js/auth-social-discord` | `identify email` |
| Facebook | `bunx holo install auth --social --provider facebook` | `facebook` | `@holo-js/auth-social-facebook` | `email public_profile` |
| Apple | `bunx holo install auth --social --provider apple` | `apple` | `@holo-js/auth-social-apple` | `name email` |
| LinkedIn | `bunx holo install auth --social --provider linkedin` | `linkedin` | `@holo-js/auth-social-linkedin` | `openid profile email` |

Those default scopes come from the first-party provider packages. Override them only when your application needs a
different upstream permission set.

## Configuration

```ts
import { defineAuthConfig } from '@holo-js/config'

export default defineAuthConfig({
  social: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: 'https://app.example.com/auth/google/callback',
      scopes: ['openid', 'email', 'profile'],
      guard: 'web',
    },
  },
})
```

Provider keys map to first-party packages:

- `google` -> `@holo-js/auth-social-google`
- `github` -> `@holo-js/auth-social-github`
- `discord` -> `@holo-js/auth-social-discord`
- `facebook` -> `@holo-js/auth-social-facebook`
- `apple` -> `@holo-js/auth-social-apple`
- `linkedin` -> `@holo-js/auth-social-linkedin`

Custom providers can point at any package that exports a social runtime:

```ts
import { defineAuthConfig } from '@holo-js/config'

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
import { defineAuthConfig } from '@holo-js/config'

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

## Redirecting Users

Your route calls the social runtime:

```ts
import { redirect } from '@holo-js/auth-social'

export async function GET(request: Request) {
  return redirect('google', request)
}
```

The provider name in `redirect('google', request)` must match the provider key in `config/auth.ts`.

Typical route shapes:

- `GET /auth/google`
- `GET /auth/google/callback`
- `GET /auth/github`
- `GET /auth/github/callback`

## Handling The Callback

```ts
import { callback } from '@holo-js/auth-social'

export async function GET(request: Request) {
  return callback('google', request)
}
```

The callback route should receive the upstream `code` and `state` values, then pass the full request through to Holo.
Holo validates the state, verifies PKCE when that provider flow uses it, exchanges the authorization code, links the
identity, and establishes the local session.

The callback flow:

- validates the saved state
- validates PKCE data
- exchanges the authorization code
- loads the provider profile
- resolves or creates a local user
- links the social identity
- establishes a local authenticated session

Each provider package handles its own upstream field mapping. Holo does not guess raw provider response shapes across
different services.

## Provider Examples

### Google

Install:

```bash
bunx holo install auth --social --provider google
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
bunx holo install auth --social --provider github
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
bunx holo install auth --social --provider discord
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
bunx holo install auth --social --provider facebook
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
bunx holo install auth --social --provider apple
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
bunx holo install auth --social --provider linkedin
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
