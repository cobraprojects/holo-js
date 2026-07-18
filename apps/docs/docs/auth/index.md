# Authentication

Authentication in Holo is built from a small set of composable packages:

- `@holo-js/session` for session state and cookie handling.
- `@holo-js/auth` for local user authentication, guards, providers, session auth, and personal access tokens.
- `@holo-js/auth-social` for the shared social sign-in runtime, plus one provider package per configured provider.
- `@holo-js/auth-workos` for hosted WorkOS identity synced into your local user model.
- `@holo-js/auth-clerk` for hosted Clerk identity synced into your local user model.

The application owns the route, request parsing, validation, and response shape. Holo exposes the authentication
operations and runtime services that your routes call.

## Server vs Client

`@holo-js/auth` is the server package.

Use it inside your server routes, actions, loaders, RPC handlers, jobs, and any other trusted backend code. It owns
operations that can create sessions, verify passwords, hash passwords, impersonate users, issue tokens, and mutate
auth state.

`@holo-js/auth/client` is the browser-friendly package.

Use it only to read current-auth state from your own endpoint. It does not expose login, trusted login, password
hashing, password verification, token creation, or impersonation helpers.

## Introduction

At the core of the auth system are two concepts: guards and providers.

- Guards define how an incoming request is authenticated.
- Providers define which local model a guard resolves into.

A session guard maintains login state using session storage and cookies. A token guard authenticates each request using
a personal access token. Both guards can point at different local models, such as `User` and `Admin`.

All auth flows resolve into a local model owned by your application. That includes:

- local email / phone / username login
- local session authentication
- personal access tokens
- social login
- WorkOS
- Clerk

This lets you keep one application-owned source of truth for users, admins, and any other model that participates in
authentication.

## Package Overview

Install only the packages you need:

```bash
npx holo install auth
npx holo install auth --social --provider google
npx holo install auth --social --provider github
npx holo install auth --social --provider google,github
npx holo install auth --workos
npx holo install auth --clerk
```

When `auth` is installed, `session` and `security` are installed with it automatically because session-backed auth
depends on cookies, CSRF/rate-limit defaults, and CORS support for separate frontend/API deployments.

## Authentication Quickstart

Start with the auth and session config files:

```ts
// config/auth.ts
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'
export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
    api: {
      driver: 'token',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
      identifiers: ['email'],
    },
  },
  emailVerification: {
    required: true,
    route: env('AUTH_EMAIL_VERIFICATION_ROUTE', '/verify-email'),
  },
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
      route: env('AUTH_PASSWORD_RESET_ROUTE', '/reset-password'),
    },
  },
})
```

```ts
// config/session.ts
import { defineSessionConfig } from '@holo-js/session'
export default defineSessionConfig({
  driver: 'database',
  cookie: {
    name: 'holo_session',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  },
})
```

Then use auth operations inside your own routes. With `@holo-js/forms`, failed values are sanitized
by the form schema before they are sent back to the client:

```ts
import { login, logout, refreshUser, register, user } from '@holo-js/auth'
import { field, schema, validate } from '@holo-js/forms'

const registerForm = schema({
  name: field.string().required(),
  email: field.string().required().email(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required(),
  remember: field.boolean().default(false),
})

export async function POST(request: Request) {
  const data = await validate(request, registerForm)

  const created = await register(data)

  return Response.json(created, { status: 201 })
}

export async function PUT(request: Request) {
  const data = await validate(request, loginForm)

  const session = await login(data)

  return Response.json({
    authenticated: true,
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
    user: await refreshUser(),
  })
}

export async function DELETE() {
  await logout()

  return Response.json({
    authenticated: false,
    user: await user(),
  })
}
```

When email verification is enabled, successful login can redirect the user to the configured verification route
instead of rejecting the login attempt.

## Retrieving The Authenticated User

Use the default export or direct named exports:

```ts
import auth, { check, id, refreshUser, user } from '@holo-js/auth'

const authenticated = await check()
const currentUser = await user()
const currentUserId = await id()
const freshUser = await refreshUser()
const adminUser = await auth.guard('admin').user()
```

`user()` may return the current cached auth state for the active request context. `refreshUser()` forces a fresh model
lookup for the selected guard.

## Protecting Routes

Route protection stays explicit in your application code. The framework adapters provide server-side helpers for common
page protection:

- `authOnly(...)` redirects guests away from protected pages.
- `guestOnly(...)` redirects signed-in users away from guest pages like login and register.

Both helpers accept exact paths, wildcard paths such as `/admin/*`, RegExp matchers, or predicate functions.
The base auth scaffold does not generate `/login`, `/register`, `/logout`, admin pages, or these protection entrypoints;
add this wiring when those routes exist in your application.

::: code-group

```ts [Next.js 16 proxy.ts]
import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'

export const proxy = protectRoutes(
  guestOnly({
    routes: ['/login', '/register', '/forgot-password', '/reset-password'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)

export const config = {
  matcher: ['/login', '/register', '/forgot-password', '/reset-password', '/admin/:path*'],
}
```

```ts [Nuxt 4 app/middleware/auth-only.global.ts]
import { authOnly } from '@holo-js/auth/nuxt/server'

export default authOnly({
  // guard is optional here; omitted means the configured default guard.
  routes: ['/admin/*'],
  redirectTo: '/login',
})
```

```ts [Nuxt 4 app/middleware/guest-only.global.ts]
import { guestOnly } from '@holo-js/auth/nuxt/server'

export default guestOnly({
  // guard is optional here; omitted means the configured default guard.
  routes: ['/login', '/register', '/forgot-password', '/reset-password'],
  redirectTo: '/admin',
})
```

```ts [SvelteKit hooks.server.ts]
import { sequence } from '@sveltejs/kit/hooks'
import { authOnly, guestOnly } from '@holo-js/auth/sveltekit/server'

export const handle = sequence(
  guestOnly({
    routes: ['/login', '/register', '/forgot-password', '/reset-password'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)
```

:::

Nuxt route middleware accepts an optional `guard`. Omit it for the configured default guard:

```ts
authOnly({ routes, redirectTo, guard?: string })
guestOnly({ routes, redirectTo, guard?: string })
```

Pass `guard` only when that middleware protects pages for a non-default guard:

```ts [Nuxt 4 app/middleware/super-admin.global.ts]
import { authOnly, guestOnly } from '@holo-js/auth/nuxt/server'

const superAdminGuestOnly = guestOnly({
  guard: 'admin',
  routes: ['/super-admin/login'],
  redirectTo: '/super-admin',
})

const superAdminAuthOnly = authOnly({
  guard: 'admin',
  routes: ['/super-admin/*'],
  redirectTo: '/super-admin/login',
})

export default defineNuxtRouteMiddleware(async (to, from) => {
  const guestRedirect = await superAdminGuestOnly(to, from)

  if (guestRedirect) {
    return guestRedirect
  }

  return superAdminAuthOnly(to, from)
})
```

You can compose your own framework middleware with the Holo helpers. Keep custom logic in the same native entrypoint and
return a response only when it wants to stop the request.

::: code-group

```ts [Next.js 16 proxy.ts]
import { authOnly, protectRoutes } from '@holo-js/auth/next/server'

function maintenanceProxy() {
  if (process.env.MAINTENANCE_MODE === 'true') {
    return new Response('Down for maintenance.', { status: 503 })
  }
}

export const proxy = protectRoutes(
  maintenanceProxy,
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)
```

```ts [SvelteKit hooks.server.ts]
import { sequence } from '@sveltejs/kit/hooks'
import { authOnly } from '@holo-js/auth/sveltekit/server'
import { MAINTENANCE_MODE } from '$env/static/private'

export const handle = sequence(
  ({ event, resolve }) => {
    if (event.url.pathname.startsWith('/admin') && MAINTENANCE_MODE === 'true') {
      return new Response('Down for maintenance.', { status: 503 })
    }

    return resolve(event)
  },
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)
```

```ts [Nuxt 4 app/middleware/maintenance.global.ts]
export default defineNuxtRouteMiddleware((to) => {
  const config = useRuntimeConfig()

  if (to.path.startsWith('/admin') && config.public.maintenanceMode === true) {
    return abortNavigation('Down for maintenance.')
  }
})
```

:::

For API handlers, return a `401` from the server boundary:

```ts
import { check } from '@holo-js/auth'

export async function GET() {
  if (!(await check())) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  return Response.json({ ok: true })
}
```

To protect a non-default guard:

```ts
import auth from '@holo-js/auth'

export async function GET() {
  if (!(await auth.guard('admin').check())) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  return Response.json({ ok: true })
}
```

## Manual Authentication

Manual authentication is the normal Holo flow. Your application validates the request first, then passes the validated
payload to `login()` or `register()`.

```ts
import { login } from '@holo-js/auth'

const session = await login({
  email: 'ava@example.com',
  password: 'secret-secret',
})
```

Successful auth calls return their typed value directly. Expected auth failures throw a `ValidationException` with an
HTTP status and field errors. For example, invalid credentials produce a serialized validation payload like:

```ts
{
  ok: false,
  status: 422,
  valid: false,
  errors: {
    email: ['These credentials do not match our records.'],
  },
}
```

The Forms adapters consume that exception through the same error path as schema validation and keep sensitive values
out of serialized responses. Unexpected configuration, database, and session failures continue to throw their original
errors.

The auth runtime uses the validated payload itself. If your credentials are based on `phone`, pass `phone`.

```ts
const session = await login({
  phone: '20123456789',
  password: 'secret-secret',
})
```

This keeps credential validation in your application and keeps auth configuration focused on guards and providers
instead of request field mapping.

## Logging Out

Session logout:

```ts
import { logout } from '@holo-js/auth'

const signedOut = await logout()
```

Guard-specific logout:

```ts
import auth from '@holo-js/auth'

const signedOut = await auth.guard('admin').logout()
```

`logout()` is still the only user-facing API. It clears the selected Holo auth guard and returns serialized
forget-cookie headers in `signedOut.cookies`.

When the guard is backed by Clerk or WorkOS, the same `logout()` call also clears the configured hosted-provider session
cookie for that guard so the next request does not transparently re-authenticate from the hosted cookie alone.

Token logout and revocation are covered in the personal access token guide.

## Choosing A Flow

Use session auth when:

- the request comes from your browser-based application
- you want cookie-based login state
- you want remember-me behavior

Use personal access tokens when:

- a mobile client or external client needs stateless API access
- the request will include a bearer token
- you want token abilities

Use WorkOS or Clerk when:

- the identity system is hosted remotely
- your application still needs a local user or admin model
- the local model should be synchronized from the hosted identity

Use social login when:

- the local user model is still canonical
- the user signs in through an OAuth provider
- the external identity should link into your local user model

## Next Steps

- [Session And Cookies](/auth/session-and-cookies)
- [Local Auth](/auth/local-auth)
- [Guards And Providers](/auth/guards-and-providers)
- [Personal Access Tokens](/auth/personal-access-tokens)
- [Social Login](/auth/social-login)
- [WorkOS](/auth/workos)
- [Clerk](/auth/clerk)
- [Email Verification](/auth/email-verification)
- [Password Reset](/auth/password-reset)
- [Current Auth Client](/auth/current-auth-client)
