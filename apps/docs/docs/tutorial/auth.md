# 7. Authentication

In this chapter you add accounts. Visitors can register, sign in, and sign out, and only signed-in users can reach `/admin`. New posts are saved with the signed-in user as the author.

## What you'll build

- `/login` and `/register` pages
- a sign-out button and the user's name in the header
- route protection: guests are sent from `/admin` to `/login`, and signed-in users are sent from `/login` to `/admin`
- posts saved with the signed-in author

## Step 1: Look at what's already set up

Because you selected `auth` when creating the project, most of the setup exists already:

| File | What it does |
| --- | --- |
| `config/auth.ts` | A `web` guard that signs users in with a session, using the `User` model and the `email` column |
| `config/session.ts` | Where sessions are stored (files in `storage/framework/sessions` by default) and the session cookie settings |
| `config/security.ts` | CSRF settings, plus `login` and `register` rate limits |
| `server/models/User.ts` | The user model, with `password` hidden from JSON |
| `server/db/migrations/` | The `users`, `sessions`, and other auth tables you migrated in chapter 2 |

Holo hashes passwords and sets and clears the session cookie. Your code only calls `login()`, `register()`, and `logout()`.

## Step 2: Add the auth form schemas

::: code-group

```ts [Next.js]
// lib/schemas/auth.ts
import { field, schema } from '@holo-js/validation'

export const logoutForm = schema({})

export const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export const registerForm = schema({
  name: field.string().required('Name is required.').min(3, 'Name must be at least 3 characters.'),
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.').confirmed(),
  passwordConfirmation: field.password().required('Please confirm your password.'),
})
```

```ts [Nuxt]
// shared/schemas/auth.ts
import { field, schema } from '@holo-js/validation'

export const logoutForm = schema({})

export const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export const registerForm = schema({
  name: field.string().required('Name is required.').min(3, 'Name must be at least 3 characters.'),
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.').confirmed(),
  passwordConfirmation: field.password().required('Please confirm your password.'),
})
```

```ts [SvelteKit]
// src/lib/schemas/auth.ts
import { field, schema } from '@holo-js/validation'

export const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export const registerForm = schema({
  name: field.string().required('Name is required.').min(3, 'Name must be at least 3 characters.'),
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.').confirmed(),
  passwordConfirmation: field.password().required('Please confirm your password.'),
})
```

:::

- `field.password()` is a string field meant for passwords.
- `.confirmed()` requires a matching `passwordConfirmation` field.
- `remember` keeps the user signed in for longer (the "remember me" lifetime in `config/session.ts`).

## Step 3: Handle sign-in, registration, and sign-out on the server

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
  const input = await validate(formData, loginForm, {
    throttle: 'login',
  })

  const session = await login(input)

  const redirectTo = session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/admin'

  revalidatePath('/', 'layout')
  redirect(redirectTo)
}

// app/register/actions.ts
'use server'

import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { registerForm } from '@/lib/schemas/auth'

export async function registerAction(formData: FormData) {
  const input = await validate(formData, registerForm, {
    throttle: 'register',
  })

  const created = await register(input)
  const session = await loginUsing(created)

  const redirectTo = session.emailVerificationRequired
    ? session.emailVerificationRoute ?? '/verify-email'
    : '/admin'

  revalidatePath('/', 'layout')
  redirect(redirectTo)
}

// app/logout/actions.ts
'use server'

import { logout } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { logoutForm } from '@/lib/schemas/auth'

export async function logoutAction(formData: FormData) {
  await validate(formData, logoutForm)
  await logout()
  revalidatePath('/', 'layout')
  redirect('/')
}
```

```ts [Nuxt]
// server/api/login.post.ts
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, {
    throttle: 'login',
  })

  const session = await login(input)

  return {
    ok: true,
    status: 200,
    data: {
      redirectTo: session.emailVerificationRequired
        ? session.emailVerificationRoute ?? '/verify-email'
        : '/admin',
      user: session.user,
    },
  }
})

// server/api/register.post.ts
import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, registerForm, {
    throttle: 'register',
  })

  const created = await register(input)
  const session = await loginUsing(created)

  setResponseStatus(event, 201)
  return {
    ok: true,
    status: 201,
    data: {
      redirectTo: session.emailVerificationRequired
        ? session.emailVerificationRoute ?? '/verify-email'
        : '/admin',
      user: session.user,
    },
  }
})

// server/api/logout.post.ts
import { logout } from '@holo-js/auth'

export default defineEventHandler(async () => {
  await logout()

  return { ok: true }
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
    const input = await validate(request, loginForm, {
      throttle: 'login',
    })

    const session = await login(input)

    redirect(303, session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin')
  },
} satisfies Actions

// src/routes/register/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '$lib/schemas/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const input = await validate(request, registerForm, {
      throttle: 'register',
    })

    const created = await register(input)
    const session = await loginUsing(created)

    redirect(303, session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin')
  },
} satisfies Actions

// src/routes/logout/+server.ts
import { redirect } from '@sveltejs/kit'
import { logout } from '@holo-js/auth'

export async function POST() {
  await logout()
  redirect(303, '/')
}
```

:::

What these calls do:

- **`validate(..., { throttle: 'login' })`** applies the `login` rate limit from `config/security.ts` (5 attempts per minute) before checking the fields.
- **`login(input)`** checks the email and password, starts a session, and sets the session cookie. Wrong credentials show up as a form error.
- **`register(input)`** hashes the password and creates the user. **`loginUsing(user)`** signs that user in.
- **`logout()`** ends the session and clears the cookie.
- You redirect with your framework's own `redirect()`. Holo has already written the cookie by then.

## Step 4: Build the sign-in and registration pages

::: code-group

```tsx [Next.js]
// app/login/page.tsx
'use client'

import Link from 'next/link'
import { useForm } from '@holo-js/adapter-next/client'

import { loginForm } from '@/lib/schemas/auth'
import { loginAction } from './actions'

export default function LoginPage() {
  const form = useForm(loginForm, {
    validateOn: 'blur',
    initialValues: { email: '', password: '', remember: false },
    async submitter({ formData }) {
      return await loginAction(formData)
    },
  })
  const formError = form.errors.first('_root')

  return (
    <section>
      <h1>Sign in</h1>
      <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
        {formError ? <p>{formError}</p> : null}
        <label>
          Email
          <input name="email" type="email" value={form.values.email} onInput={(event) => form.fields.email.onInput(event.currentTarget.value)} onBlur={() => form.fields.email.onBlur()} />
          {form.errors.has('email') ? <span>{form.errors.first('email')}</span> : null}
        </label>
        <label>
          Password
          <input name="password" type="password" value={form.values.password} onInput={(event) => form.fields.password.onInput(event.currentTarget.value)} onBlur={() => form.fields.password.onBlur()} />
          {form.errors.has('password') ? <span>{form.errors.first('password')}</span> : null}
        </label>
        <label>
          <input name="remember" type="checkbox" checked={form.values.remember} onChange={(event) => form.fields.remember.onInput(event.currentTarget.checked)} />
          Remember me
        </label>
        <button type="submit" disabled={form.submitting}>{form.submitting ? 'Signing in...' : 'Sign in'}</button>
      </form>
      <Link href="/register">Create account</Link>
    </section>
  )
}

// app/register/page.tsx
'use client'

import Link from 'next/link'
import { useForm } from '@holo-js/adapter-next/client'

import { registerForm } from '@/lib/schemas/auth'
import { registerAction } from './actions'

export default function RegisterPage() {
  const form = useForm(registerForm, {
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      return await registerAction(formData)
    },
  })
  const formError = form.errors.first('_root')

  return (
    <section>
      <h1>Create account</h1>
      <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
        {formError ? <p>{formError}</p> : null}
        <label>
          Name
          <input name="name" value={form.values.name} onInput={(event) => form.fields.name.onInput(event.currentTarget.value)} onBlur={() => form.fields.name.onBlur()} />
          {form.errors.has('name') ? <span>{form.errors.first('name')}</span> : null}
        </label>
        <label>
          Email
          <input name="email" type="email" value={form.values.email} onInput={(event) => form.fields.email.onInput(event.currentTarget.value)} onBlur={() => form.fields.email.onBlur()} />
          {form.errors.has('email') ? <span>{form.errors.first('email')}</span> : null}
        </label>
        <label>
          Password
          <input name="password" type="password" value={form.values.password} onInput={(event) => form.fields.password.onInput(event.currentTarget.value)} onBlur={() => form.fields.password.onBlur()} />
          {form.errors.has('password') ? <span>{form.errors.first('password')}</span> : null}
        </label>
        <label>
          Confirm password
          <input name="passwordConfirmation" type="password" value={form.values.passwordConfirmation} onInput={(event) => form.fields.passwordConfirmation.onInput(event.currentTarget.value)} onBlur={() => form.fields.passwordConfirmation.onBlur()} />
          {form.errors.has('passwordConfirmation') ? <span>{form.errors.first('passwordConfirmation')}</span> : null}
        </label>
        <button type="submit" disabled={form.submitting}>{form.submitting ? 'Creating account...' : 'Create account'}</button>
      </form>
      <Link href="/login">Already have an account?</Link>
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/login/index.vue -->
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '#shared/schemas/auth'

const { refreshUser } = await useAuth()
const form = useForm(loginForm, {
  validateOn: 'blur',
  initialValues: { email: '', password: '', remember: false },
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })
    if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
      await refreshUser()
      await navigateTo(submission.data.redirectTo, { external: true })
    }
    return submission
  },
})
</script>

<template>
  <section>
    <h1>Sign in</h1>
    <form @submit.prevent="form.submit()">
      <label>
        Email
        <input name="email" type="email" v-model="form.values.email" @blur="form.fields.email.onBlur()" />
        <span v-if="form.errors.has('email')">{{ form.errors.first('email') }}</span>
      </label>
      <label>
        Password
        <input name="password" type="password" v-model="form.values.password" @blur="form.fields.password.onBlur()" />
        <span v-if="form.errors.has('password')">{{ form.errors.first('password') }}</span>
      </label>
      <label>
        <input name="remember" type="checkbox" v-model="form.values.remember" />
        Remember me
      </label>
      <button :disabled="form.submitting">{{ form.submitting ? 'Signing in...' : 'Sign in' }}</button>
    </form>
    <NuxtLink to="/register">Create account</NuxtLink>
  </section>
</template>

<!-- app/pages/register/index.vue -->
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { registerForm } from '#shared/schemas/auth'

const { refreshUser } = await useAuth()
const form = useForm(registerForm, {
  validateOn: 'blur',
  initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
  async submitter({ formData }) {
    const submission = await $fetch('/api/register', { method: 'POST', body: formData })
    if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
      await refreshUser()
      await navigateTo(submission.data.redirectTo, { redirectCode: 302 })
    }
    return submission
  },
})
</script>

<template>
  <section>
    <h1>Create account</h1>
    <form @submit.prevent="form.submit()">
      <label>
        Name
        <input name="name" v-model="form.values.name" @blur="form.fields.name.onBlur()" />
        <span v-if="form.errors.has('name')">{{ form.errors.first('name') }}</span>
      </label>
      <label>
        Email
        <input name="email" type="email" v-model="form.values.email" @blur="form.fields.email.onBlur()" />
        <span v-if="form.errors.has('email')">{{ form.errors.first('email') }}</span>
      </label>
      <label>
        Password
        <input name="password" type="password" v-model="form.values.password" @blur="form.fields.password.onBlur()" />
        <span v-if="form.errors.has('password')">{{ form.errors.first('password') }}</span>
      </label>
      <label>
        Confirm password
        <input name="passwordConfirmation" type="password" v-model="form.values.passwordConfirmation" @blur="form.fields.passwordConfirmation.onBlur()" />
        <span v-if="form.errors.has('passwordConfirmation')">{{ form.errors.first('passwordConfirmation') }}</span>
      </label>
      <button :disabled="form.submitting">{{ form.submitting ? 'Creating account...' : 'Create account' }}</button>
    </form>
    <NuxtLink to="/login">Already have an account?</NuxtLink>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/login/+page.svelte -->
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/auth'
  import type { PageData } from './$types'

  export let data: PageData

  const login = useForm(loginForm, {
    validateOn: 'blur',
    initialValues: { email: '', password: '', remember: false },
  })
  $: formError = login.errors.first('_root')
</script>

<section>
  <h1>Sign in</h1>
  <form method="post">
    <input {...data.csrf.input} />
    {#if formError}<p>{formError}</p>{/if}
    <label>
      Email
      <input name="email" type="email" value={login.values.email} on:input={(event) => login.fields.email.onInput(event.currentTarget.value)} on:blur={() => login.fields.email.onBlur()} />
      {#if login.errors.has('email')}<span>{login.errors.first('email')}</span>{/if}
    </label>
    <label>
      Password
      <input name="password" type="password" value={login.values.password} on:input={(event) => login.fields.password.onInput(event.currentTarget.value)} on:blur={() => login.fields.password.onBlur()} />
      {#if login.errors.has('password')}<span>{login.errors.first('password')}</span>{/if}
    </label>
    <label>
      <input name="remember" type="checkbox" checked={login.values.remember} on:change={(event) => login.fields.remember.onInput(event.currentTarget.checked)} />
      Remember me
    </label>
    <button type="submit" disabled={login.submitting}>{login.submitting ? 'Signing in...' : 'Sign in'}</button>
  </form>
  <a href="/register">Create account</a>
</section>

<!-- src/routes/register/+page.svelte -->
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { registerForm } from '$lib/schemas/auth'
  import type { PageData } from './$types'

  export let data: PageData

  const register = useForm(registerForm, {
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
  })
  $: formError = register.errors.first('_root')
</script>

<section>
  <h1>Create account</h1>
  <form method="post">
    <input {...data.csrf.input} />
    {#if formError}<p>{formError}</p>{/if}
    <label>
      Name
      <input name="name" value={register.values.name} on:input={(event) => register.fields.name.onInput(event.currentTarget.value)} on:blur={() => register.fields.name.onBlur()} />
      {#if register.errors.has('name')}<span>{register.errors.first('name')}</span>{/if}
    </label>
    <label>
      Email
      <input name="email" type="email" value={register.values.email} on:input={(event) => register.fields.email.onInput(event.currentTarget.value)} on:blur={() => register.fields.email.onBlur()} />
      {#if register.errors.has('email')}<span>{register.errors.first('email')}</span>{/if}
    </label>
    <label>
      Password
      <input name="password" type="password" value={register.values.password} on:input={(event) => register.fields.password.onInput(event.currentTarget.value)} on:blur={() => register.fields.password.onBlur()} />
      {#if register.errors.has('password')}<span>{register.errors.first('password')}</span>{/if}
    </label>
    <label>
      Confirm password
      <input name="passwordConfirmation" type="password" value={register.values.passwordConfirmation} on:input={(event) => register.fields.passwordConfirmation.onInput(event.currentTarget.value)} on:blur={() => register.fields.passwordConfirmation.onBlur()} />
      {#if register.errors.has('passwordConfirmation')}<span>{register.errors.first('passwordConfirmation')}</span>{/if}
    </label>
    <button type="submit" disabled={register.submitting}>{register.submitting ? 'Creating account...' : 'Create account'}</button>
  </form>
  <a href="/login">Already have an account?</a>
</section>
```

:::

`form.errors.first('_root')` holds errors that aren't about one field, such as "these credentials don't match" or "too many attempts".

## Step 5: Show the user and a sign-out button

In SvelteKit, first replace the root layout's server file from chapter 5 so it also returns the auth state:

```ts [src/routes/+layout.server.ts]
import { auth } from '@holo-js/auth/sveltekit/server'
import { csrf } from '@holo-js/security'
import type { LayoutServerLoad } from './$types'

export const load = (async ({ request }) => {
  const currentAuth = await auth()

  return {
    auth: currentAuth,
    csrf: { input: await csrf.input(request) },
  }
}) satisfies LayoutServerLoad
```

Then add the header in each framework:

::: code-group

```tsx [Next.js]
// app/layout.tsx
import type { ReactNode } from 'react'
import Link from 'next/link'
import { AuthProvider } from '@holo-js/auth/next/client'
import { auth } from '@holo-js/auth/next/server'

import { AuthNav } from './auth-nav'

export default async function RootLayout({ children }: { children: ReactNode }) {
  const currentAuth = await auth()

  return (
    <html lang="en">
      <body>
        <AuthProvider initialProvider={currentAuth.provider} initialUser={currentAuth.user}>
          <header>
            <nav>
              <Link href="/">Blog</Link>
              <Link href="/posts">Posts</Link>
              <Link href="/admin">Admin</Link>
              <AuthNav />
            </nav>
          </header>
          <main>{children}</main>
        </AuthProvider>
      </body>
    </html>
  )
}

// app/auth-nav.tsx
'use client'

import Link from 'next/link'
import { useForm } from '@holo-js/adapter-next/client'
import { useAuth } from '@holo-js/auth/next/client'

import { logoutForm } from '@/lib/schemas/auth'
import { logoutAction } from './logout/actions'

export function AuthNav() {
  const auth = useAuth()
  const form = useForm(logoutForm, {
    submitter: ({ formData }) => logoutAction(formData),
  })
  const displayName = auth.user?.name ?? auth.user?.email ?? 'Account'

  if (!auth.authenticated) {
    return (
      <>
        <Link href="/login">Login</Link>
        <Link href="/register">Register</Link>
      </>
    )
  }

  return (
    <>
      <span>{displayName}</span>
      <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
        <button type="submit">Logout</button>
      </form>
    </>
  )
}
```

```vue [Nuxt]
<!-- app/app.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { useAuth } from '@holo-js/auth/nuxt'
import { logoutForm } from '#shared/schemas/auth'

const { authenticated, refreshUser, user } = await useAuth()
const displayName = computed(() => user.value?.name ?? user.value?.email ?? 'Account')

const form = useForm(logoutForm, {
  async submitter({ formData }) {
    await $fetch('/api/logout', { method: 'POST', body: formData })
    await refreshUser()
    await navigateTo('/')
  },
})
</script>

<template>
  <div>
    <header>
      <nav>
        <NuxtLink to="/">Blog</NuxtLink>
        <NuxtLink to="/posts">Posts</NuxtLink>
        <NuxtLink to="/admin">Admin</NuxtLink>
        <template v-if="authenticated">
          <span>{{ displayName }}</span>
          <button type="button" @click="form.submit()">Logout</button>
        </template>
        <template v-else>
          <NuxtLink to="/login">Login</NuxtLink>
          <NuxtLink to="/register">Register</NuxtLink>
        </template>
      </nav>
    </header>
    <main>
      <NuxtPage />
    </main>
  </div>
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
    initialProvider: untrack(() => data?.auth?.provider ?? null),
    initialUser: untrack(() => data?.auth?.user ?? null),
  })
  const displayName = $derived(auth.user?.name ?? auth.user?.email ?? 'Account')
</script>

<header>
  <nav>
    <a href="/">Blog</a>
    <a href="/posts">Posts</a>
    <a href="/admin">Admin</a>
    {#if auth.authenticated}
      <span>{displayName}</span>
      <form action="/logout" method="post">
        <input {...data.csrf.input} />
        <button type="submit">Logout</button>
      </form>
    {:else}
      <a href="/login">Login</a>
      <a href="/register">Register</a>
    {/if}
  </nav>
</header>
<main>
  {@render children()}
</main>
```

:::

- On the server, **`auth()`** returns the current auth state: `authenticated`, `user`, and `provider`.
- In the browser, **`useAuth()`** gives components the same state. Next.js and SvelteKit seed it from the server so the first render is already correct. In Nuxt, call `refreshUser()` after signing in or out.

## Step 6: Protect the admin routes

Send guests away from `/admin`, and send signed-in users away from `/login` and `/register`.

::: code-group

```ts [Next.js]
// proxy.ts
import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'
import { csrfProtection } from '@holo-js/security/next/server'

const csrf = csrfProtection()
const auth = protectRoutes(
  guestOnly({
    routes: ['/login', '/register'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)

export async function proxy(request: Parameters<typeof csrf>[0]) {
  const csrfResponse = await csrf(request)
  if (csrfResponse?.status === 419) {
    return csrfResponse
  }

  const authResponse = await auth(request)
  return authResponse ?? csrfResponse
}
```

```ts [Nuxt]
// app/middleware/auth-only.global.ts
import { authOnly } from '@holo-js/auth/nuxt/server'

export default authOnly({
  routes: ['/admin/*'],
  redirectTo: '/login',
})

// app/middleware/guest-only.global.ts
import { guestOnly } from '@holo-js/auth/nuxt/server'

export default guestOnly({
  routes: ['/login', '/register'],
  redirectTo: '/admin',
})
```

```ts [SvelteKit]
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks'
import { authOnly, guestOnly } from '@holo-js/auth/sveltekit/server'
import { csrfProtection } from '@holo-js/security/sveltekit/server'

export const handle = sequence(
  csrfProtection(),
  guestOnly({
    routes: ['/login', '/register'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)
```

:::

- **Next.js**: the project creator made a `proxy.ts` that only ran CSRF protection. Replace it with the version above, which runs CSRF protection first and then the route rules.
- **Nuxt**: files ending in `.global.ts` in `app/middleware/` run on every page navigation. CSRF protection already runs from `server/middleware/csrf.ts`.
- **SvelteKit**: this turns on CSRF protection for the first time. Your forms already include `data.csrf.input`, so they keep working.

## Step 7: Save the signed-in user as the author

Route rules protect pages. Server code that writes data should also check who is signed in. Update the post-creating code:

::: code-group

```ts [Next.js]
// app/admin/actions.ts
import { auth } from '@holo-js/auth/next/server'

export async function createPostAction(formData: FormData) {
  try {
    const currentAuth = await auth()
    if (!currentAuth.authenticated || !currentAuth.user) {
      redirect('/login')
    }

    const data = await validate(formData, postForm)
    await createPost({
      ...data,
      authorId: currentAuth.user.id,
    })

    redirect('/admin/posts')
  } catch (error) {
    if (isValidationException(error)) {
      return error.toJSON()
    }

    throw error
  }
}
```

```ts [Nuxt]
// server/routes/admin/posts/create.post.ts
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { createPost } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const user = await auth.user()
  if (!user) return sendRedirect(event, '/login', 303)

  const data = await validate(await readFormData(event), postForm)
  await createPost({
    ...data,
    authorId: user.id,
  })

  return sendRedirect(event, '/admin/posts', 303)
})
```

```ts [SvelteKit]
// src/routes/admin/posts/new/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { auth } from '@holo-js/auth/sveltekit/server'
import { validate } from '@holo-js/forms'

import { postForm } from '$lib/schemas/blog'
import { createPost, getAdminPostFormData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminPostFormData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const currentAuth = await auth()
    if (!currentAuth.authenticated || !currentAuth.user) redirect(303, '/login')

    const data = await validate(await request.formData(), postForm)
    await createPost({
      ...data,
      authorId: currentAuth.user.id,
    })

    redirect(303, '/admin/posts')
  },
} satisfies Actions
```

:::

Now that every post has a real author, make `authorId` required in `blog.ts` and delete the temporary `ensureAuthorId()` helper from chapter 6:

```ts
export async function createPost(input: PostInput & { authorId: number }) {
  return await DB.transaction(async () => {
    const postStatus = input.status === 'draft' ? 'draft' : 'published'

    const post = await Post.create({
      user_id: input.authorId,
      // ...the rest stays the same
    })

    // ...
  })
}
```

You can also remove the `User` import from `blog.ts` if nothing else uses it.

In Next.js, also guard the whole admin section with a layout. Pages inside it only render for signed-in users:

```tsx [app/admin/layout.tsx]
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }

  return children
}
```

## Step 8: Check it works

1. Sign out if you're signed in, then open `/admin`. You're sent to `/login`.
2. Sign in with a wrong password. You see an error and stay on the page.
3. Sign in as `editor@example.com` / `secret-secret`. You land on `/admin`, and the header shows "Holo Editor" with a Logout button.
4. Open `/login` while signed in. You're sent back to `/admin`.
5. Create a post. It saves with the editor as its author.
6. Sign out, open `/register`, and create a new account. Try a short password and a mismatched confirmation first to see the errors.

::: tip Require verified email addresses
The finished app sets `emailVerification.required: true` in `config/auth.ts`. With that on, unverified users are sent to `/verify-email` by the `emailVerificationRequired` check in the actions above. You'll see where the verification email comes from in [chapter 10](/tutorial/realtime-and-notifications). See [Email verification](/auth/email-verification) for the verify page.
:::

## Next steps

Next, decide who may do what in [Authorization](/tutorial/authorization).

To learn more:

- [Authentication overview](/auth/)
- [Local auth](/auth/local-auth)
- [The current user](/auth/current-user)
- [Sessions and cookies](/auth/session-and-cookies)
- [Password reset](/auth/password-reset)
- [Rate limiting](/basics/security/rate-limiting)
