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
  password: field.string().required().min(8),
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
  password: field.string().required().min(8),
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
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required().email(),
  password: field.string().required().min(8),
})

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, loginForm, {
      // Optional: requires @holo-js/security.
      csrf: true,
      throttle: 'login',
    })

    if (!submission.valid) {
      return submission.fail()
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
  password: field.string().required().min(8),
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

## Client submit examples

::: code-group

```ts [Next.js — app/login/page.tsx]
import { useForm } from '@holo-js/adapter-next/client'
import { loginForm } from '@/lib/schemas/login'

const form = useForm(loginForm, {
  csrf: true,
  async submitter({ formData }) {
    const response = await fetch('/api/login', { method: 'POST', body: formData })
    return await response.json()
  },
})
```

```ts [Nuxt — pages/login.vue]
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '~/lib/schemas/login'

const form = useForm(loginForm, {
  csrf: true,
  async submitter({ formData }) {
    return await $fetch('/api/login', { method: 'POST', body: formData })
  },
})
```

```ts [SvelteKit — src/routes/login/+page.svelte]
import { useForm } from '@holo-js/adapter-sveltekit/client'
import { loginForm } from '$lib/schemas/login'

const form = useForm(loginForm, {
  csrf: true,
  async submitter({ formData }) {
    const response = await fetch('/api/login', { method: 'POST', body: formData })
    return await response.json()
  },
})
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
