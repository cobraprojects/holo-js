# Current Auth Client

Auth client state is read-only. Login, register, logout, impersonation, password hashing, and provider operations stay on
the server through `@holo-js/auth`.

Use the adapter client helper for your framework:

- Next.js: `@holo-js/adapter-next/client`
- Nuxt: `@holo-js/adapter-nuxt/client`
- SvelteKit: `@holo-js/adapter-sveltekit/client`

Each adapter exposes `useAuth()`. The returned `user` is inferred as `HoloAuthUser | null`, so application code can read
`auth.user`, `user.value`, or `auth.authenticated` without writing a local user shape type.

## `user` vs `refreshUser`

`user` is the current auth state the client already has. It is reactive in the framework adapters:

- Next.js: `auth.user`
- Nuxt: `user.value`
- SvelteKit: `auth.user`

`refreshUser()` makes a new request to the current-user endpoint, updates that current auth state, and returns the fresh
user.

Use `user` to render the current navigation, profile link, or authenticated UI. Use `refreshUser()` after an action that
can change auth state, such as login, register, logout, switching guards, or updating the user's profile.

```ts
const current = auth.user
const fresh = await auth.refreshUser()
```

## Refreshing After Auth Actions

The client helper does not perform login or register itself. Your route changes the cookie/session, then the client
calls `refreshUser()` so the framework state matches the new server state before rendering auth-aware UI.

::: code-group

```tsx [Next.js — login/register success]
'use client'

import { useRouter } from 'next/navigation'
import { useAuth, useForm } from '@holo-js/adapter-next/client'
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
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '~/lib/schemas/login'

const { refreshUser } = await useAuth()
const form = useForm(loginForm, {
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })

    if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
      await refreshUser()
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
  import { useAuth, useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/login'

  const auth = useAuth()
  const form = useForm(loginForm, {
    async submitter({ formData }) {
      const response = await fetch('/api/login', { method: 'POST', body: formData })
      const submission = await response.json()

      if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
        await auth.refreshUser()
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

import { useAuth } from '@holo-js/adapter-next/client'

export function AuthNav() {
  const auth = useAuth()
  const displayName = auth.user?.name ?? auth.user?.email ?? 'Account'

  async function logout() {
    const response = await fetch('/api/logout', { method: 'POST' })
    if (!response.ok) {
      return
    }

    await auth.refreshUser()
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
const { authenticated, refreshUser, user } = await useAuth()
const displayName = computed(() => user.value?.name ?? user.value?.email ?? 'Account')

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  await refreshUser()
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
  import { useAuth } from '@holo-js/adapter-sveltekit/client'
  import type { LayoutProps } from './$types'

  let { data, children }: LayoutProps = $props()

  const auth = useAuth({ initialUser: untrack(() => data.auth.user) })
  const displayName = $derived(auth.user?.name ?? auth.user?.email ?? 'Account')

  async function logout() {
    const response = await fetch('/api/logout', { method: 'POST' })
    if (!response.ok) {
      return
    }

    await auth.refreshUser()
    await invalidateAll()
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
import { AuthProvider } from '@holo-js/adapter-next/client'
import { auth } from '@holo-js/adapter-next/server'
import { AuthNav } from './auth-nav'

export default async function RootLayout({ children }: { readonly children: React.ReactNode }) {
  const currentAuth = await auth()

  return (
    <html lang="en">
      <body>
        <AuthProvider initialUser={currentAuth.user}>
          <AuthNav />
          {children}
        </AuthProvider>
      </body>
    </html>
  )
}
```

```vue [Nuxt — app.vue]
<script setup lang="ts">
const { authenticated, refreshUser, user } = await useAuth()
</script>
```

```ts [SvelteKit — src/routes/+layout.server.ts]
import { auth } from '@holo-js/adapter-sveltekit/server'

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

The adapter helpers need an application-owned current-auth endpoint. The default endpoint is `/api/auth/user`.

::: code-group

```ts [Next.js — app/api/auth/user/route.ts]
import { check, user } from '@holo-js/auth'

export async function GET() {
  return Response.json({
    authenticated: await check(),
    guard: 'web',
    user: await user(),
  })
}
```

```ts [Nuxt — server/api/auth/user.get.ts]
import { check, user } from '@holo-js/auth'

export default defineEventHandler(async () => {
  return {
    authenticated: await check(),
    guard: 'web',
    user: await user(),
  }
})
```

```ts [SvelteKit — src/routes/api/auth/user/+server.ts]
import { json } from '@sveltejs/kit'
import { check, user } from '@holo-js/auth'

export async function GET() {
  return json({
    authenticated: await check(),
    guard: 'web',
    user: await user(),
  })
}
```

:::

For a named guard, pass `guard` to the adapter helper and return that guard's state from the endpoint.

## Types

Most app code should not import a user type. The type is inferred from your auth provider configuration and exposed
through `useAuth().user`.

If reusable library code really needs an explicit annotation, import the public type from the adapter or auth client:

::: code-group

```ts [Next.js]
import { type HoloAuthUser } from '@holo-js/adapter-next/client'
```

```ts [Nuxt]
import { type HoloAuthUser } from '@holo-js/adapter-nuxt/client'
```

```ts [SvelteKit]
import { type HoloAuthUser } from '@holo-js/adapter-sveltekit/client'
```

```ts [Framework-neutral]
import { type HoloAuthUser } from '@holo-js/auth/client'
```

:::

## Lower-Level Client

`@holo-js/auth/client` is still available for framework-neutral browser code. It exposes:

- `useAuth()`
- `user()`
- `refreshUser()`
- `check()`

```ts
import { check, refreshUser, useAuth, user } from '@holo-js/auth/client'

const auth = await useAuth()
const current = auth.user
const authenticated = auth.check()
const fresh = await auth.refreshUser()

await user()
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
