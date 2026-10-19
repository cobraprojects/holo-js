# Guards and Providers

Guards and providers let one app authenticate different kinds of users in different ways. A **guard** decides how a request proves who it is: a session cookie or a bearer token. A **provider** decides which model the user is loaded from. Use them to add a separate admin area or an API.

## Add an admin area

This config keeps normal users on the `web` guard, adds an `admin` guard backed by an `Admin` model, and adds an `api` guard for bearer tokens:

```ts [config/auth.ts]
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  defaults: {
    guard: 'web',
  },
  guards: {
    web: { driver: 'session', provider: 'users' },
    admin: { driver: 'session', provider: 'admins' },
    api: { driver: 'token', provider: 'users' },
  },
  providers: {
    users: { model: 'User', identifiers: ['email'] },
    admins: { model: 'Admin', identifiers: ['email'] },
  },
})
```

The `Admin` model needs the same auth columns as `User`: an email, a nullable `password`, `email_verified_at` if you use [email verification](/auth/email-verification), and a nullable `remember_token` if you use [remember me](/auth/session-and-cookies#remember-me). Copy the `users` migration and model as a starting point.

Then sign admins in through their guard:

::: code-group

```ts [Next.js]
// app/admin/login/actions.ts
'use server'

import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { redirect } from 'next/navigation'
import { loginForm } from '@/lib/schemas/auth'

export async function adminLoginAction(formData: FormData) {
  const input = await validate(formData, loginForm, { throttle: 'login' })

  await auth.guard('admin').login(input)

  redirect('/admin')
}
```

```ts [Nuxt]
// server/api/admin/login.post.ts
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, { throttle: 'login' })

  await auth.guard('admin').login(input)

  return { ok: true, status: 200, data: { redirectTo: '/admin' } }
})
```

```ts [SvelteKit]
// src/routes/admin/login/+page.server.ts
import { redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '$lib/schemas/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const input = await validate(request, loginForm, { throttle: 'login' })

    await auth.guard('admin').login(input)

    redirect(303, '/admin')
  },
} satisfies Actions
```

:::

## Use a guard

The top-level helpers (`login()`, `user()`, `logout()`, and so on) use `defaults.guard`. Everything they do is also available on `auth.guard(name)`:

```ts
import auth, { user } from '@holo-js/auth'

const siteUser = await user()
const admin = await auth.guard('admin').user()
await auth.guard('admin').logout()
```

Each guard tracks its own user. A browser can be signed in on `web` and `admin` at the same time, and logging out of one leaves the other signed in.

Guard names and drivers are typed from `config/auth.ts`. `auth.guard('api')` knows it's a token guard, so `login()` returns a token instead of a session. Run `npx holo prepare` after editing guards to refresh these types.

## Guard drivers

| Driver | How requests authenticate | `login()` returns | `register()` returns |
| --- | --- | --- | --- |
| `session` | Session cookie | A session (and sets the cookie) | The new user |
| `token` | `Authorization: Bearer <token>` header | A new API token | A new API token |

Session-only methods, such as `loginUsing()`, `flash()`, `logoutOtherDevices()`, impersonation, and `multiFactor`, exist only on session guards. See [API Tokens](/auth/api-tokens) for token guards.

## Provider options

| Option | Default | Description |
| --- | --- | --- |
| `model` | required | The model name, such as `'User'` |
| `identifiers` | `['email']` | Fields users sign in with. See [Sign in with email or phone](/auth/local-auth#sign-in-with-email-or-phone) |

A guard's `provider` defaults to `'users'`. Guards, providers, and brokers must reference each other by names that exist; Holo throws at startup if one doesn't.

## Protect pages for a guard

Pass `guard` to `authOnly()` and `guestOnly()`:

::: code-group

```ts [Next.js]
// proxy.ts
import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'

export const proxy = protectRoutes(
  guestOnly({ guard: 'admin', routes: ['/admin/login'], redirectTo: '/admin' }),
  authOnly({ guard: 'admin', routes: [(path) => path.startsWith('/admin') && path !== '/admin/login'], redirectTo: '/admin/login' }),
)

export const config = {
  matcher: ['/admin/:path*'],
}
```

```ts [Nuxt]
// app/middleware/admin.ts
import { authOnly } from '@holo-js/auth/nuxt/server'

export default authOnly({
  guard: 'admin',
  redirectTo: '/admin/login',
})
```

```ts [SvelteKit]
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks'
import { authOnly, guestOnly } from '@holo-js/auth/sveltekit/server'

export const handle = sequence(
  guestOnly({ guard: 'admin', routes: ['/admin/login'], redirectTo: '/admin' }),
  authOnly({ guard: 'admin', routes: [(path) => path.startsWith('/admin') && path !== '/admin/login'], redirectTo: '/admin/login' }),
)
```

:::

In Nuxt, add `definePageMeta({ middleware: 'admin' })` to each admin page.

On the client, read the admin with `useAuth({ guard: 'admin' })`. See [Current User on the Client](/auth/current-user#options).

## Choose a guard for social and hosted login

[Social Login](/auth/social-login), [WorkOS](/auth/workos), and [Clerk](/auth/clerk) sign users in on the default guard. Set `guard` on a provider to use another one, and `mapToProvider` to store those users in a different provider's model:

```ts [config/auth.ts]
social: {
  google: {
    clientId: env('AUTH_GOOGLE_CLIENT_ID'),
    clientSecret: env('AUTH_GOOGLE_CLIENT_SECRET'),
    redirectUri: env('AUTH_GOOGLE_REDIRECT_URI'),
    guard: 'admin',
  },
},
```

Without `mapToProvider`, users go to the provider of the chosen guard.

## Password resets for another provider

Password reset brokers point at a provider. Add one per provider and pick it with `broker`:

```ts [config/auth.ts]
passwords: {
  users: { provider: 'users' },
  admins: { provider: 'admins', route: '/admin/reset-password' },
},
```

```ts
await requestPasswordReset({ email }, { broker: 'admins' })
```

See [Password Reset](/auth/password-reset).

## Next steps

- [Login and Registration](/auth/local-auth)
- [API Tokens](/auth/api-tokens)
- [Authorization with guards](/authorization/with-auth)
