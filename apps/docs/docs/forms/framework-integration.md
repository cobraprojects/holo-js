# Framework Integration

Shared packages stay framework-neutral. Use the same `validate(...)` function from `@holo-js/forms`
everywhere, or pass schemas directly to framework-native tools that accept Standard Schema.

## The rule

- `@holo-js/validation` owns parsing, errors, and Standard Schema conformance.
- `@holo-js/forms` owns form parsing, non-throwing `safeParse(...)` submissions, validation exceptions,
  and client form state.
- Adapters provide framework-reactive `useForm(...)` wrappers.
- Adapters serialize `ValidationException` into the host framework response shape.
- Schemas work natively with any tool that accepts Standard Schema V1.

`validate(...)` returns typed data when valid and throws `ValidationException` when invalid. Use
`safeParse(...)` only when you explicitly want to inspect `submission.valid` yourself.

## Server route examples

::: code-group

```ts [Next.js — app/api/login/route.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export async function POST(request: Request) {
  const data = await validate(request, loginForm, {
    throttle: 'login',
  })

  return Response.json({ ok: true, email: data.email })
}
```

```ts [Nuxt — server/api/login.post.ts]
import { defineEventHandler } from 'h3'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export default defineEventHandler(async (event) => {
  const data = await validate(event, loginForm, {
    throttle: 'login',
  })

  return { ok: true, email: data.email }
})
```

```ts [SvelteKit actions — src/routes/login/+page.server.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, loginForm, {
      throttle: 'login',
    })

    return { ok: true, email: data.email }
  },
}
```

```ts [SvelteKit remote — src/routes/login/login.remote.ts]
import { form } from '$app/server'
import { field, schema } from '@holo-js/validation'
import { User } from '$lib/server/models'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export const login = form(loginForm, async (data, invalid) => {
  const user = await User.where('email', data.email).first()
  if (!user) invalid({ email: 'No account found.' })
  return { user }
})
```

:::

`throttle` is optional and requires `@holo-js/security`. CSRF is not a `validate(...)` option; the
framework middleware verifies unsafe requests before these handlers run.

Use the framework-native request input with `validate(...)`: `request` in Next.js and SvelteKit, `event` in
Nuxt `server/api/*`. `useRequestHeaders()` is a Nuxt app-context composable for pages, components, and plugins,
not h3 route handlers.

## Submit examples

For auth flows that redirect after login, register, or logout, use the framework's server-side navigation primitive.
Use `refreshUser()` only for client-side mutations that stay on the current route.

::: code-group

```ts [Next.js — app/login/actions.ts]
'use server'

import { login } from '@holo-js/auth'
import { validate, ValidationException } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { loginForm } from '@/lib/schemas/login'

export async function loginAction(formData: FormData) {
  const data = await validate(formData, loginForm, {
    throttle: 'login',
  })

  const { data: session, error } = await login(data)
  if (error) {
    throw ValidationException.withMessages(error.fields)
  }

  revalidatePath('/', 'layout')
  redirect(session.emailVerificationRequired ? session.emailVerificationRoute ?? '/verify-email' : '/admin')
}
```

```tsx [Next.js — app/login/page.tsx]
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { loginForm } from '@/lib/schemas/login'
import { loginAction } from './actions'

export default function LoginPage() {
  const form = useForm(loginForm, {
    async submitter({ formData }) {
      return await loginAction(formData)
    },
  })

  return <form onSubmit={(event) => { event.preventDefault(); form.submit() }} />
}
```

```ts [Nuxt — app/pages/login.vue]
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '~/lib/schemas/login'

const { refreshUser } = await useAuth()
const form = useForm(loginForm, {
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })
    if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
      await refreshUser()
      await navigateTo(submission.data.redirectTo, {
        external: true,
      })
    }

    return submission
  },
})
```

```ts [SvelteKit — src/routes/login/+page.server.ts]
import { redirect } from '@sveltejs/kit'
import { login } from '@holo-js/auth'
import { validate, ValidationException } from '@holo-js/forms'
import { loginForm } from '$lib/schemas/login'

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, loginForm, {
      throttle: 'login',
    })

    const { data: session, error } = await login(data)
    if (error) {
      throw ValidationException.withMessages(error.fields)
    }

    redirect(303, session.emailVerificationRequired ? session.emailVerificationRoute ?? '/verify-email' : '/admin')
  },
}
```

```svelte [SvelteKit — src/routes/login/+page.svelte]
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/login'
  import type { PageData } from './$types'

  export let data: PageData

  const login = useForm(loginForm, {
    initialValues: { email: '', password: '', remember: false },
  })
</script>

<form method="post">
  <input {...data.csrf.input}>
  <input name="email" type="email" value={login.values.email} on:input={(event) => login.fields.email.onInput(event.currentTarget.value)} />
  {#if login.errors.has('email')}<p>{login.errors.first('email')}</p>{/if}
  <input name="password" type="password" value={login.values.password} on:input={(event) => login.fields.password.onInput(event.currentTarget.value)} />
  {#if login.errors.has('password')}<p>{login.errors.first('password')}</p>{/if}
  <button type="submit" disabled={login.submitting}>Sign in</button>
</form>
```

:::

## SvelteKit: three paths

SvelteKit users have three options for server validation. All three accept Holo schemas:

| Path | Server entry | Client error handling |
|---|---|---|
| Form actions | `+page.server.ts` with `validate(...)` | `useValidationErrors()` or `useForm(...)` |
| Remote functions | `.remote.ts` with `form()` / `query()` / `command()` | `login.issues` / `login.input` (SvelteKit native) |
| `useForm(...)` | Any API route with `validate(...)` | `form.errors.has()` / `form.errors.first()` (Holo) |

Pick the one that fits your app. They are not mutually exclusive.

When `@holo-js/security` is installed, `useForm(...)` automatically forwards the CSRF token for unsafe
submissions. It does not expose `throttle`; throttling is always enforced on the server.

For native SvelteKit form actions, render the CSRF field from server data as a hidden input:

```svelte
<input {...data.csrf.input}>
```

The security middleware creates the CSRF cookie before pages render, so app pages should not set the
CSRF cookie manually.

If a Nuxt or SvelteKit page is using native server forms instead of `useForm(...)`, read the current
validation bag where you want to render the messages:

::: code-group

```vue [Nuxt]
<script setup lang="ts">
import { useValidationErrors } from '@holo-js/adapter-nuxt/client'

const errors = useValidationErrors()
</script>

<template>
  <p v-if="errors.has('image')">{{ errors.first('image') }}</p>
</template>
```

```svelte [SvelteKit]
<script lang="ts">
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'

  const errors = useValidationErrors()
</script>

{#if errors.has('image')}
  <p>{errors.first('image')}</p>
{/if}
```

:::

## SvelteKit config

SvelteKit apps should wrap their config with `withHoloSvelteKit(...)`. The wrapper installs the generated
Holo hook bridge and the Svelte compiler integration needed for reactive `useForm(...)` state.

```js [svelte.config.js]
import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import { withHoloSvelteKit } from '@holo-js/adapter-sveltekit/config'

/** @type {import('@sveltejs/kit').Config} */
const config = withHoloSvelteKit({
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
})

export default config
```

`holo prepare` writes this wrapper during scaffold and preserves unrelated user config. Do not wire
`.holo-js/generated/hooks.server` or `.holo-js/generated/hooks` manually; the wrapper owns those paths.

## Standard Schema interop

Because every Holo schema implements Standard Schema V1, they also work with:

- tRPC input validators
- TanStack Form
- Hono middleware
- Any tool listed on [standardschema.dev](https://standardschema.dev)

```ts
// Example: tRPC router
import { schema, field } from '@holo-js/validation'

const createPostSchema = schema({
  title: field.string().required().min(3),
  content: field.string().required(),
})

export const appRouter = router({
  createPost: publicProcedure
    .input(createPostSchema)  // works because it's Standard Schema
    .mutation(({ input }) => {
      return db.posts.create(input)
    }),
})
```

## Continue

- [Validation Overview](/validation/)
- [Forms Overview](/forms/)
- [Server Validation](/forms/server-validation)
