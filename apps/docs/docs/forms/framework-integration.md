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

```ts [SvelteKit — src/routes/api/login/+server.ts]
import { json } from '@sveltejs/kit'
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '$lib/schemas/login'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, loginForm, {
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    return json(failure, { status: failure.status })
  }

  const { data: session, error } = await login(submission.data)
  if (error) {
    const failure = submission.fail({ status: error.status, errors: error.fields })
    return json(failure, { status: failure.status })
  }

  return json(submission.success({
    redirectTo: session.emailVerificationRequired ? session.emailVerificationRoute ?? '/verify-email' : '/admin',
  }))
}
```

```svelte [SvelteKit — src/routes/login/+page.svelte]
<script lang="ts">
  import { goto } from '$app/navigation'
  import { useAuth } from '@holo-js/auth/sveltekit/client'
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/login'

  const auth = useAuth()
  const form = useForm(loginForm, {
    csrf: true,
    async submitter({ formData }) {
      const submission = await (await fetch('/api/login', { method: 'POST', body: formData })).json()
      if (submission.ok === true && typeof submission.data?.redirectTo === 'string') {
        await auth.refreshUser()
        await goto(submission.data.redirectTo, { invalidateAll: true })
      }

      return submission
    },
  })
</script>

<form on:submit={(event) => { event.preventDefault(); void form.submit() }}>
  <input name="email" type="email" value={form.values.email} on:input={(event) => form.fields.email.onInput(event.currentTarget.value)} />
  {#if form.errors.has('email')}<p>{form.errors.first('email')}</p>{/if}
  <input name="password" type="password" value={form.values.password} on:input={(event) => form.fields.password.onInput(event.currentTarget.value)} />
  {#if form.errors.has('password')}<p>{form.errors.first('password')}</p>{/if}
  <button type="submit" disabled={form.submitting}>Sign in</button>
</form>
```

:::

## SvelteKit: three paths

SvelteKit users have three options for server validation. All three accept Holo schemas:

| Path | Server entry | Client error handling |
|---|---|---|
| Form actions | `+page.server.ts` with `validate(...)` | `form` prop from action response |
| Remote functions | `.remote.ts` with `form()` / `query()` / `command()` | `login.issues` / `login.input` (SvelteKit native) |
| `useForm(...)` | Any API route with `validate(...)` | `form.errors.has()` / `form.errors.first()` (Holo) |

Pick the one that fits your app. They are not mutually exclusive.

`useForm(...)` may opt into `csrf: true`, but it does not expose `throttle`. The browser only forwards the CSRF
token so the server can verify it. Throttling is always enforced on the server.

For the `useForm(...)` path, the CSRF cookie is created by the SvelteKit auth/framework hook before guest
pages render. App pages should not call `csrf.field(...)` or set the CSRF cookie manually.

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
