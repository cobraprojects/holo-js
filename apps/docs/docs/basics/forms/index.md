# Forms

`@holo-js/forms` connects one [validation](/basics/validation/) schema to both ends of a form: the server checks the submission, and the client shows field errors, keeps the user's input, and tracks loading state. Use it whenever users submit data through a form.

## Quick example

Define the schema once in a file both the server and the browser can import:

```ts [lib/schemas/contact.ts]
import { field, schema } from '@holo-js/validation'

export const contactForm = schema({
  name: field.string().required('Tell us your name.'),
  email: field.string().required().email('Enter a valid email address.'),
  message: field.string().required().min(10),
})
```

Validate it on the server:

::: code-group

```ts [Next.js]
// app/api/contact/route.ts
import { validate } from '@holo-js/forms'
import { contactForm } from '@/lib/schemas/contact'

export async function POST(request: Request) {
  const data = await validate(request, contactForm)

  return Response.json({ ok: true, status: 200, data: { name: data.name } })
}
```

```ts [Nuxt]
// server/api/contact.post.ts
import { validate } from '@holo-js/forms'
import { contactForm } from '#shared/schemas/contact'

export default defineEventHandler(async (event) => {
  const data = await validate(event, contactForm)

  return { ok: true, status: 200, data: { name: data.name } }
})
```

```ts [SvelteKit]
// src/routes/api/contact/+server.ts
import { json } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'
import { contactForm } from '$lib/schemas/contact'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request }) => {
  const data = await validate(request, contactForm)

  return json({ ok: true, status: 200, data: { name: data.name } })
}
```

:::

Then bind it in the page with `useForm()`:

::: code-group

```tsx [Next.js]
// app/contact/page.tsx
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { contactForm } from '@/lib/schemas/contact'

export default function ContactPage() {
  const form = useForm(contactForm, {
    action: '/api/contact',
    validateOn: 'blur',
    initialValues: { name: '', email: '', message: '' },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <input
        name="name"
        value={form.values.name}
        onInput={event => form.fields.name.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.name.onBlur()}
      />
      {form.errors.has('name') ? <p>{form.errors.first('name')}</p> : null}

      <input
        name="email"
        value={form.values.email}
        onInput={event => form.fields.email.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.email.onBlur()}
      />
      {form.errors.has('email') ? <p>{form.errors.first('email')}</p> : null}

      <textarea
        name="message"
        value={form.values.message}
        onInput={event => form.fields.message.onInput(event.currentTarget.value)}
      />
      {form.errors.has('message') ? <p>{form.errors.first('message')}</p> : null}

      <button disabled={form.submitting}>Send</button>
      {form.lastSubmission?.ok === true ? <p>Thanks!</p> : null}
    </form>
  )
}
```

```vue [Nuxt]
<!-- app/pages/contact.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { contactForm } from '#shared/schemas/contact'

const form = useForm(contactForm, {
  action: '/api/contact',
  validateOn: 'blur',
  initialValues: { name: '', email: '', message: '' },
})
</script>

<template>
  <form @submit.prevent="form.submit()">
    <input name="name" v-model="form.values.name" @blur="form.fields.name.onBlur()">
    <p v-if="form.errors.has('name')">{{ form.errors.first('name') }}</p>

    <input name="email" v-model="form.values.email" @blur="form.fields.email.onBlur()">
    <p v-if="form.errors.has('email')">{{ form.errors.first('email') }}</p>

    <textarea name="message" v-model="form.values.message" />
    <p v-if="form.errors.has('message')">{{ form.errors.first('message') }}</p>

    <button :disabled="form.submitting">Send</button>
    <p v-if="form.lastSubmission?.ok === true">Thanks!</p>
  </form>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/contact/+page.svelte -->
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { contactForm } from '$lib/schemas/contact'

  import type { PageData } from './$types'

  export let data: PageData

  const form = useForm(contactForm, {
    pageData: data,
    action: '/api/contact',
    validateOn: 'blur',
    initialValues: { name: '', email: '', message: '' },
  })
</script>

<form on:submit|preventDefault={() => form.submit()}>
  <input
    name="name"
    value={form.values.name}
    on:input={event => form.fields.name.onInput(event.currentTarget.value)}
    on:blur={() => form.fields.name.onBlur()}
  >
  {#if form.errors.has('name')}<p>{form.errors.first('name')}</p>{/if}

  <input
    name="email"
    value={form.values.email}
    on:input={event => form.fields.email.onInput(event.currentTarget.value)}
    on:blur={() => form.fields.email.onBlur()}
  >
  {#if form.errors.has('email')}<p>{form.errors.first('email')}</p>{/if}

  <textarea
    name="message"
    value={form.values.message}
    on:input={event => form.fields.message.onInput(event.currentTarget.value)}
  ></textarea>
  {#if form.errors.has('message')}<p>{form.errors.first('message')}</p>{/if}

  <button disabled={form.submitting}>Send</button>
  {#if form.lastSubmission?.ok === true}<p>Thanks!</p>{/if}
</form>
```

:::

When the user submits:

1. `useForm()` validates the values in the browser. If they're invalid, it shows the errors and stops.
2. Otherwise it posts the form to `action`, adding the [CSRF token](/basics/security/csrf) when `@holo-js/security` is installed.
3. The server runs `validate()` again. If it fails, Holo responds with a [422 error payload](/basics/validation/errors#the-422-response).
4. `useForm()` applies the server's errors and values, or stores the success response in `form.lastSubmission`.

::: tip
Browser validation is only a convenience. The server check is the one that counts, so always call `validate()` on the server.
:::

## Install

Pick `forms` when you create the project; it adds `@holo-js/validation` too. To add it later, install `@holo-js/forms` and `@holo-js/validation` with your package manager. The client `useForm()` comes from your framework adapter, which is already installed.

## What each package does

| Package | Use it for |
|---|---|
| `@holo-js/validation` | Defining schemas with `schema()` and `field` |
| `@holo-js/forms` | Server-side `validate()` and `safeParse()` for submissions, with optional rate limiting |
| `@holo-js/adapter-next/client`, `@holo-js/adapter-nuxt/client`, `@holo-js/adapter-sveltekit/client` | `useForm()` and `useValidationErrors()` in pages |

## Choose a form style

| Style | When to use it |
|---|---|
| `useForm()` with JavaScript submission | Most forms. Inline errors, blur validation, loading state. |
| Next.js server action with `useForm()` | Next.js forms that should redirect after saving. |
| Native HTML form with `useValidationErrors()` | Nuxt and SvelteKit forms that must work without JavaScript. |
| SvelteKit remote functions | SvelteKit's own `form()`, `query()`, `command()`. Holo schemas plug straight in. |

[Framework Recipes](/basics/forms/frameworks) shows each style end to end.

## Helpers at a glance

| Helper | Where it's documented |
|---|---|
| `validate()`, `safeParse()`, `sanitizeFlashedInput()`, `FormContractError` | [Handling Submissions](/basics/forms/server#helpers-reference) |
| Submission object: `valid`, `data`, `values`, `errors`, `fail()`, `success()`, `serialize()` | [Handling Submissions](/basics/forms/server#helpers-reference) |
| `useForm()` options and return value | [Client-Side Forms](/basics/forms/client#useform-options) |
| `useForm()` per framework and `useValidationErrors()` | [Framework Recipes](/basics/forms/frameworks#hook-reference) |
| Schema and field helpers (`schema()`, `field`, rules) | [Validation](/basics/validation/) and [Available Rules](/basics/validation/rules) |

## Next steps

- [Handling Submissions](/basics/forms/server)
- [Client-Side Forms](/basics/forms/client)
- [Framework Recipes](/basics/forms/frameworks)
- [CSRF Protection](/basics/security/csrf)
