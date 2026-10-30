# Framework Recipes

The schema, `validate()`, and `useForm()` work the same everywhere. What changes per framework is where the form posts and how the page navigates afterwards. This page shows the common setups end to end.

All recipes use this schema:

```ts [lib/schemas/post.ts]
import { field, schema } from '@holo-js/validation'

export const postForm = schema({
  title: field.string().required('Title is required.').min(3),
  body: field.string().required('Body is required.'),
  status: field.string().required().in(['draft', 'published'] as const),
})
```

## Next.js: server action

Call the server action from a `submitter`. When validation fails, `useForm()` shows the field errors. When it succeeds, Next.js `redirect()` navigates as usual.

```ts [app/posts/new/actions.ts]
'use server'

import { redirect } from 'next/navigation'
import { validate } from '@holo-js/forms'
import { postForm } from '@/lib/schemas/post'
import Post from '@/server/models/Post'

export async function createPostAction(formData: FormData) {
  const data = await validate(formData, postForm)
  await Post.create(data)

  redirect('/posts')
}
```

```tsx [app/posts/new/page.tsx]
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { postForm } from '@/lib/schemas/post'
import { createPostAction } from './actions'

export default function NewPostPage() {
  const form = useForm(postForm, {
    validateOn: 'blur',
    initialValues: { title: '', body: '', status: 'draft' },
    async submitter({ formData }) {
      return await createPostAction(formData)
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <input
        name="title"
        value={form.values.title}
        onInput={event => form.fields.title.onInput(event.currentTarget.value)}
        onBlur={() => form.fields.title.onBlur()}
      />
      {form.errors.has('title') ? <p>{form.errors.first('title')}</p> : null}

      <textarea
        name="body"
        value={form.values.body}
        onInput={event => form.fields.body.onInput(event.currentTarget.value)}
      />
      {form.errors.has('body') ? <p>{form.errors.first('body')}</p> : null}

      <select
        name="status"
        value={form.values.status}
        onChange={event => form.fields.status.onInput(event.currentTarget.value as 'draft' | 'published')}
      >
        <option value="draft">Draft</option>
        <option value="published">Published</option>
      </select>

      <button disabled={form.submitting}>Save</button>
    </form>
  )
}
```

The submitter's `formData` is built from the form element, so inputs you don't bind to `form.values`, such as file inputs, are still sent.

A failed `validate()`, a `ValidationException` you throw, and a rate limit all leave the action the same way. Holo wraps every export of a file that starts with `'use server'`, except functions with a `'use cache'` directive, and when the browser called the action, the wrapper returns the failure payload as the action's result instead of throwing it:

```text
{ ok: false, status: 422, valid: false, message, bag: 'default', values, errors: { title: ['The title is required.'] } }
```

`useForm()` reads that result as field errors. Next.js doesn't log it or answer with a 500, the same as Laravel, which never reports a `ValidationException`. Other errors, `redirect()`, and `notFound()` behave as usual. The action still throws when server code calls it directly, or when another action calls it, so the outer action decides what to do. A form posted without JavaScript also still throws.

If you call a server action without `useForm()`, for example with React's `useActionState`, the failure payload is the action's result. The action's TypeScript return type doesn't include it, so pass the result to `serializeValidationException()` from `@holo-js/validation`, which returns the typed payload or `undefined`:

```tsx [app/posts/new/page.tsx]
'use client'

import { useActionState } from 'react'
import { serializeValidationException } from '@holo-js/validation'
import { createPostAction } from './actions'

export default function NewPostPage() {
  const [failure, formAction] = useActionState(
    async (_previous: unknown, formData: FormData) => serializeValidationException(await createPostAction(formData)),
    undefined,
  )

  return (
    <form action={formAction}>
      <input name="title" />
      {failure ? <p>{failure.errors.title?.[0]}</p> : null}
      <button>Save</button>
    </form>
  )
}
```

Only functions in a file with a top-level `'use server'` directive are wrapped. An inline server action, with `'use server'` inside the function body, still throws, so catch the error there and return `serializeValidationException(error)` from `@holo-js/validation`.

## Next.js: route handler

Route handlers in `app/**/route.ts` return a 422 response automatically when `validate()` throws. Point `useForm()` at the route with `action`:

```ts [app/api/posts/route.ts]
import { validate } from '@holo-js/forms'
import { postForm } from '@/lib/schemas/post'
import Post from '@/server/models/Post'

export async function POST(request: Request) {
  const data = await validate(request, postForm)
  const post = await Post.create(data)

  return Response.json({ ok: true, status: 201, data: { id: post.id } }, { status: 201 })
}
```

```tsx
const form = useForm(postForm, {
  action: '/api/posts',
  initialValues: { title: '', body: '', status: 'draft' },
})
```

## Nuxt: API route with useForm

Validate the h3 `event` directly in a `server/api` route. API routes always answer with JSON, so `useForm()` can show the errors:

```ts [server/api/posts.post.ts]
import { validate } from '@holo-js/forms'
import { postForm } from '#shared/schemas/post'
import Post from '../models/Post'

export default defineEventHandler(async (event) => {
  const data = await validate(event, postForm)
  const post = await Post.create(data)

  return { ok: true, status: 201, data: { id: post.id } }
})
```

```vue [app/pages/posts/new.vue]
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { postForm } from '#shared/schemas/post'

const form = useForm(postForm, {
  validateOn: 'blur',
  initialValues: { title: '', body: '', status: 'draft' },
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
    <input name="title" v-model="form.values.title" @blur="form.fields.title.onBlur()">
    <p v-if="form.errors.has('title')">{{ form.errors.first('title') }}</p>

    <textarea name="body" v-model="form.values.body" />
    <p v-if="form.errors.has('body')">{{ form.errors.first('body') }}</p>

    <select name="status" v-model="form.values.status">
      <option value="draft">Draft</option>
      <option value="published">Published</option>
    </select>

    <button :disabled="form.submitting">Save</button>
  </form>
</template>
```

Don't also give this form a native `action`. Pick one style per form.

## Native forms in Nuxt

For forms that must work without JavaScript, post to a route in `server/routes` (not `server/api`) and redirect on success:

```ts [server/routes/posts.post.ts]
import { validate } from '@holo-js/forms'
import { postForm } from '#shared/schemas/post'
import Post from '../models/Post'

export default defineEventHandler(async (event) => {
  const data = await validate(event, postForm)
  await Post.create(data)

  return sendRedirect(event, '/posts', 303)
})
```

When validation fails on a browser form post, Holo redirects back to the page the form came from (status 303) and flashes the errors for one request. The flash cookie holds only the error messages, never the submitted values, and is marked `Secure` when the request uses HTTPS. Read them with `useValidationErrors()`:

```vue [app/pages/posts/new.vue]
<script setup lang="ts">
import { useValidationErrors } from '@holo-js/adapter-nuxt/client'

const errors = useValidationErrors()
</script>

<template>
  <form action="/posts" method="post">
    <input name="title">
    <p v-if="errors.has('title')">{{ errors.first('title') }}</p>

    <textarea name="body" />
    <p v-if="errors.has('body')">{{ errors.first('body') }}</p>

    <button>Save</button>
  </form>
</template>
```

Native forms must include the CSRF field themselves. See [CSRF Protection](/basics/security/csrf).

## SvelteKit: form actions

SvelteKit form actions work with both `useForm()` and plain HTML forms. Throwing from `validate()` in an action sends the errors back to the page.

```ts [src/routes/posts/new/+page.server.ts]
import { redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'
import { csrf } from '@holo-js/security'
import { postForm } from '#lib/schemas/post.js'
import Post from '../../../../server/models/Post'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ request }) => {
  return {
    csrf: {
      input: await csrf.input(request),
    },
  }
}) satisfies PageServerLoad

export const actions = {
  default: async ({ request }) => {
    const data = await validate(request, postForm)
    await Post.create(data)

    redirect(303, '/posts')
  },
} satisfies Actions
```

With `useForm()`, keep a normal `<form method="post">`. The adapter takes over the submission and applies the action's errors:

```svelte [src/routes/posts/new/+page.svelte]
<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { postForm } from '#lib/schemas/post.js'

  import type { PageData } from './$types'

  export let data: PageData

  const form = useForm(postForm, {
    pageData: data,
    validateOn: 'blur',
    initialValues: { title: '', body: '', status: 'draft' },
  })
</script>

<form method="post">
  <input {...data.csrf.input}>

  <input
    name="title"
    value={form.values.title}
    on:input={event => form.fields.title.onInput(event.currentTarget.value)}
    on:blur={() => form.fields.title.onBlur()}
  >
  {#if form.errors.has('title')}<p>{form.errors.first('title')}</p>{/if}

  <textarea
    name="body"
    value={form.values.body}
    on:input={event => form.fields.body.onInput(event.currentTarget.value)}
  ></textarea>
  {#if form.errors.has('body')}<p>{form.errors.first('body')}</p>{/if}

  <button disabled={form.submitting}>Save</button>
</form>
```

In SvelteKit the flash is `HttpOnly`, so pages read it through the root layout load, with or without JavaScript. Add the load once, passing `url` so SvelteKit reruns it on each navigation and the flash reaches only the page it was written for. Then pass `pageData: data` to both `useForm()` and `useValidationErrors()`. Without `pageData`, the page shows no flashed errors or input.

```ts [src/routes/+layout.server.ts]
import { readValidationFlash } from '@holo-js/adapter-sveltekit'

export const load = ({ url }) => ({
  holoValidationFlash: readValidationFlash(url),
})
```

Here is a page that shows the flashed errors with a plain HTML form:

```svelte [src/routes/posts/new/+page.svelte]
<script lang="ts">
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'

  import type { PageData } from './$types'

  export let data: PageData

  const errors = useValidationErrors('default', { pageData: data })
</script>

<form method="post">
  <input {...data.csrf.input}>

  <input name="title">
  {#if errors.has('title')}<p>{errors.first('title')}</p>{/if}

  <textarea name="body"></textarea>
  {#if errors.has('body')}<p>{errors.first('body')}</p>{/if}

  <button>Save</button>
</form>
```

`csrf.input(request)` returns `{ type: 'hidden', name, value }`, ready to spread onto an `<input>`.

::: warning
`useForm()` in SvelteKit needs the Holo config wrapper. Projects created with Holo already have it in `vite.config.ts`: `sveltekit(withHoloSvelteKit(...))`, with `withHoloSvelteKit()` from `@holo-js/adapter-sveltekit/config`. Keep it when you edit that file.
:::

## SvelteKit: remote functions

Holo schemas are [Standard Schema](https://standardschema.dev) objects, so SvelteKit's `form()`, `query()`, and `command()` accept them directly. Show errors with SvelteKit's own remote form APIs rather than `useForm()`:

```ts [src/routes/posts/posts.remote.ts]
import { form } from '$app/server'
import { postForm } from '#lib/schemas/post.js'
import Post from '../../../server/models/Post'

export const createPost = form(postForm, async (data) => {
  await Post.create(data)
})
```

Field builders work too, for example `query(field.string().required(), ...)` for a single argument.

## Named error bags

On a page with several native forms, give each one its own bag so errors don't show up under the wrong form:

```ts
const data = await validate(request, passwordForm, { bag: 'password' })
```

```ts
const passwordErrors = useValidationErrors('password')
```

`useValidationErrors()` with no argument reads the `default` bag.

## Hook reference

Each adapter exports the same `useForm()` options and return value described on [Client-Side Forms](/basics/forms/client). They differ in defaults and in what else they export.

| | Next.js | Nuxt | SvelteKit |
|---|---|---|---|
| Import from | `@holo-js/adapter-next/client` | `@holo-js/adapter-nuxt/client` | `@holo-js/adapter-sveltekit/client` |
| `useForm(schema, options?)` | Yes | Yes | Yes |
| `useValidationErrors(bag?)` | No | Yes | Yes |
| Default `action` | The `<form action>` attribute | The `<form action>` attribute | The current page URL |
| Default submitter | `fetch` to `action` | `fetch` to `action` | SvelteKit form action, unless you set `credentials` or `csrf` |
| Errors from a native post | Not read | Read with `useValidationErrors()` | Read with `useValidationErrors()`, and `initialState` is filled in automatically |

Both `useForm()` and `useValidationErrors()` take a bag name when you have several forms. `useValidationErrors()` defaults to `'default'`.

### useValidationErrors(bag?)

Returns the flashed errors for one error bag from the last native form post, as an [error bag](/basics/validation/errors#read-errors). It returns an empty bag when no errors are flashed for that name. Use it when the form must work without JavaScript.

```vue [app/pages/account.vue]
<script setup lang="ts">
import { useValidationErrors } from '@holo-js/adapter-nuxt/client'

const passwordErrors = useValidationErrors('password')
</script>

<template>
  <p v-if="passwordErrors.has('currentPassword')">{{ passwordErrors.first('currentPassword') }}</p>
</template>
```

## Next steps

- [Client-Side Forms](/basics/forms/client)
- [Handling Submissions](/basics/forms/server)
- [CSRF Protection](/basics/security/csrf)
- [Next.js](/getting-started/frameworks/next), [Nuxt](/getting-started/frameworks/nuxt), [SvelteKit](/getting-started/frameworks/sveltekit)
