# Login and Registration

This page shows how to build email-and-password auth: a register route, a login route, a logout route, and protected pages. You write the routes; Holo checks passwords, creates sessions, and sets cookies.

## Register a user

`register()` creates the user and hashes the password. It does not sign the user in, so call `loginUsing()` with the new user, then redirect.

::: code-group

```ts [Next.js]
// app/register/actions.ts
'use server'

import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { registerForm } from '@/lib/schemas/auth'

export async function registerAction(formData: FormData) {
  const input = await validate(formData, registerForm, { throttle: 'register' })

  const created = await register(input)
  const session = await loginUsing(created)

  revalidatePath('/', 'layout')
  redirect(session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/dashboard')
}
```

```ts [Nuxt]
// server/api/register.post.ts
import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { registerForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, registerForm, { throttle: 'register' })

  const created = await register(input)
  const session = await loginUsing(created)

  setResponseStatus(event, 201)
  return {
    ok: true,
    status: 201,
    data: {
      redirectTo: session.emailVerificationRequired
        ? session.emailVerificationRoute ?? '/verify-email'
        : '/dashboard',
    },
  }
})
```

```ts [SvelteKit]
// src/routes/register/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { registerForm } from '$lib/schemas/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const input = await validate(request, registerForm, { throttle: 'register' })

    const created = await register(input)
    const session = await loginUsing(created)

    redirect(303, session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/dashboard')
  },
} satisfies Actions
```

:::

The schema needs a `password` and a `passwordConfirmation` field. Any extra fields, like `name`, are saved on the user:

```ts [lib/schemas/auth.ts]
import { field, schema } from '@holo-js/validation'

export const registerForm = schema({
  name: field.string().required().min(3),
  email: field.string().required().email(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

export const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required(),
  remember: field.boolean().default(false),
})
```

The `throttle` option uses the `login` and `register` limiters from `config/security.ts`. See [Rate Limiting](/basics/security/rate-limiting).

If [email verification](/auth/email-verification) is required, `register()` also sends the verification email.

## Log a user in

`login()` checks the credentials, starts a new session, and sets the session cookie.

::: code-group

```ts [Next.js]
// app/login/actions.ts
'use server'

import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { loginForm } from '@/lib/schemas/auth'

export async function loginAction(formData: FormData) {
  const input = await validate(formData, loginForm, { throttle: 'login' })

  const session = await login(input)

  revalidatePath('/', 'layout')
  redirect(session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/dashboard')
}
```

```ts [Nuxt]
// server/api/login.post.ts
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, { throttle: 'login' })

  const session = await login(input)

  return {
    ok: true,
    status: 200,
    data: {
      redirectTo: session.emailVerificationRequired
        ? session.emailVerificationRoute ?? '/verify-email'
        : '/dashboard',
    },
  }
})
```

```ts [SvelteKit]
// src/routes/login/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '$lib/schemas/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const input = await validate(request, loginForm, { throttle: 'login' })

    const session = await login(input)

    redirect(303, session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/dashboard')
  },
} satisfies Actions
```

:::

In Nuxt, the page submits to the API route and navigates with `navigateTo()`. Call `refreshUser()` first so the navigation bar shows the new user:

```vue [app/pages/login.vue]
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '#shared/schemas/auth'

const { refreshUser } = await useAuth()
const form = useForm(loginForm, {
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })
    if (submission?.ok === true) {
      await refreshUser()
      await navigateTo(submission.data.redirectTo)
    }
    return submission
  },
})
</script>
```

See [Client-Side Forms](/basics/forms/client) for rendering fields and errors with `useForm()`.

### What `login()` returns

| Field | Description |
| --- | --- |
| `user` | The signed-in user |
| `guard` | The guard used, such as `'web'` |
| `provider` | The user provider, such as `'users'` |
| `sessionId` | The new session ID |
| `cookies` | The `Set-Cookie` values Holo already added to the response |
| `emailVerificationRequired` | `true` when verification is required and the user is not verified yet |
| `emailVerificationRoute` | Where to send the user, for example `/verify-email?email=ava%40example.com` |
| `multiFactorChallenge` | Set when the user has two-factor auth on. See [Multi-Factor Auth](/auth/multi-factor) |

### When login or registration fails

Expected failures throw a `ValidationException`, so your form shows them like any other [validation error](/basics/validation/errors):

| Situation | Field | Message | Status |
| --- | --- | --- | --- |
| Wrong email or password | `email` | These credentials do not match our records. | 422 |
| Identifier already registered | `email` | A user with this email already exists. | 422 |
| `password` and `passwordConfirmation` differ | both fields | | 422 |

## Remember the user

Pass `remember: true` to keep the user signed in after the browser closes. The `loginForm` above already sends it from a checkbox.

```ts
await login({ email, password, remember: true })
await loginUsing(user, { remember: true })
```

The remember-me cookie lasts for `rememberMeLifetime` minutes from `config/session.ts` (30 days by default). See [Sessions and Cookies](/auth/session-and-cookies).

## Log the user out

`logout()` ends the session and clears the auth cookies.

::: code-group

```ts [Next.js]
// app/logout/actions.ts
'use server'

import { logout } from '@holo-js/auth'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function logoutAction() {
  await logout()

  revalidatePath('/', 'layout')
  redirect('/')
}
```

```ts [Nuxt]
// server/api/logout.post.ts
import { logout } from '@holo-js/auth'

export default defineEventHandler(async () => {
  await logout()

  return { ok: true }
})
```

```ts [SvelteKit]
// src/routes/logout/+server.ts
import { redirect } from '@sveltejs/kit'
import { logout } from '@holo-js/auth'

export async function POST() {
  await logout()

  redirect(303, '/')
}
```

:::

Use a `POST` form or request for logout, so a link or prefetch can't sign the user out. In Nuxt, call the route from the page, then refresh and navigate:

```ts
await $fetch('/api/logout', { method: 'POST' })
await refreshUser()
await navigateTo('/')
```

## Protect pages

Use `authOnly()` to send guests to the login page, and `guestOnly()` to send signed-in users away from pages like `/login`. Each framework has its own entry point.

::: code-group

```ts [Next.js]
// proxy.ts
import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'

export const proxy = protectRoutes(
  guestOnly({
    routes: ['/login', '/register', '/forgot-password', '/reset-password'],
    redirectTo: '/dashboard',
  }),
  authOnly({
    routes: ['/dashboard/*'],
    redirectTo: '/login',
  }),
)

export const config = {
  matcher: ['/login', '/register', '/forgot-password', '/reset-password', '/dashboard/:path*'],
}
```

```ts [Nuxt]
// app/middleware/auth.global.ts
import { authOnly } from '@holo-js/auth/nuxt/server'

export default authOnly({
  routes: ['/dashboard/*'],
  redirectTo: '/login',
})
```

```ts [SvelteKit]
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks'
import { authOnly, guestOnly } from '@holo-js/auth/sveltekit/server'

export const handle = sequence(
  guestOnly({
    routes: ['/login', '/register', '/forgot-password', '/reset-password'],
    redirectTo: '/dashboard',
  }),
  authOnly({
    routes: ['/dashboard/*'],
    redirectTo: '/login',
  }),
)
```

:::

In Nuxt, add a second global middleware file for `guestOnly()`, or drop the `.global` suffix and the `routes` option to use it as named middleware on specific pages:

```ts [app/middleware/guest.ts]
import { guestOnly } from '@holo-js/auth/nuxt/server'

export default guestOnly({ redirectTo: '/dashboard' })
```

```vue [app/pages/login.vue]
<script setup lang="ts">
definePageMeta({ middleware: 'guest' })
</script>
```

In Next.js, `protectRoutes()` runs each check in order and returns the first redirect. Put your own functions in the list too; return a `Response` to stop the request or nothing to continue.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `redirectTo` | required | Where to send the visitor |
| `routes` | every route | Paths to check. Supports exact paths (`'/login'`), prefixes (`'/dashboard/*'`, which also matches `/dashboard`), `RegExp`, and `(pathname) => boolean` |
| `guard` | default guard | Check a different guard, such as `'admin'` |
| `status` | `303` | Redirect status: `301`, `302`, `303`, `307`, or `308` |

A check never redirects to the page the visitor is already on.

### Check the user inside a page or action

Route protection covers navigation. Server actions and API routes still need their own check, because they can be called directly.

::: code-group

```ts [Next.js]
// app/dashboard/actions.ts
'use server'

import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'

export async function saveSettingsAction(formData: FormData) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated) {
    redirect('/login')
  }

  // currentAuth.user is the signed-in user
}
```

```ts [Nuxt]
// server/api/settings.post.ts
import { user } from '@holo-js/auth'

export default defineEventHandler(async (event) => {
  const currentUser = await user()
  if (!currentUser) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthenticated.' })
  }

  return { ok: true }
})
```

```ts [SvelteKit]
// src/routes/dashboard/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { auth } from '@holo-js/auth/sveltekit/server'
import type { PageServerLoad } from './$types'

export const load = (async () => {
  const currentAuth = await auth()
  if (!currentAuth.authenticated) {
    redirect(303, '/login')
  }

  return { user: currentAuth.user }
}) satisfies PageServerLoad
```

:::

For JSON APIs, return a `401`:

```ts [app/api/orders/route.ts]
import { check } from '@holo-js/auth'

export async function GET() {
  if (!(await check())) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  return Response.json({ ok: true })
}
```

## Sign in with email or phone

`identifiers` lists the fields a user can sign in with. Holo looks the user up by whichever identifier the input contains, and `register()` rejects duplicates on every identifier.

```ts [config/auth.ts]
providers: {
  users: {
    model: 'User',
    identifiers: ['email', 'phone'],
  },
},
```

```ts
await login({ phone: '+201234567890', password })
```

Give every identifier column a unique index in your migration. Other fields, like `name` or `country`, are stored on the user but never used to find them.

## Sign in a user you already trust

`loginUsing()` and `loginUsingId()` start a session without a password. Use them after registration, a magic link, an invite link, or a social login callback.

```ts
import auth, { loginUsing, loginUsingId } from '@holo-js/auth'

await loginUsing(user, { remember: true })
await loginUsingId(42)
await auth.guard('admin').loginUsing(admin)
```

::: danger
`loginUsing()` skips password and email-verification checks. Only call it after your own code has proved who the user is.
:::

## Hash and check passwords yourself

Use these when you import users, build a "change password" form, or keep a password history. They use the same hasher as `register()`.

```ts
import { hashPassword, needsPasswordRehash, verifyPassword } from '@holo-js/auth'

const digest = await hashPassword('new-password')
const matches = await verifyPassword('current-password', user.password)
const outdated = await needsPasswordRehash(user.password)
```

`needsPasswordRehash()` tells you a hash was made with older settings. When it returns `true` after a successful `verifyPassword()`, hash the plain password again and save it.

## Impersonate a user

Impersonation lets a signed-in admin act as another user, then switch back. Check that the admin is allowed with [authorization](/authorization/) first.

```ts
import auth, { impersonation, stopImpersonating } from '@holo-js/auth'

await auth.guard('web').impersonateById(userId, { actorGuard: 'admin' })

const active = await impersonation()
// active?.actor is the admin, active?.user is the impersonated user

await stopImpersonating()
```

`actorGuard` is the guard the admin is signed in on. It defaults to the guard you call `impersonate()` on. You can't start impersonating while already impersonating. `stopImpersonating()` restores the previous user on that guard, or signs the guard out if there was none.

## Reference

All functions come from `@holo-js/auth` and use the default guard. Call them on `auth.guard(name)` to use another guard.

| Function | Returns |
| --- | --- |
| `register(input)` | The created user |
| `login(credentials)` | The new session |
| `loginUsing(user, { remember? })` | The new session |
| `loginUsingId(id, { remember? })` | The new session |
| `logout()` | `{ guard, cookies }` |
| `check()` | `true` if a user is signed in |
| `user()` | The signed-in user or `null` |
| `refreshUser()` | The user, re-read from the database |
| `id()` | The user's ID or `null` |
| `provider()` | `'users'`, `'workos'`, `'clerk'`, or `null` |
| `findUserById(id)` | A user from the guard's provider, or `null` |
| `impersonate(user, options?)` / `impersonateById(id, options?)` | The new session |
| `impersonation()` | `{ guard, actorGuard, user, actor, originalUser, startedAt }` or `null` |
| `stopImpersonating()` | The restored user or `null` |
| `hashPassword(password)` / `verifyPassword(password, digest)` / `needsPasswordRehash(digest)` | Password helpers |

## Next steps

- [Sessions and Cookies](/auth/session-and-cookies)
- [Current User on the Client](/auth/current-user)
- [Email Verification](/auth/email-verification)
- [Password Reset](/auth/password-reset)
- [Guards and Providers](/auth/guards-and-providers)
