# Server Validation

The primary Holo forms workflow is server-first.

Validate the request on the backend, return typed errors and values when invalid, and only treat client
validation as optional enhancement.

## Full server validation example

The browser submits a form, the server validates it, and the response returns either `submission.fail()`
or `submission.success(...)`.

::: code-group

```ts [Next.js — app/api/login/route.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.string().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export async function POST(request: Request) {
  const submission = await validate(request, loginForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  return Response.json(submission.success({
    message: 'Logged in.',
  }))
}
```

```ts [Nuxt — server/api/login.post.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.string().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const submission = await validate(body, loginForm)

  if (!submission.valid) {
    return submission.fail()
  }

  return submission.success({
    message: 'Logged in.',
  })
})
```

```ts [SvelteKit — src/routes/login/+page.server.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.string().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, loginForm)

    if (!submission.valid) {
      return submission.fail()
    }

    return submission.success({
      message: 'Logged in.',
    })
  },
}
```

:::

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
  password: field.string().required().min(8),
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

If you prefer the Holo client form helper over SvelteKit's native form binding, it works the same way as
in other frameworks:

```svelte
<!-- src/routes/register/+page.svelte -->
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { registerUser } from '$lib/schemas/register'

  const form = useForm(registerUser, {
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/register', { method: 'POST', body: formData })
      return await response.json()
    },
  })
</script>

<form onsubmit={(e) => { e.preventDefault(); form.submit() }}>
  <input name="name" bind:value={form.fields.name.value} onblur={() => form.fields.name.onBlur()} />
  {#if form.errors.has('name')}
    <p>{form.errors.first('name')}</p>
  {/if}

  <input name="email" bind:value={form.fields.email.value} onblur={() => form.fields.email.onBlur()} />
  {#if form.errors.has('email')}
    <p>{form.errors.first('email')}</p>
  {/if}

  <button disabled={form.submitting}>
    {form.submitting ? 'Creating account...' : 'Create account'}
  </button>
</form>
```

## Full page flow

These examples show the real failure and success handling path using `useForm(...)`.

::: code-group

```tsx [Next.js — app/login/page.tsx]
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { loginForm } from '@/lib/schemas/login'

export default function LoginPage() {
  const form = useForm(loginForm, {
    initialValues: { email: '', password: '', remember: false },
    async submitter({ formData }) {
      const response = await fetch('/api/login', { method: 'POST', body: formData })
      return await response.json()
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); form.submit() }}>
      <input
        name="email"
        type="email"
        value={form.fields.email.value}
        onInput={(event) => form.fields.email.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.email.onBlur()}
      />
      {form.errors.has('email') ? <p>{form.errors.first('email')}</p> : null}

      <input
        name="password"
        type="password"
        value={form.fields.password.value}
        onInput={(event) => form.fields.password.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.password.onBlur()}
      />
      {form.errors.has('password') ? <p>{form.errors.first('password')}</p> : null}

      <label>
        <input
          name="remember"
          type="checkbox"
          checked={form.fields.remember.value}
          onChange={(event) => form.fields.remember.onInput(event.currentTarget.checked)}
        />
        Remember me
      </label>

      <button type="submit" disabled={form.submitting}>
        {form.submitting ? 'Signing in...' : 'Sign in'}
      </button>

      {form.lastSubmission?.ok === true ? <p>{form.lastSubmission.data.message}</p> : null}
    </form>
  )
}
```

```vue [Nuxt — pages/login.vue]
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '~/lib/schemas/login'

const form = useForm(loginForm, {
  initialValues: { email: '', password: '', remember: false },
  async submitter({ formData }) {
    return await $fetch('/api/login', { method: 'POST', body: formData })
  },
})
</script>

<template>
  <form @submit.prevent="form.submit()">
    <input name="email" type="email" v-model="form.fields.email.value" @blur="form.fields.email.onBlur()" />
    <p v-if="form.errors.has('email')">{{ form.errors.first('email') }}</p>

    <input name="password" type="password" v-model="form.fields.password.value" @blur="form.fields.password.onBlur()" />
    <p v-if="form.errors.has('password')">{{ form.errors.first('password') }}</p>

    <label>
      <input name="remember" type="checkbox" v-model="form.fields.remember.value" />
      Remember me
    </label>

    <button :disabled="form.submitting">
      {{ form.submitting ? 'Signing in...' : 'Sign in' }}
    </button>

    <p v-if="form.lastSubmission?.ok === true">{{ form.lastSubmission.data.message }}</p>
  </form>
</template>
```

```svelte [SvelteKit — src/routes/login/+page.svelte (form actions)]
<script lang="ts">
  let { form } = $props()
</script>

<form method="POST">
  <input name="email" type="email" value={form?.values?.email ?? ''} />
  {#if form?.errors?.email?.[0]}
    <p>{form.errors.email[0]}</p>
  {/if}

  <input name="password" type="password" />
  {#if form?.errors?.password?.[0]}
    <p>{form.errors.password[0]}</p>
  {/if}

  <label>
    <input name="remember" type="checkbox" value="true" checked={form?.values?.remember ?? false} />
    Remember me
  </label>

  <button type="submit">Sign in</button>

  {#if form?.ok === true}
    <p>{form.data.message}</p>
  {/if}
</form>
```

:::

## Failure response shape

When validation fails, `submission.fail()` returns:

```ts
{
  ok: false,
  status: 422,
  valid: false,
  values: {
    email: 'bad@example',
    remember: true,
  },
  errors: {
    email: ['Enter a valid email address.'],
  },
}
```

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

## Accessing typed values and errors

```ts
if (!submission.valid) {
  submission.errors.has('email')
  submission.errors.first('email')
  submission.values.email
}

if (submission.valid) {
  submission.data.email
  submission.data.remember
}
```

## Registration example

::: code-group

```ts [Next.js — app/api/register/route.ts]
import { field, schema, validate } from '@holo-js/forms'

export const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.string().required().min(8).confirmed(),
  passwordConfirmation: field.string().required(),
})

export async function POST(request: Request) {
  const submission = await validate(request, registerUser)

  if (!submission.valid) {
    return Response.json(submission.fail(), { status: submission.fail().status })
  }

  await auth.register(submission.data)

  return Response.json(submission.success({ message: 'Account created.' }))
}
```

```ts [Nuxt — server/api/register.post.ts]
import { field, schema, validate } from '@holo-js/forms'

const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.string().required().min(8).confirmed(),
  passwordConfirmation: field.string().required(),
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const submission = await validate(body, registerUser)

  if (!submission.valid) {
    return submission.fail()
  }

  await auth.register(submission.data)

  return submission.success({ message: 'Account created.' })
})
```

```ts [SvelteKit — src/routes/register/+page.server.ts]
import { field, schema, validate } from '@holo-js/forms'

const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.string().required().min(8).confirmed(),
  passwordConfirmation: field.string().required(),
})

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, registerUser)

    if (!submission.valid) {
      return submission.fail()
    }

    await auth.register(submission.data)

    return submission.success({ message: 'Account created.' })
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
  password: field.string().required().min(8),
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
  const submission = await validate(request, uploadAvatar)

  if (!submission.valid) {
    return Response.json(submission.fail(), { status: submission.fail().status })
  }

  await media.store(submission.data.avatar)

  return Response.json(submission.success({ message: 'Avatar uploaded.' }))
}
```

```ts [Nuxt — server/api/avatar.post.ts]
import { field, schema, validate } from '@holo-js/forms'

const uploadAvatar = schema({
  avatar: field.file().required().image().maxSize('2mb'),
})

export default defineEventHandler(async (event) => {
  const formData = await readFormData(event)
  const submission = await validate(formData, uploadAvatar)

  if (!submission.valid) {
    return submission.fail()
  }

  await media.store(submission.data.avatar)

  return submission.success({ message: 'Avatar uploaded.' })
})
```

```ts [SvelteKit — src/routes/avatar/+page.server.ts]
import { field, schema, validate } from '@holo-js/forms'

const uploadAvatar = schema({
  avatar: field.file().required().image().maxSize('2mb'),
})

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, uploadAvatar)

    if (!submission.valid) {
      return submission.fail()
    }

    await media.store(submission.data.avatar)

    return submission.success({ message: 'Avatar uploaded.' })
  },
}
```

:::

## Next steps

- [Client Usage](/forms/client-usage)
- [Framework Integration](/forms/framework-integration)
