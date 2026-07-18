# Server Validation

The primary Holo forms workflow is server-first.

Validate the request on the backend, return typed errors and values when invalid, and only treat client
validation as optional enhancement.

## Full server validation example

The browser submits a form and the server validates it. `validate(...)` returns typed data when valid.
When invalid, it throws `ValidationException`; framework adapters serialize that exception into a 422
error-bag payload for the current framework.

Use `field.password()` for password values and `.sensitive()` for any other submitted value that must
never be flashed back to the client. Validation exception serialization removes those fields
automatically.

::: code-group

```ts [Next.js — app/api/login/route.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export async function POST(request: Request) {
  const data = await validate(request, loginForm, {
    throttle: 'login',
  })

  return Response.json({
    ok: true,
    email: data.email,
    message: 'Logged in.',
  })
}
```

```ts [Nuxt — server/api/login.post.ts]
import { defineEventHandler } from 'h3'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const data = await validate(event, loginForm, {
    throttle: 'login',
  })

  return {
    ok: true,
    email: data.email,
    message: 'Logged in.',
  }
})
```

```ts [SvelteKit — src/routes/login/+page.server.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, loginForm, {
      throttle: 'login',
    })

    return {
      ok: true,
      email: data.email,
      message: 'Logged in.',
    }
  },
}
```

:::

`throttle` is optional and requires `@holo-js/security`. CSRF is not a `validate(...)` option; the
framework middleware verifies unsafe requests before these handlers run.

When you add `throttle`, pass a real web `Request` or request-like event into `validate(...)`. In Nuxt
`server/api/*`, you can pass the h3 event directly instead of validating only the parsed body.

## SvelteKit remote functions

Holo schemas implement Standard Schema V1, so they work directly with SvelteKit's `form()`, `query()`,
and `command()` remote functions. No wrappers needed.

### Remote `form()`

```ts
// src/routes/login/login.remote.ts
import { form } from '$app/server'
import { field, schema } from '@holo-js/validation'
import { User } from '$lib/server/models'

const loginSchema = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export const login = form(loginSchema, async (data, invalid) => {
  const user = await User.where('email', data.email).first()

  if (!user) {
    invalid({ email: 'No account with this email.' })
  }

  return { user }
})
```

```svelte
<!-- src/routes/login/+page.svelte -->
<script>
  import { login } from './login.remote'
</script>

<form {...login}>
  <input name="email" value={login.input?.email ?? ''} />
  {#if login.issues?.email}
    <p>{login.issues.email[0].message}</p>
  {/if}

  <input name="password" type="password" />
  {#if login.issues?.password}
    <p>{login.issues.password[0].message}</p>
  {/if}

  <button>Sign in</button>
</form>
```

### Remote `query()` with a single field

Field builders are also Standard Schema, so they work as the argument validator for `query()` and
`command()`:

```ts
// src/routes/posts/posts.remote.ts
import { query } from '$app/server'
import { field } from '@holo-js/validation'
import { Post } from '$lib/server/models'

export const getPost = query(field.string().required(), async (slug) => {
  const post = await Post.where('slug', slug).firstOrFail()
  return post
})
```

### Remote `command()` with an object schema

```ts
// src/routes/posts/posts.remote.ts
import { command } from '$app/server'
import { field, schema } from '@holo-js/validation'
import { Post } from '$lib/server/models'

const createPostSchema = schema({
  title: field.string().required().min(3),
  content: field.string().required(),
})

export const createPost = command(createPostSchema, async (data) => {
  return await Post.create(data)
})
```

### Using `useForm(...)` in SvelteKit

When a SvelteKit page action throws a validation exception, the SvelteKit adapter serializes it and
applies the returned values and errors to `useForm(...)`:

```svelte
<!-- src/routes/register/+page.svelte -->
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { registerUser } from '$lib/schemas/register'
  import type { PageData } from './$types'

  export let data: PageData

  const register = useForm(registerUser, {
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
  })
</script>

<form method="post">
  <input {...data.csrf.input}>
  <input
    name="name"
    value={register.values.name}
    oninput={(event) => register.fields.name.onInput(event.currentTarget.value)}
    onblur={() => register.fields.name.onBlur()}
  />
  {#if register.errors.has('name')}
    <p>{register.errors.first('name')}</p>
  {/if}

  <input
    name="email"
    value={register.values.email}
    oninput={(event) => register.fields.email.onInput(event.currentTarget.value)}
    onblur={() => register.fields.email.onBlur()}
  />
  {#if register.errors.has('email')}
    <p>{register.errors.first('email')}</p>
  {/if}

  <button disabled={register.submitting}>
    {register.submitting ? 'Creating account...' : 'Create account'}
  </button>
</form>
```

## Full-page flow

These examples show the recommended auth form flow. Next.js keeps the redirect in a server action,
SvelteKit keeps the redirect in a page action, and Nuxt submits to an API route before refreshing the
current user and navigating to the returned redirect target.

::: code-group

```ts [Next.js — app/login/actions.ts]
'use server'

import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { loginForm } from '@/lib/schemas/login'

export async function loginAction(formData: FormData) {
  const data = await validate(formData, loginForm, {
    throttle: 'login',
  })

  const session = await login(data)

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
    initialValues: { email: '', password: '', remember: false },
    async submitter({ formData }) {
      return await loginAction(formData)
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); form.submit() }}>
      <input
        name="email"
        type="email"
        value={form.values.email}
        onInput={(event) => form.fields.email.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.email.onBlur()}
      />
      {form.errors.has('email') ? <p>{form.errors.first('email')}</p> : null}

      <input
        name="password"
        type="password"
        value={form.values.password}
        onInput={(event) => form.fields.password.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.password.onBlur()}
      />
      {form.errors.has('password') ? <p>{form.errors.first('password')}</p> : null}

      <label>
        <input
          name="remember"
          type="checkbox"
          checked={form.values.remember}
          onChange={(event) => form.fields.remember.onInput(event.currentTarget.checked)}
        />
        Remember me
      </label>

      <button type="submit" disabled={form.submitting}>
        {form.submitting ? 'Signing in...' : 'Sign in'}
      </button>

    </form>
  )
}
```

```vue [Nuxt — app/pages/login.vue]
<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '~/lib/schemas/login'

const { refreshUser } = await useAuth()
const form = useForm(loginForm, {
  initialValues: { email: '', password: '', remember: false },
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
</script>

<template>
  <form @submit.prevent="form.submit()">
    <input name="email" type="email" v-model="form.values.email" @blur="form.fields.email.onBlur()" />
    <p v-if="form.errors.has('email')">{{ form.errors.first('email') }}</p>

    <input name="password" type="password" v-model="form.values.password" @blur="form.fields.password.onBlur()" />
    <p v-if="form.errors.has('password')">{{ form.errors.first('password') }}</p>

    <label>
      <input name="remember" type="checkbox" v-model="form.values.remember" />
      Remember me
    </label>

    <button :disabled="form.submitting">
      {{ form.submitting ? 'Signing in...' : 'Sign in' }}
    </button>

    <p v-if="form.lastSubmission?.ok === true">{{ form.lastSubmission.data.message }}</p>
  </form>
</template>
```

Bind displayed values from `form.values.*` across frameworks and keep `form.fields.*` for field lifecycle helpers.
`form.fields.email.onBlur()` is the blur-validation hook when `validateOn: 'blur'` is enabled, while touched
state can also be set during input and value updates through helpers like `form.fields.email.onInput(...)`
and `form.setValue(...)`.

```ts [SvelteKit — src/routes/login/+page.server.ts]
import { redirect } from '@sveltejs/kit'
import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginForm } from '$lib/schemas/login'

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, loginForm, {
      throttle: 'login',
    })

    const session = await login(data)

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
  {#if login.errors.has('email')}
    <p>{login.errors.first('email')}</p>
  {/if}

  <input name="password" type="password" value={login.values.password} on:input={(event) => login.fields.password.onInput(event.currentTarget.value)} />
  {#if login.errors.has('password')}
    <p>{login.errors.first('password')}</p>
  {/if}

  <label>
    <input name="remember" type="checkbox" checked={login.values.remember} on:change={(event) => login.fields.remember.onInput(event.currentTarget.checked)} />
    Remember me
  </label>

  <button type="submit" disabled={login.submitting}>Sign in</button>
</form>
```

:::

## Failure response shape

When validation fails, adapters serialize `ValidationException` into this shape:

```ts
{
  ok: false,
  status: 422,
  valid: false,
  message: 'email: Enter a valid email address.',
  bag: 'default',
  values: {
    email: 'bad@example',
    remember: true,
  },
  errors: {
    email: ['Enter a valid email address.'],
  },
}
```

Password fields and fields marked with `.sensitive()` are omitted from `values`.

## Success response shape

On success:

```ts
{
  ok: true,
  status: 200,
  data: {
    message: 'Logged in.',
  },
}
```

## Non-throwing submissions

Use `safeParse(...)` when you want a submission object instead of an exception:

```ts
import { safeParse } from '@holo-js/forms'

const submission = await safeParse(request, loginForm)

if (!submission.valid) {
  submission.errors.first('email')
  submission.values.email
  return Response.json(submission.fail(), { status: submission.fail().status })
}

submission.data.email
```

## Registration example

::: code-group

```ts [Next.js — app/api/register/route.ts]
import { field, schema, validate } from '@holo-js/forms'

export const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

export async function POST(request: Request) {
  const data = await validate(request, registerUser, {
    throttle: 'register',
  })

  await auth.register(data)

  return Response.json({ ok: true, message: 'Account created.' })
}
```

```ts [Nuxt — server/api/register.post.ts]
import { defineEventHandler } from 'h3'
import { field, schema, validate } from '@holo-js/forms'

const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

export default defineEventHandler(async (event) => {
  const data = await validate(event, registerUser, {
    throttle: 'register',
  })

  await auth.register(data)

  return { ok: true, message: 'Account created.' }
})
```

```ts [SvelteKit — src/routes/register/+page.server.ts]
import { redirect } from '@sveltejs/kit'
import { field, schema, validate } from '@holo-js/forms'

const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, registerUser, {
      throttle: 'register',
    })

    await auth.register(data)

    redirect(303, '/admin')
  },
}
```

```ts [SvelteKit remote — src/routes/register/register.remote.ts]
import { form } from '$app/server'
import { field, schema } from '@holo-js/validation'
import { User } from '$lib/server/models'

const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.password().required().min(8),
})

export const register = form(registerUser, async (data, invalid) => {
  if (await User.where('email', data.email).first()) {
    invalid({ email: 'Email is already taken.' })
  }

  return await User.create(data)
})
```

:::

## File upload example

::: code-group

```ts [Next.js — app/api/avatar/route.ts]
import { field, schema, validate } from '@holo-js/forms'

const uploadAvatar = schema({
  avatar: field.file().required().image().maxSize('2mb'),
})

export async function POST(request: Request) {
  const data = await validate(request, uploadAvatar)
  const user = await currentUser()

  await user.addMedia(data.avatar).toMediaCollection('avatars')

  return Response.json({ ok: true, message: 'Avatar uploaded.' })
}
```

```ts [Nuxt — server/api/avatar.post.ts]
import { field, schema, validate } from '@holo-js/forms'

const uploadAvatar = schema({
  avatar: field.file().required().image().maxSize('2mb'),
})

export default defineEventHandler(async (event) => {
  const formData = await readFormData(event)
  const data = await validate(formData, uploadAvatar)
  const user = await currentUser()

  await user.addMedia(data.avatar).toMediaCollection('avatars')

  return { ok: true, message: 'Avatar uploaded.' }
})
```

```ts [SvelteKit — src/routes/avatar/+page.server.ts]
import { field, schema, validate } from '@holo-js/forms'

const uploadAvatar = schema({
  avatar: field.file().required().image().maxSize('2mb'),
})

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, uploadAvatar)
    const user = await currentUser()

    await user.addMedia(data.avatar).toMediaCollection('avatars')

    return { ok: true, message: 'Avatar uploaded.' }
  },
}
```

:::

## Next steps

- [Client Usage](/forms/client-usage)
- [Framework Integration](/forms/framework-integration)
