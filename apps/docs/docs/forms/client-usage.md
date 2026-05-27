# Client Usage

Client validation is optional enhancement, not the source of truth.

`useForm(...)` manages one full round trip:

1. Define one shared schema.
2. Use that schema in the client form.
3. Submit to the server.
4. Let the returned payload update client state automatically.

The server validates with `validate(...)`. When validation fails, the framework adapter serializes the
validation exception into the same error-bag payload that `useForm(...)` understands. When validation
passes, return a normal success payload from the action or route.

## Shared schema

Put the schema in a shared module and import it on both server and client:

```ts
// lib/schemas/register.ts
import { field, schema } from '@holo-js/forms'

export const registerUser = schema({
  name: field.string().required('Name is required.').min(3, 'Name must be at least 3 characters.'),
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  passwordConfirmation: field.password().required('Please confirm your password.'),
})
```

## Full framework examples

::: code-group

```tsx [Next.js — app/register/page.tsx]
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { registerUser } from '@/lib/schemas/register'

export default function RegisterPage() {
  const form = useForm(registerUser, {
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/register', { method: 'POST', body: formData })
      return await response.json()
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); form.submit() }}>
      <input
        name="name"
        value={form.values.name}
        onInput={(e) => form.fields.name.onInput(e.currentTarget.value)}
        onBlur={() => form.fields.name.onBlur()}
      />
      {form.errors.has('name') ? <p>{form.errors.first('name')}</p> : null}

      <input
        name="email"
        value={form.values.email}
        onInput={(e) => form.fields.email.onInput(e.currentTarget.value)}
        onBlur={() => form.fields.email.onBlur()}
      />
      {form.errors.has('email') ? <p>{form.errors.first('email')}</p> : null}

      <button disabled={form.submitting}>
        {form.submitting ? 'Creating account...' : 'Create account'}
      </button>

      {form.lastSubmission?.ok === true ? <p>Account created.</p> : null}
    </form>
  )
}
```

```vue [Nuxt — app/pages/register.vue]
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { registerUser } from '~/lib/schemas/register'

const form = useForm(registerUser, {
  validateOn: 'blur',
  initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
  async submitter({ formData }) {
    return await $fetch('/api/register', { method: 'POST', body: formData })
  },
})
</script>

<template>
  <form @submit.prevent="form.submit()">
    <input name="name" v-model="form.values.name" @blur="form.fields.name.onBlur()" />
    <p v-if="form.errors.has('name')">{{ form.errors.first('name') }}</p>

    <input name="email" v-model="form.values.email" @blur="form.fields.email.onBlur()" />
    <p v-if="form.errors.has('email')">{{ form.errors.first('email') }}</p>

    <button :disabled="form.submitting">
      {{ form.submitting ? 'Creating account...' : 'Create account' }}
    </button>

    <p v-if="form.lastSubmission?.ok === true">Account created.</p>
  </form>
</template>
```

```svelte [SvelteKit — src/routes/register/+page.svelte]
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

:::

With `validateOn: 'blur'`, calling `form.fields.name.onBlur()` validates that field path and updates that
field's errors. It does not surface every other untouched field error in the form.

## Nuxt submitter forms

Use this path when JavaScript owns the form submission. The page uses `@submit.prevent`, the submitter sends
the request, and validation messages come from `form.errors`.

```vue [Nuxt — app/pages/posts/new.vue]
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { postForm } from '~/lib/schemas/post'

const form = useForm(postForm, {
  validateOn: 'blur',
  initialValues: {
    title: '',
    body: '',
    status: 'draft',
  },
  async submitter({ formData }) {
    const submission = await $fetch('/api/posts', { method: 'POST', body: formData })
    if (submission?.ok === true) {
      await navigateTo('/posts')
    }

    return submission
  },
})
</script>

<template>
  <form @submit.prevent="form.submit()">
    <input name="title" v-model="form.values.title" @blur="form.fields.title.onBlur()" />
    <p v-if="form.errors.has('title')">{{ form.errors.first('title') }}</p>

    <textarea name="body" v-model="form.values.body" @blur="form.fields.body.onBlur()" />
    <p v-if="form.errors.has('body')">{{ form.errors.first('body') }}</p>

    <select name="status" v-model="form.values.status">
      <option value="draft">Draft</option>
      <option value="published">Published</option>
    </select>

    <button :disabled="form.submitting">
      {{ form.submitting ? 'Saving...' : 'Save post' }}
    </button>
  </form>
</template>
```

The server route validates with `validate(event, schema)` and returns a normal payload on success:

```ts [Nuxt — server/api/posts.post.ts]
import { validate } from '@holo-js/forms'
import { postForm } from '~/lib/schemas/post'

export default defineEventHandler(async (event) => {
  const data = await validate(event, postForm)

  await createPost(data)

  return {
    ok: true,
    status: 201,
  }
})
```

Do not also add a native `action` to this form. `useValidationErrors(...)` is not part of this path.

## Native form submits

Use this path when the browser owns the form submission. The form has a native `action` and `method`, the
server redirects back on validation failure, and the page reads flashed validation messages with
`useValidationErrors(...)`.

```vue [Nuxt — app/pages/posts/new.vue]
<script setup lang="ts">
import { useValidationErrors } from '@holo-js/adapter-nuxt/client'

const errors = useValidationErrors()
</script>

<template>
  <form action="/posts" method="post" enctype="multipart/form-data">
    <input name="title" />
    <p v-if="errors.has('title')">{{ errors.first('title') }}</p>

    <textarea name="body" />
    <p v-if="errors.has('body')">{{ errors.first('body') }}</p>

    <button>Save post</button>
  </form>
</template>
```

```ts [Nuxt — server/routes/posts.post.ts]
import { sendRedirect } from 'h3'
import { validate } from '@holo-js/forms'
import { postForm } from '~/lib/schemas/post'

export default defineEventHandler(async (event) => {
  const data = await validate(event, postForm)

  await createPost(data)

  return sendRedirect(event, '/posts', 303)
})
```

Pick one path per form. `useForm(...)` owns client-side state and submitter responses. Native submits use
redirects plus flashed errors.

## What happens on failure

If the server throws a validation exception or returns a compatible failure payload, `useForm(...)`
applies it automatically:

- `form.fields.email.errors` is updated
- `form.errors.first('email')` works
- submitted values stay in `form.values`
- `form.submitting` goes back to `false`

## Client-side APIs

When `@holo-js/security` is installed and its CSRF cookie exists, `useForm(...)` automatically attaches
the CSRF field for unsafe submissions. `throttle` is intentionally not a client option. Rate limiting is
enforced on the server. CSRF field and cookie names come from `config/security.ts`; framework middleware
passes those names to browser helpers automatically.

`useForm(...)` exposes:

```ts
form.values.email             // current value
form.fields.email.errors      // field-level errors
form.fields.email.touched     // has been interacted with
form.fields.email.dirty       // differs from initial value
form.values                   // all current values
form.errors.has('email')      // check for errors
form.errors.first('email')    // first error message
form.errors.flatten()         // all errors as flat object
form.submitting               // true while submit is in flight
form.valid                    // true when no errors
form.lastSubmission           // last server response
```

Use `form.values.email` as the field value source across frameworks.
`form.fields.email.onBlur()` is the blur-validation hook when `validateOn: 'blur'` is enabled, while touched state
can also be set during input and value updates through helpers like `form.fields.email.onInput(...)` and
`form.setValue(...)`.

Manual validation:

```ts
await form.validate()                // validate all fields
await form.validateField('email')    // validate one field
await form.setValue('name', 'Ava')   // set a value programmatically
form.reset()                         // reset to initial values
```

## When to use `useForm(...)`

Use `useForm(...)` when you want:

- field-level error rendering
- loading state with `form.submitting`
- server failure rehydration
- one shared schema on client and server

SvelteKit users can also use native form actions or remote functions instead. Holo schemas work in both
paths because they implement Standard Schema V1.

## Continue

- [Forms Overview](/forms/)
- [Framework Integration](/forms/framework-integration)
