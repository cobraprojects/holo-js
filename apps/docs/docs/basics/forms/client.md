# Client-Side Forms

`useForm()` gives a page reactive form state from a [validation](/basics/validation/) schema: current values, field errors, touched and dirty flags, and a `submitting` flag. It validates in the browser, submits the form, and applies the server's response, including 422 errors.

## Create a form

Import `useForm()` from your framework adapter and pass the shared schema:

::: code-group

```tsx [Next.js]
// app/register/page.tsx
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { registerForm } from '@/lib/schemas/register'

export default function RegisterPage() {
  const form = useForm(registerForm, {
    action: '/api/register',
    validateOn: 'blur',
    initialValues: { email: '', password: '', passwordConfirmation: '' },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <input
        name="email"
        type="email"
        value={form.values.email}
        onInput={event => form.fields.email.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.email.onBlur()}
      />
      {form.errors.has('email') ? <p>{form.errors.first('email')}</p> : null}

      <input
        name="password"
        type="password"
        value={form.values.password}
        onInput={event => form.fields.password.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.password.onBlur()}
      />
      {form.errors.has('password') ? <p>{form.errors.first('password')}</p> : null}

      <input
        name="passwordConfirmation"
        type="password"
        value={form.values.passwordConfirmation}
        onInput={event => form.fields.passwordConfirmation.onInput(event.currentTarget.value)}
      />

      <button disabled={form.submitting}>
        {form.submitting ? 'Creating account...' : 'Create account'}
      </button>
    </form>
  )
}
```

```vue [Nuxt]
<!-- app/pages/register.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { registerForm } from '#shared/schemas/register'

const form = useForm(registerForm, {
  action: '/api/register',
  validateOn: 'blur',
  initialValues: { email: '', password: '', passwordConfirmation: '' },
})
</script>

<template>
  <form @submit.prevent="form.submit()">
    <input name="email" type="email" v-model="form.values.email" @blur="form.fields.email.onBlur()">
    <p v-if="form.errors.has('email')">{{ form.errors.first('email') }}</p>

    <input name="password" type="password" v-model="form.values.password" @blur="form.fields.password.onBlur()">
    <p v-if="form.errors.has('password')">{{ form.errors.first('password') }}</p>

    <input name="passwordConfirmation" type="password" v-model="form.values.passwordConfirmation">

    <button :disabled="form.submitting">
      {{ form.submitting ? 'Creating account...' : 'Create account' }}
    </button>
  </form>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/register/+page.svelte -->
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { registerForm } from '$lib/schemas/register'

  const form = useForm(registerForm, {
    action: '/api/register',
    validateOn: 'blur',
    initialValues: { email: '', password: '', passwordConfirmation: '' },
  })
</script>

<form on:submit|preventDefault={() => form.submit()}>
  <input
    name="email"
    type="email"
    value={form.values.email}
    on:input={event => form.fields.email.onInput(event.currentTarget.value)}
    on:blur={() => form.fields.email.onBlur()}
  >
  {#if form.errors.has('email')}<p>{form.errors.first('email')}</p>{/if}

  <input
    name="password"
    type="password"
    value={form.values.password}
    on:input={event => form.fields.password.onInput(event.currentTarget.value)}
    on:blur={() => form.fields.password.onBlur()}
  >
  {#if form.errors.has('password')}<p>{form.errors.first('password')}</p>{/if}

  <input
    name="passwordConfirmation"
    type="password"
    value={form.values.passwordConfirmation}
    on:input={event => form.fields.passwordConfirmation.onInput(event.currentTarget.value)}
  >

  <button disabled={form.submitting}>
    {form.submitting ? 'Creating account...' : 'Create account'}
  </button>
</form>
```

:::

Read values from `form.values` and errors from `form.errors`. Use `form.fields.<name>` to report input and blur events. In Nuxt you can bind `v-model` to `form.values` directly.

::: tip
The schema runs in the browser as well as on the server. Keep checks that need the database or secrets (like "email already taken") in the server handler, not in a `customAsync()` rule on the shared schema.
:::

## When validation runs

Set `validateOn` to choose when the browser checks fields. The whole form is always validated on submit.

| `validateOn` | Behavior |
|---|---|
| `'submit'` (default) | Only on submit |
| `'blur'` | When `fields.<name>.onBlur()` is called. Only that field's errors are updated, so untouched fields stay quiet. |
| `'change'` | On every `fields.<name>.onInput()`, `set()`, or `form.setValue()` |

## Submitting

`form.submit()` validates in the browser first. If anything fails, it shows the errors and doesn't send a request.

With no `submitter`, the built-in one sends the form with `fetch`:

- **URL:** `action` option, or the `<form action>` attribute.
- **Method:** `method` option, or the `<form method>` attribute, or `POST`.
- **Body:** `FormData` built from the form element and `form.values`. For `GET` and `HEAD`, the values go in the query string instead.
- **CSRF:** for unsafe methods, the [CSRF token](/basics/security/csrf) from the security cookie is added automatically as `_token` when `@holo-js/security` is installed. A `_token` field already in the form is kept.

The response is applied to the form:

| Server response | Result |
|---|---|
| JSON `{ ok: true, status, data }` | Stored in `form.lastSubmission` |
| `204`, or any 2xx non-JSON response | Treated as success |
| 422 [error payload](/basics/validation/errors#the-422-response) | Field errors and values applied |
| Network failure or non-JSON error | `_root` error: "Unable to submit the form right now. Please try again." |

After a failure, password and other [sensitive](/basics/validation/rules#sensitive) fields are cleared, and `form.submitting` goes back to `false`.

### Use your own submitter

Pass `submitter` to send the request yourself, for example to call a Next.js server action or use Nuxt's `$fetch`. It receives a context object and returns the server's response:

| Context property | Type | Value |
|---|---|---|
| `action` | `string` or `undefined` | The `action` option, or the `<form action>` attribute |
| `method` | `string` | The `method` option, or the `<form method>` attribute, or `POST` |
| `values` | `TData` | The values that passed browser validation |
| `formData` | `FormData` | The form body. For unsafe methods, it already contains the CSRF field when `@holo-js/security` is installed. |


```ts [app/pages/posts/new.vue]
import { useForm } from '@holo-js/adapter-nuxt/client'
import { postForm } from '#shared/schemas/post'

const form = useForm(postForm, {
  initialValues: { title: '', body: '', status: 'draft' },
  async submitter({ formData }) {
    const submission = await $fetch('/api/posts', { method: 'POST', body: formData })

    if (submission?.ok === true) {
      await navigateTo('/posts')
    }

    return submission
  },
})
```

If the submitter throws a validation error (such as a `$fetch` error with a 422 body), `useForm()` applies it like a normal response. The CSRF token is already in `formData` when the submitter runs.

## Frontend and API on different origins

When the page and the API live on different origins, the page can't read the API's CSRF cookie. Point `csrf.endpoint` at an API route that returns `{ token: string }` and sets the CSRF cookie:

```ts
const form = useForm(contactForm, {
  action: 'https://api.example.com/api/v1/contact',
  credentials: 'include',
  csrf: {
    endpoint: 'https://api.example.com/api/v1/csrf',
  },
})
```

Before each unsafe submission, `useForm()` fetches the endpoint with the same `credentials` and sends the token in the `csrf.header` header from `config/security.ts` (`X-CSRF-TOKEN` by default). When that header is `X-XSRF-TOKEN`, it sends the endpoint token in the configured `csrf.field` form field instead, because this header only accepts encrypted cookie values. It doesn't add the cookie's token in this mode. The API must allow the page's origin with credentials; see [CORS and Proxies](/basics/security/cors-and-proxies). These options only apply to the built-in submitter.

## Field state

Each schema field has an entry in `form.fields`, nested the same way as the schema (`form.fields.address.city`).

| Member | Description |
|---|---|
| `value` | Current value (read and write) |
| `errors` | Messages for this field and anything nested under it |
| `touched` | `true` once the field has been edited or blurred |
| `dirty` | `true` when the value differs from its initial value |
| `onInput(value)` | Set the value from an input event |
| `set(value)` | Set the value programmatically |
| `onBlur()` | Mark as touched, and validate when `validateOn` is `'blur'` |
| `validate()` | Validate now and return this field's messages |

## Form methods and state

| Member | Description |
|---|---|
| `values` | All current values |
| `errors` | The [error bag](/basics/validation/errors#read-errors): `has()`, `first()`, `get()`, `flatten()` |
| `submitting` | `true` while a submission is in flight |
| `valid` | `true` when there are no errors |
| `lastSubmission` | The last response applied to the form |
| `submit()` | Validate and submit |
| `validate()` | Validate every field and return the submission object, with `valid`, `data`, `values`, and `errors` |
| `validateField(path)` | Validate and return messages for one path, such as `'address.city'` |
| `setValue(path, value)` | Set a value by path |
| `reset(values?)` | Go back to the initial values, merged with any `values` you pass (which become the new initial values). Clears errors, touched state, and `lastSubmission`. |
| `applyServerState(result)` | Apply a server response you received some other way |
| `subscribe(listener)` | Call `listener` whenever the form changes. Returns a function that stops listening. Framework adapters use it to re-render. |

```ts
const stop = form.subscribe(() => console.log(form.values))
stop()
```

## useForm options

| Option | Type | Description |
|---|---|---|
| `initialValues` | `Partial<TData>` | Starting values |
| `initialState` | `serialize()` or `fail()` output | Server state to show on first render, such as values and errors from a previous attempt |
| `validateOn` | `'submit' \| 'blur' \| 'change'` | When to validate in the browser. Default `'submit'`. |
| `action` | `string` | URL for the built-in submitter |
| `method` | `string` | HTTP method for the built-in submitter |
| `credentials` | `'omit' \| 'same-origin' \| 'include'` | `fetch` credentials mode for the built-in submitter |
| `csrf` | `{ endpoint: string }` | Fetch the CSRF token from this URL before unsafe submissions |
| `submitter` | `(context) => result` | Replace the built-in submitter |

Rate limiting has no client option. It is always enforced on the server with [`throttle`](/basics/forms/server#rate-limit-a-form).

## Next steps

- [Framework Recipes](/basics/forms/frameworks)
- [Handling Submissions](/basics/forms/server)
- [Error Messages](/basics/validation/errors)
