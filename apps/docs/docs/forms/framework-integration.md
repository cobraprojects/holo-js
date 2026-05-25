# Framework Integration

Shared packages stay framework-neutral. Use the same `validate(...)` function from `@holo-js/forms`
everywhere, or pass schemas directly to framework-native tools that accept Standard Schema.

## The rule

- `@holo-js/validation` owns parsing, errors, and Standard Schema conformance.
- `@holo-js/forms` owns the submission contract and client form state.
- Adapters provide framework-reactive `useForm(...)` wrappers.
- Schemas work natively with any tool that accepts Standard Schema V1.

## Server route examples

::: code-group

```ts [Next.js — app/api/login/route.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export async function POST(request: Request) {
  const submission = await validate(request, loginForm, {
    // Optional: requires @holo-js/security.
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), { status: submission.fail().status })
  }

  return Response.json(submission.success({ message: 'Logged in.' }))
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
  const submission = await validate(event, loginForm, {
    // Optional: requires @holo-js/security.
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    return submission.fail()
  }

  return submission.success({ message: 'Logged in.' })
})
```

```ts [SvelteKit actions — src/routes/login/+page.server.ts]
import { fail } from '@sveltejs/kit'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, loginForm, {
      // Optional: requires @holo-js/security.
      csrf: true,
      throttle: 'login',
    })

    if (!submission.valid) {
      const failure = submission.fail()
      return fail(failure.status, failure)
    }

    return submission.success({ message: 'Logged in.' })
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

`csrf` and `throttle` in these examples are optional security features. Use them only when
`@holo-js/security` is installed and configured. Without that package, call `validate(...)` without those
options.

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
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { loginForm } from '@/lib/schemas/login'

export async function loginAction(formData: FormData) {
  const submission = await validate(formData, loginForm, {
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    return submission.fail()
  }

  const { data: session, error } = await login(submission.data)
  if (error) {
    return submission.fail({ status: error.status, errors: error.fields })
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
    csrf: true,
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
  csrf: true,
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })
    if (submission?.ok === true) {
      await refreshUser()
    }

    return submission
  },
})
```

```ts [SvelteKit — src/routes/login/+page.server.ts]
import { fail, redirect } from '@sveltejs/kit'
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '$lib/schemas/login'

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, loginForm, {
      csrf: true,
      throttle: 'login',
    })

    if (!submission.valid) {
      const failure = submission.fail()
      return fail(failure.status, failure)
    }

    const { data: session, error } = await login(submission.data)
    if (error) {
      const failure = submission.fail({ status: error.status, errors: error.fields })
      return fail(failure.status, failure)
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
  <input type="hidden" name={data.csrf.name} value={data.csrf.value} />
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
| Form actions | `+page.server.ts` with `validate(...)` | SvelteKit `form` prop from `fail(...)` |
| Remote functions | `.remote.ts` with `form()` / `query()` / `command()` | `login.issues` / `login.input` (SvelteKit native) |
| `useForm(...)` | Any API route with `validate(...)` | `form.errors.has()` / `form.errors.first()` (Holo) |

Pick the one that fits your app. They are not mutually exclusive.

`useForm(...)` may opt into `csrf: true`, but it does not expose `throttle`. The browser only forwards the CSRF
token so the server can verify it. Throttling is always enforced on the server.

For native SvelteKit form actions, render the CSRF field from server data as a hidden input and validate
the action with `validate(request, schema, { csrf: true })`. The SvelteKit auth/framework hook creates the
CSRF cookie before guest pages render, so app pages should not set the CSRF cookie manually.

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
