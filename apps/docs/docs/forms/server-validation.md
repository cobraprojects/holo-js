# Server Validation

The primary Holo forms workflow is server-first.

Validate the request on the backend, return typed errors and values when invalid, and only treat client
validation as optional enhancement.

## Full server validation example

The browser submits a form, the server validates it, and the response returns either `submission.fail()`
or `submission.success(...)`.

Use `field.password()` for password values and `.sensitive()` for any other submitted value that must
never be flashed back to the client. `submission.fail()` and `submission.serialize()` remove those
fields automatically.

::: code-group

```ts [Next.js — app/api/login/route.ts]
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export async function POST(request: Request) {
  const submission = await validate(request, loginForm, {
    // Optional: requires @holo-js/security.
    csrf: true,
    throttle: 'login',
  })

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
import { defineEventHandler } from 'h3'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
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

  return submission.success({
    message: 'Logged in.',
  })
})
```

```ts [SvelteKit — src/routes/login/+page.server.ts]
import { fail } from '@sveltejs/kit'
import { field, schema, validate } from '@holo-js/forms'

const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
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

    return submission.success({
      message: 'Logged in.',
    })
  },
}
```

:::

`csrf` and `throttle` in these examples are optional security features. Use them only when
`@holo-js/security` is installed and configured. Without that package, call `validate(...)` without those
options.

When you add `csrf` or `throttle`, pass a real web `Request` or request-like event into `validate(...)`. In
Nuxt `server/api/*`, you can pass the h3 event directly instead of validating only the parsed body.

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

If you prefer the Holo client form helper over SvelteKit's native form binding, it works the same way as
in other frameworks:

```svelte
<!-- src/routes/register/+page.svelte -->
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { registerUser } from '$lib/schemas/register'

  const form = useForm(registerUser, {
    validateOn: 'blur',
    csrf: true,
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/register', { method: 'POST', body: formData })
      return await response.json()
    },
  })
</script>

<form onsubmit={(e) => { e.preventDefault(); form.submit() }}>
  <input
    name="name"
    value={form.values.name}
    oninput={(event) => form.fields.name.onInput(event.currentTarget.value)}
    onblur={() => form.fields.name.onBlur()}
  />
  {#if form.errors.has('name')}
    <p>{form.errors.first('name')}</p>
  {/if}

  <input
    name="email"
    value={form.values.email}
    oninput={(event) => form.fields.email.onInput(event.currentTarget.value)}
    onblur={() => form.fields.email.onBlur()}
  />
  {#if form.errors.has('email')}
    <p>{form.errors.first('email')}</p>
  {/if}

  <button disabled={form.submitting}>
    {form.submitting ? 'Creating account...' : 'Create account'}
  </button>
</form>
```

## Full page flow

These examples show the real failure and redirect path. Next.js keeps the auth redirect in a server action.
Nuxt and SvelteKit use the client submitter pattern shown by the blog apps: submit to an API route,
refresh the current user, then navigate.

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
  csrf: true,
  initialValues: { email: '', password: '', remember: false },
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })
    if (submission?.ok === true) {
      await refreshUser()
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
    initialValues: { email: '', password: '', remember: false },
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
  {#if form.errors.has('email')}
    <p>{form.errors.first('email')}</p>
  {/if}

  <input name="password" type="password" value={form.values.password} on:input={(event) => form.fields.password.onInput(event.currentTarget.value)} />
  {#if form.errors.has('password')}
    <p>{form.errors.first('password')}</p>
  {/if}

  <label>
    <input name="remember" type="checkbox" checked={form.values.remember} on:change={(event) => form.fields.remember.onInput(event.currentTarget.checked)} />
    Remember me
  </label>

  <button type="submit" disabled={form.submitting}>Sign in</button>
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
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

export async function POST(request: Request) {
  const submission = await validate(request, registerUser, {
    // Optional: requires @holo-js/security.
    csrf: true,
    throttle: 'register',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), { status: submission.fail().status })
  }

  await auth.register(submission.data)

  return Response.json(submission.success({ message: 'Account created.' }))
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
  const submission = await validate(event, registerUser, {
    // Optional: requires @holo-js/security.
    csrf: true,
    throttle: 'register',
  })

  if (!submission.valid) {
    return submission.fail()
  }

  await auth.register(submission.data)

  return submission.success({ message: 'Account created.' })
})
```

```ts [SvelteKit — src/routes/api/register/+server.ts]
import { json } from '@sveltejs/kit'
import { field, schema, validate } from '@holo-js/forms'

const registerUser = schema({
  name: field.string().required().min(3).max(255),
  email: field.string().required().email(),
  password: field.password().required().min(8).confirmed(),
  passwordConfirmation: field.password().required(),
})

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, registerUser, {
    csrf: true,
    throttle: 'register',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    return json(failure, { status: failure.status })
  }

  await auth.register(submission.data)

  return json(submission.success({ message: 'Account created.' }))
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
import { fail } from '@sveltejs/kit'
import { field, schema, validate } from '@holo-js/forms'

const uploadAvatar = schema({
  avatar: field.file().required().image().maxSize('2mb'),
})

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, uploadAvatar)

    if (!submission.valid) {
      const failure = submission.fail()
      return fail(failure.status, failure)
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
