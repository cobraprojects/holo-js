# Client Usage

Client validation is optional enhancement, not the source of truth.

`useForm(...)` manages one full round trip:

1. Define one shared schema.
2. Use that schema in the client form.
3. Submit to the server.
4. Let the returned payload update client state automatically.

The server validates with `validate(...)` and returns `submission.fail()` or `submission.success(...)`.
`useForm(...)` applies that response and rebuilds the typed error bag on the client.

## Shared schema

Put the schema in a shared module and import it on both server and client:

```ts
// lib/schemas/register.ts
import { field, schema } from '@holo-js/forms'

export const registerUser = schema({
  name: field.string().required('Name is required.').min(3, 'Name must be at least 3 characters.'),
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.string().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  passwordConfirmation: field.string().required('Please confirm your password.'),
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
    csrf: true,
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
        value={form.fields.name.value}
        onInput={(e) => form.fields.name.onInput(e.currentTarget.value)}
        onBlur={() => form.fields.name.onBlur()}
      />
      {form.errors.has('name') ? <p>{form.errors.first('name')}</p> : null}

      <input
        name="email"
        value={form.fields.email.value}
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

```vue [Nuxt — pages/register.vue]
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { registerUser } from '~/lib/schemas/register'

const form = useForm(registerUser, {
  validateOn: 'blur',
  csrf: true,
  initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
  async submitter({ formData }) {
    return await $fetch('/api/register', { method: 'POST', body: formData })
  },
})
</script>

<template>
  <form @submit.prevent="form.submit()">
    <input name="name" v-model="form.fields.name.value" @blur="form.fields.name.onBlur()" />
    <p v-if="form.errors.has('name')">{{ form.errors.first('name') }}</p>

    <input name="email" v-model="form.fields.email.value" @blur="form.fields.email.onBlur()" />
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

  {#if form.lastSubmission?.ok === true}
    <p>{form.lastSubmission.data.message}</p>
  {/if}
</form>
```

:::

## What happens on failure

If the server returns `submission.fail()`, `useForm(...)` applies that payload automatically:

- `form.fields.email.errors` is updated
- `form.errors.first('email')` works
- submitted values stay in `form.values`
- `form.submitting` goes back to `false`

## Client-side APIs

When `@holo-js/security` is installed, `useForm(..., { csrf: true })` also attaches the CSRF field for unsafe
submissions so the server can verify it through `validate(...)` or `protect(...)`. `throttle` is intentionally
not a client option. Rate limiting is enforced on the server.

If the browser should use custom CSRF field or cookie names instead of the defaults (`_token` and
`XSRF-TOKEN`), configure the browser helper once:

```ts
import { configureSecurityClient } from '@holo-js/security/client'

configureSecurityClient({
  config: {
    csrf: {
      field: '_csrf',
      cookie: 'csrf-token',
    },
  },
})
```

`useForm(...)` exposes:

```ts
form.fields.email.value       // current value
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
