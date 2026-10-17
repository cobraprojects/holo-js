# Current User on the Client

`useAuth()` gives your components the signed-in user, so you can show a name, a logout button, or links for guests. It only reads auth state. Logging in and out still happens in server routes, as shown in [Login and Registration](/auth/local-auth).

## Show the user in your layout

::: code-group

```tsx [Next.js]
// app/auth-nav.tsx
'use client'

import Link from 'next/link'
import { useAuth } from '@holo-js/auth/next/client'
import { logoutAction } from './logout/actions'

export function AuthNav() {
  const auth = useAuth()

  if (!auth.authenticated) {
    return <Link href="/login">Log in</Link>
  }

  return (
    <form action={logoutAction}>
      <span>{auth.user?.name}</span>
      <button type="submit">Log out</button>
    </form>
  )
}
```

```vue [Nuxt]
<!-- app/components/AuthNav.vue -->
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'

const { authenticated, user, refreshUser } = await useAuth()

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  await refreshUser()
  await navigateTo('/')
}
</script>

<template>
  <template v-if="authenticated">
    <span>{{ user?.name }}</span>
    <button type="button" @click="logout">Log out</button>
  </template>
  <NuxtLink v-else to="/login">Log in</NuxtLink>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { untrack } from 'svelte'
  import { useAuth } from '@holo-js/auth/sveltekit/client'
  import type { LayoutProps } from './$types'

  let { data, children }: LayoutProps = $props()

  const auth = useAuth({
    initialProvider: untrack(() => data.auth.provider),
    initialUser: untrack(() => data.auth.user),
  })
</script>

{#if auth.authenticated}
  <span>{auth.user?.name}</span>
  <form action="/logout" method="post">
    <button type="submit">Log out</button>
  </form>
{:else}
  <a href="/login">Log in</a>
{/if}

{@render children()}
```

:::

The `user` type comes from your `User` model, so `auth.user?.name` autocompletes without a type annotation. The user is your model's JSON form, so `hidden` fields like `password` are never sent to the browser.

## Load the user on the server first

Pass the server's auth state to the client so the first render already knows who is signed in. Without it, the page renders as a guest and then updates after a request.

::: code-group

```tsx [Next.js]
// app/layout.tsx
import type { ReactNode } from 'react'
import { AuthProvider } from '@holo-js/auth/next/client'
import { auth } from '@holo-js/auth/next/server'
import { AuthNav } from './auth-nav'

export default async function RootLayout({ children }: { children: ReactNode }) {
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

```vue [Nuxt]
<!-- app/app.vue -->
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'

await useAuth()
</script>

<template>
  <NuxtPage />
</template>
```

```ts [SvelteKit]
// src/routes/+layout.server.ts
import { auth } from '@holo-js/auth/sveltekit/server'
import type { LayoutServerLoad } from './$types'

export const load = (async () => ({
  auth: await auth(),
})) satisfies LayoutServerLoad
```

:::

In Nuxt, `useAuth()` already fetches during server rendering and shares the result with the browser through Nuxt state. Every component that calls it reads the same state.

In Next.js, components inside `<AuthProvider>` that call `useAuth()` with no options share the provider's state. The provider fetches the user again when the path changes. You can put the provider in a nested layout if only part of the app needs it.

In SvelteKit, the layout that calls `useAuth()` shares its state with child components. They call `useAuth()` with no options to get it.

`auth()` from `@holo-js/auth/next/server` and `@holo-js/auth/sveltekit/server` returns:

```ts
{
  authenticated: boolean
  guard: string
  provider: string | null
  user: HoloAuthUser | null
}
```

## Refresh after a change

`refreshUser()` fetches the current user again and updates every component using the same state. Call it after a change that doesn't reload the page, like a profile update or a client-side login in Nuxt.

```ts
const freshUser = await auth.refreshUser()
```

Next.js server actions that call `revalidatePath('/', 'layout')` and SvelteKit actions that redirect already reload the data, so they don't need it.

## What `useAuth()` returns

| Property | Next.js / SvelteKit | Nuxt |
| --- | --- | --- |
| `authenticated` | `boolean` | `Ref<boolean>` (read-only) |
| `user` | `HoloAuthUser \| null` | `Ref<HoloAuthUser \| null>` |
| `provider` | `string \| null` | `Ref<string \| null>` |
| `refreshUser()` | `Promise<HoloAuthUser \| null>` | `Promise<HoloAuthUser \| null>` |

Nuxt's `useAuth()` is async, so `await` it in `<script setup>`.

`provider` tells you how the user signed in: your provider name (such as `'users'`) for password and social login, or `'workos'` / `'clerk'` for hosted login. Use it to show the right logout button:

```tsx
{auth.provider === 'workos' && (
  <form action="/api/auth/workos/logout" method="post">
    <button type="submit">Log out of WorkOS</button>
  </form>
)}
```

## Options

| Option | Frameworks | Description |
| --- | --- | --- |
| `guard` | all | Read a non-default guard, such as `'admin'`. Sent as `?guard=admin` |
| `endpoint` | all | Current-user URL. Default `/api/auth/user` |
| `headers` | Next.js, SvelteKit | Extra request headers |
| `initialUser`, `initialProvider` | Next.js, SvelteKit | Server-loaded state for the first render |
| `key` | Nuxt | State key, when you need two separate copies of the same endpoint |

```ts
const adminAuth = useAuth({ guard: 'admin' })
```

`<AuthProvider>` in Next.js takes the same options as props.

## The current-user endpoint

`useAuth()` reads `GET /api/auth/user`. `npx holo install auth` creates this route in Next.js (`app/api/auth/user/route.ts`) and Nuxt (`server/api/auth/user.get.ts`). In SvelteKit, Holo serves it from its generated server hook, so there's no file to edit.

The route returns:

```json
{
  "authenticated": true,
  "guard": "web",
  "provider": "users",
  "user": { "id": 1, "name": "Ava", "email": "ava@example.com" }
}
```

If you replace it with your own route, keep this shape and support the `guard` query parameter. Then point `useAuth()` at it with `endpoint`:

```ts
const auth = useAuth({ endpoint: '/api/me' })
```

## Type the user yourself

You rarely need this, but shared code can import the user type:

```ts
import { type HoloAuthUser } from '@holo-js/auth/next/client'
```

It's also exported from `@holo-js/auth/nuxt`, `@holo-js/auth/sveltekit/client`, and `@holo-js/auth/client`.

## Without a framework adapter

`@holo-js/auth/client` works in any browser code. It fetches the same endpoint and caches the result until you call `refreshUser()`.

```ts
import { check, configureAuthClient, provider, refreshUser, user } from '@holo-js/auth/client'

configureAuthClient({ endpoint: '/api/me' })

const signedIn = await check()
const currentUser = await user()
const source = await provider()
const freshUser = await refreshUser()
```

Every function also accepts `{ guard, endpoint, headers }`. `configureAuthClient()` also accepts a custom `fetch`.

## Next steps

- [Login and Registration](/auth/local-auth)
- [Guards and Providers](/auth/guards-and-providers)
- [Client-Side Forms](/basics/forms/client)
