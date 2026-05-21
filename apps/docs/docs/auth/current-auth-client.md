# Current Auth Client

Auth client state is read-only. Login, register, logout, impersonation, password hashing, and provider operations stay on
the server through `@holo-js/auth`.

Use the auth client helper for your framework:

- Next.js: `@holo-js/auth/next/client`
- Nuxt: `@holo-js/auth/nuxt`
- SvelteKit: `@holo-js/auth/sveltekit/client`

Each framework auth entrypoint exposes `useAuth()`. The returned `user` is inferred as `HoloAuthUser | null`, so application code can read
`auth.user`, `user.value`, or `auth.authenticated` without writing a local user shape type.

## `user`, `provider`, and `refreshUser`

`user` is the current auth state the client already has. It is reactive in the framework adapters:

- Next.js: `auth.user`
- Nuxt: `user.value`
- SvelteKit: `auth.user`

`provider` identifies the current session source. Local Holo sessions return the local auth provider name, such as
`users` or `admins`. Hosted sessions return `workos` or `clerk`. Unauthenticated states return `null`.

- Next.js: `auth.provider`
- Nuxt: `provider.value`
- SvelteKit: `auth.provider`

`refreshUser()` makes a new request to the current-user endpoint, updates that current auth state, and returns the fresh
user. It also refreshes `provider`.

Use `user` to render the current navigation, profile link, or authenticated UI. Use `refreshUser()` after an action that
can change auth state, such as login, register, logout, switching guards, or updating the user's profile.

```ts
const current = auth.user
const sessionSource = auth.provider
const fresh = await auth.refreshUser()
```

## Refreshing After Auth Actions

The client helper does not perform login or register itself. Your route changes the cookie/session, then the client
calls `refreshUser()` so the framework state matches the new server state before rendering auth-aware UI.

::: code-group

```tsx [Next.js — login/register success]
'use client'

import { useRouter } from 'next/navigation'
import { useAuth } from '@holo-js/auth/next/client'
import { useForm } from '@holo-js/adapter-next/client'
import { loginForm } from '@/lib/schemas/login'

export default function LoginPage() {
  const router = useRouter()
  const auth = useAuth()
  const form = useForm(loginForm, {
    async submitter({ formData }) {
      const response = await fetch('/api/login', { method: 'POST', body: formData })
      const submission = await response.json()

      if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
        try {
          await auth.refreshUser()
        } catch (error) {
          console.warn('Auth refresh failed after login.', error)
        }

        router.replace(submission.data.redirectTo)
      }

      return submission
    },
  })

  return <form onSubmit={(event) => { event.preventDefault(); form.submit() }} />
}
```

```vue [Nuxt — login/register success]
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '~/lib/schemas/login'

const { refreshUser } = await useAuth()
const form = useForm(loginForm, {
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })

    if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
      try {
        await refreshUser()
      } catch (error) {
        console.warn('Auth refresh failed after login.', error)
      }

      await navigateTo(submission.data.redirectTo)
    }

    return submission
  },
})
</script>
```

```svelte [SvelteKit — login/register success]
<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import { useAuth } from '@holo-js/auth/sveltekit/client'
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/login'

  const auth = useAuth()
  const form = useForm(loginForm, {
    async submitter({ formData }) {
      const response = await fetch('/api/login', { method: 'POST', body: formData })
      const submission = await response.json()

      if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
        try {
          await auth.refreshUser()
        } catch (error) {
          console.warn('Auth refresh failed after login.', error)
        }

        await invalidateAll()
        await goto(submission.data.redirectTo)
      }

      return submission
    },
  })
</script>
```

:::

## Client Usage

::: code-group

```tsx [Next.js]
'use client'

import { useAuth } from '@holo-js/auth/next/client'
import { useRouter } from 'next/navigation'

export function AuthNav() {
  const auth = useAuth()
  const router = useRouter()
  const displayName = auth.user?.name ?? auth.user?.email ?? 'Account'

  async function logout() {
    const response = await fetch('/api/logout', { method: 'POST' })
    if (!response.ok) {
      return
    }

    try {
      await auth.refreshUser()
    } catch (error) {
      console.warn('Auth refresh failed after logout.', error)
    }

    router.replace('/')
  }

  if (!auth.authenticated) {
    return (
      <>
        <a href="/login">Login</a>
        <a href="/register">Register</a>
      </>
    )
  }

  return (
    <>
      <span>{displayName}</span>
      <button type="button" onClick={logout}>Logout</button>
    </>
  )
}
```

```vue [Nuxt]
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'

const { authenticated, provider, refreshUser, user } = await useAuth()
const displayName = computed(() => user.value?.name ?? user.value?.email ?? 'Account')

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  try {
    await refreshUser()
  } catch (error) {
    console.warn('Auth refresh failed after logout.', error)
  }

  await navigateTo('/')
}
</script>

<template>
  <template v-if="authenticated">
    <span>{{ displayName }}</span>
    <button type="button" @click="logout">Logout</button>
  </template>
  <template v-else>
    <NuxtLink to="/login">Login</NuxtLink>
    <NuxtLink to="/register">Register</NuxtLink>
  </template>
</template>
```

```svelte [SvelteKit]
<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { untrack } from 'svelte'
  import { useAuth } from '@holo-js/auth/sveltekit/client'
  import type { LayoutProps } from './$types'

  let { data, children }: LayoutProps = $props()

  const auth = useAuth({
    initialProvider: untrack(() => data.auth.provider),
    initialUser: untrack(() => data.auth.user),
  })
  const displayName = $derived(auth.user?.name ?? auth.user?.email ?? 'Account')

  async function logout() {
    const response = await fetch('/api/logout', { method: 'POST' })
    if (!response.ok) {
      return
    }

    try {
      await auth.refreshUser()
    } catch (error) {
      console.warn('Auth refresh failed after logout.', error)
    }

    try {
      await invalidateAll()
    } catch (error) {
      console.warn('Auth invalidation failed after logout.', error)
    }
  }
</script>

{#if auth.authenticated}
  <span>{displayName}</span>
  <button type="button" onclick={logout}>Logout</button>
{:else}
  <a href="/login">Login</a>
  <a href="/register">Register</a>
{/if}

{@render children()}
```

:::

## Initial Server State

Next.js and SvelteKit can pass the server-resolved user into the client helper so the first render already knows whether
the visitor is authenticated.

::: code-group

```tsx [Next.js — app/layout.tsx]
import { AuthProvider } from '@holo-js/auth/next/client'
import { auth } from '@holo-js/auth/next/server'
import { AuthNav } from './auth-nav'

export default async function RootLayout({ children }: { readonly children: React.ReactNode }) {
  const currentAuth = await auth()

  return (
    <html lang="en">
      <body>
        <AuthProvider initialProvider={currentAuth.provider} initialUser={currentAuth.user}>
          <AuthNav />
          {children}
        </AuthProvider>
      </body>
    </html>
  )
}
```

```vue [Nuxt — app/app.vue]
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'

const { authenticated, provider, refreshUser, user } = await useAuth()
</script>
```

```ts [SvelteKit — src/routes/+layout.server.ts]
import { auth } from '@holo-js/auth/sveltekit/server'

export async function load() {
  return {
    auth: await auth(),
  }
}
```

:::

Nuxt's `useAuth()` is async because it uses Nuxt's server/client data fetching state. The composable fetches
`/api/auth/user` by default and stores the result in a keyed Nuxt state ref.

## Current User Endpoint

The framework auth helpers need an application-owned current-auth endpoint. The default endpoint is `/api/auth/user`.
When `auth` is selected during scaffolding, Holo writes this endpoint for the selected framework so `useAuth()` works
without extra setup.

This endpoint is only for reading current auth state. Login, register, logout, password reset, email verification, and
route protection remain application-owned routes and middleware.

If your app uses a different current-auth URL, pass `endpoint` to the framework helper or provider:

::: code-group

```tsx [Next.js]
const auth = useAuth({ endpoint: '/api/me' })

<AuthProvider endpoint="/api/me" initialProvider={currentAuth.provider} initialUser={currentAuth.user}>
  {children}
</AuthProvider>
```

```vue [Nuxt]
const { authenticated, provider, refreshUser, user } = await useAuth({ endpoint: '/api/me' })
```

```svelte [SvelteKit]
const auth = useAuth({ endpoint: '/api/me' })
```

```ts [Framework-neutral]
import { configureAuthClient, refreshUser } from '@holo-js/auth/client'

configureAuthClient({ endpoint: '/api/me' })

const user = await refreshUser()
```

:::

For a non-default guard, pass `guard` to the framework auth helper. The client appends that guard to the
current-auth request query string, so `useAuth({ guard: 'admin' })` reads `/api/auth/user?guard=admin` by default.

::: code-group

```tsx [Next.js]
const auth = useAuth({ guard: 'admin' })
```

```vue [Nuxt]
const { authenticated, refreshUser, user } = await useAuth({ guard: 'admin' })
```

```svelte [SvelteKit]
const auth = useAuth({ guard: 'admin' })
```

:::

If you combine `guard` with a custom endpoint, the guard is still sent as a query string parameter:

```ts
const auth = useAuth({ endpoint: '/api/me', guard: 'admin' })
```

::: code-group

```ts [Next.js — app/api/auth/user/route.ts]
import auth, { check, provider, user } from '@holo-js/auth'

export async function GET(request: Request) {
  const guard = new URL(request.url).searchParams.get('guard') ?? undefined
  const guardAuth = guard ? auth.guard(guard) : undefined

  return Response.json({
    authenticated: guardAuth ? await guardAuth.check() : await check(),
    guard: guard ?? 'web',
    provider: guardAuth ? await guardAuth.provider() : await provider(),
    user: guardAuth ? await guardAuth.user() : await user(),
  })
}
```

```ts [Nuxt — server/api/auth/user.get.ts]
import auth, { check, provider, user } from '@holo-js/auth'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const guard = typeof query.guard === 'string' ? query.guard : undefined
  const guardAuth = guard ? auth.guard(guard) : undefined

  return {
    authenticated: guardAuth ? await guardAuth.check() : await check(),
    guard: guard ?? 'web',
    provider: guardAuth ? await guardAuth.provider() : await provider(),
    user: guardAuth ? await guardAuth.user() : await user(),
  }
})
```

```ts [SvelteKit — src/routes/api/auth/user/+server.ts]
import { json } from '@sveltejs/kit'
import auth, { check, provider, user } from '@holo-js/auth'

export async function GET({ url }: { url: URL }) {
  const guard = url.searchParams.get('guard') ?? undefined
  const guardAuth = guard ? auth.guard(guard) : undefined

  return json({
    authenticated: guardAuth ? await guardAuth.check() : await check(),
    guard: guard ?? 'web',
    provider: guardAuth ? await guardAuth.provider() : await provider(),
    user: guardAuth ? await guardAuth.user() : await user(),
  })
}
```

:::

The default scaffolded endpoint supports both the default guard and named guards. If you write your own endpoint, keep
the same behavior when the app calls `useAuth({ guard: 'admin' })`.

## Types

Most app code should not import a user type. The type is inferred from your auth provider configuration and exposed
through `useAuth().user`.

If reusable library code really needs an explicit annotation, import the public type from the adapter or auth client:

::: code-group

```ts [Next.js]
import { type HoloAuthUser } from '@holo-js/auth/next/client'
```

```ts [Nuxt]
import { type HoloAuthUser } from '@holo-js/auth/nuxt'
```

```ts [SvelteKit]
import { type HoloAuthUser } from '@holo-js/auth/sveltekit/client'
```

```ts [Framework-neutral]
import { type HoloAuthUser } from '@holo-js/auth/client'
```

:::

## Lower-Level Client

`@holo-js/auth/client` is still available for framework-neutral browser code. It exposes:

- `useAuth()`
- `user()`
- `provider()`
- `refreshUser()`
- `check()`

```ts
import { check, provider, refreshUser, useAuth, user } from '@holo-js/auth/client'

const auth = await useAuth()
const current = auth.user
const sessionSource = auth.provider
const authenticated = auth.check()
const fresh = await auth.refreshUser()

await user()
await provider()
await check()
await refreshUser()
```

The lower-level client calls the same current-auth endpoint, may cache `user()`, and `refreshUser()` always forces a new
request.

It does not expose:

- `login()` or `register()`
- `loginUsing()` or `loginUsingId()`
- `hashPassword()`, `verifyPassword()`, or `needsPasswordRehash()`
- `impersonate()` or `stopImpersonating()`
