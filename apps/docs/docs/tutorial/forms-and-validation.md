# 6. Forms and Validation

In this chapter you build the post editor. One schema describes the form, checks it in the browser, checks it again on the server, and gives you typed data to save.

## What you'll build

- a `postForm` schema with rules for every field
- `createPost()` and `updatePost()` functions that save a post and its tags in one transaction
- `/admin/posts/new` and `/admin/posts/[id]/edit` pages
- error messages under each field, from both the browser and the server

## Step 1: Define the post schema

Add `postForm` to your schemas file (`lib/schemas/blog.ts` in Next.js, `shared/schemas/blog.ts` in Nuxt, `src/lib/schemas/blog.ts` in SvelteKit):

```ts
export const postForm = schema({
  title: field.string().required('Title is required.').min(3),
  excerpt: field.string().optional(),
  body: field.string().required('Body is required.'),
  status: field.string().required('Select a valid post status.').in(['draft', 'published'], 'Select a valid post status.'),
  categoryId: field.string().optional(),
  tagIds: field.array(field.number()).default([]),
})
```

Each line is one field:

| Field | Rule |
| --- | --- |
| `title` | must be present and at least 3 characters |
| `excerpt` | optional text |
| `body` | must be present |
| `status` | must be `draft` or `published`, so nobody can post `status=deleted` |
| `categoryId` | optional; an empty value means "Uncategorized" |
| `tagIds` | a list of numbers from the tag checkboxes; empty when none are checked |

The second argument to `required()` and `in()` is the error message the user sees. `validate()` returns data typed from these rules, so `data.tagIds` is a `number[]` and `data.excerpt` is `string | undefined`.

## Step 2: Add the post writes to blog.ts

Add the `User` model to your imports in `blog.ts`:

::: code-group

```ts [Next.js]
// server/lib/blog.ts
import User from '../models/User'
```

```ts [Nuxt]
// server/lib/blog.ts
import User from '../models/User'
```

```ts [SvelteKit]
// src/lib/server/blog.ts
import User from '../../../server/models/User'
```

:::

Then add these functions:

```ts
type PostInput = {
  title: string
  excerpt?: string
  body: string
  status: string
  categoryId?: string
  tagIds: number[]
}

async function ensureAuthorId(): Promise<number> {
  const author = await User.orderBy('id').first()
  if (!author) {
    throw new Error('No users yet. Run npx holo seed to create one.')
  }

  return author.id
}

export async function getAdminPostFormData() {
  const [categories, tags] = await Promise.all([
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])

  return { categories, tags }
}

export async function getAdminPostById(id: number) {
  const [post, categories, tags] = await Promise.all([
    Post.firstWhere('id', id),
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])
  if (!post) return null

  return { post: await post.load('category', 'tags'), categories, tags }
}

export async function createPost(input: PostInput & { authorId?: number }) {
  return await DB.transaction(async () => {
    const authorId = input.authorId ?? await ensureAuthorId()
    const postStatus = input.status === 'draft' ? 'draft' : 'published'

    const post = await Post.create({
      user_id: authorId,
      category_id: input.categoryId ? Number(input.categoryId) : null,
      title: input.title.trim(),
      slug: await uniqueSlug(Post, input.title),
      excerpt: input.excerpt?.trim() || null,
      body: input.body.trim(),
      status: postStatus,
      published_at: postStatus === 'published' ? new Date() : null,
    })

    if (input.tagIds.length > 0) {
      await post.tags().attach(input.tagIds)
    }

    return post
  })
}

export async function updatePost(id: number, input: PostInput) {
  return await DB.transaction(async () => {
    const postStatus = input.status === 'draft' ? 'draft' : 'published'
    const post = await Post.findOrFail(id)

    await post.update({
      category_id: input.categoryId ? Number(input.categoryId) : null,
      title: input.title.trim(),
      slug: await uniqueSlug(Post, input.title, { ignore: id }),
      excerpt: input.excerpt?.trim() || null,
      body: input.body.trim(),
      status: postStatus,
      published_at: postStatus === 'published' ? post.published_at ?? new Date() : null,
    })

    await post.tags().sync(input.tagIds)

    return post
  })
}
```

- **`attach(ids)`** adds tag links. **`sync(ids)`** makes the post's tags match the list exactly, adding and removing links as needed.
- The transaction means a post is never saved without its tags, or the other way around.
- `published_at` is set the first time a post is published and kept on later edits.
- `ensureAuthorId()` picks the first user as the author for now. In [chapter 7](/tutorial/auth) you'll pass the signed-in user instead.

## Step 3: Receive the post form on the server

::: code-group

```ts [Next.js]
// app/admin/actions.ts — add these imports and actions
import { isValidationException } from '@holo-js/validation'
import { postForm } from '@/lib/schemas/blog'
import { createPost, updatePost } from '@/server/lib/blog'

export async function createPostAction(formData: FormData) {
  try {
    const data = await validate(formData, postForm)
    await createPost(data)
    redirect('/admin/posts')
  } catch (error) {
    if (isValidationException(error)) {
      return error.toJSON()
    }

    throw error
  }
}

export async function updatePostAction(id: number, formData: FormData) {
  try {
    const data = await validate(formData, postForm)
    await updatePost(id, data)
    redirect('/admin/posts')
  } catch (error) {
    if (isValidationException(error)) {
      return error.toJSON()
    }

    throw error
  }
}
```

```ts [Nuxt]
// server/api/admin/posts/[id].get.ts
import { getAdminPostById } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getAdminPostById(Number(event.context.params?.id || 0)))

// server/routes/admin/posts/create.post.ts
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { createPost } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const data = await validate(await readFormData(event), postForm)
  await createPost(data)
  return sendRedirect(event, '/admin/posts', 303)
})

// server/routes/admin/posts/[id]/update.post.ts
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { updatePost } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  const data = await validate(await readFormData(event), postForm)
  await updatePost(Number(event.context.params?.id || 0), data)
  return sendRedirect(event, '/admin/posts', 303)
})
```

```ts [SvelteKit]
// src/routes/admin/posts/new/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'

import { postForm } from '$lib/schemas/blog'
import { createPost, getAdminPostFormData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminPostFormData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const data = await validate(await request.formData(), postForm)
    await createPost(data)
    redirect(303, '/admin/posts')
  },
} satisfies Actions

// src/routes/admin/posts/[id]/edit/+page.server.ts
import { error, redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'

import { postForm } from '$lib/schemas/blog'
import { getAdminPostById, updatePost } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const data = await getAdminPostById(Number(params.id))
  if (!data) {
    throw error(404, 'Post not found')
  }

  return data
}) satisfies PageServerLoad

export const actions = {
  update: async ({ params, request }) => {
    const data = await validate(await request.formData(), postForm)
    await updatePost(Number(params.id), data)
    redirect(303, '/admin/posts')
  },
} satisfies Actions
```

:::

When validation fails, each framework sends the errors back differently:

- **Next.js**: the action catches the validation error and returns `error.toJSON()`. `useForm()` reads that result and shows the errors. Other errors, including Next.js's own redirect, are re-thrown.
- **Nuxt**: Holo turns the thrown validation error into a JSON response with status `422`. The page's `submitter` returns that JSON to `useForm()`.
- **SvelteKit**: Holo sends the errors back to the form page after the post, where `useValidationErrors()` reads them.

## Step 4: Build the post form

::: code-group

```jsx [Next.js]
// app/admin/posts/post-form.jsx
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { postForm } from '@/lib/schemas/blog'

export function PostForm({ action, data, post, submitLabel }) {
  const form = useForm(postForm, {
    validateOn: 'blur',
    initialValues: {
      title: post?.title ?? '',
      excerpt: post?.excerpt ?? '',
      body: post?.body ?? '',
      status: post?.status ?? 'published',
      categoryId: post?.category_id ? String(post.category_id) : '',
      tagIds: post?.tags?.map(tag => tag.id) ?? [],
    },
    async submitter({ formData }) {
      return await action(formData)
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <input name="title" value={form.values.title} onInput={(event) => form.fields.title.onInput(event.currentTarget.value)} onBlur={() => form.fields.title.onBlur()} placeholder="Title" />
      {form.errors.has('title') ? <span>{form.errors.first('title')}</span> : null}
      <textarea name="excerpt" value={form.values.excerpt ?? ''} onInput={(event) => form.fields.excerpt.onInput(event.currentTarget.value)} rows={3} placeholder="Excerpt" />
      <textarea name="body" value={form.values.body} onInput={(event) => form.fields.body.onInput(event.currentTarget.value)} onBlur={() => form.fields.body.onBlur()} rows={10} placeholder="Body" />
      {form.errors.has('body') ? <span>{form.errors.first('body')}</span> : null}
      <select name="categoryId" value={form.values.categoryId ?? ''} onChange={(event) => form.fields.categoryId.onInput(event.currentTarget.value)}>
        <option value="">Uncategorized</option>
        {data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <fieldset>
        <legend>Tags</legend>
        {data.tags.map(tag => (
          <label key={tag.id}>
            <input type="checkbox" name="tagIds" value={tag.id} defaultChecked={form.values.tagIds.includes(tag.id)} />
            {tag.name}
          </label>
        ))}
      </fieldset>
      <select name="status" value={form.values.status} onChange={(event) => form.fields.status.onInput(event.currentTarget.value)}>
        <option value="published">Published</option>
        <option value="draft">Draft</option>
      </select>
      {form.errors.has('status') ? <span>{form.errors.first('status')}</span> : null}
      <button type="submit" disabled={form.submitting}>{submitLabel}</button>
    </form>
  )
}

// app/admin/posts/new/page.tsx
import { getAdminPostFormData } from '@/server/lib/blog'
import { createPostAction } from '../../actions'
import { PostForm } from '../post-form'

export const dynamic = 'force-dynamic'

export default async function NewPostPage() {
  const data = await getAdminPostFormData()
  const formData = {
    categories: data.categories.map(category => ({ id: category.id, name: category.name })),
    tags: data.tags.map(tag => ({ id: tag.id, name: tag.name })),
  }

  return (
    <section>
      <h1>New post</h1>
      <PostForm action={createPostAction} data={formData} post={undefined} submitLabel="Create post" />
    </section>
  )
}

// app/admin/posts/[id]/edit/page.tsx
import { notFound } from 'next/navigation'

import { getAdminPostById } from '@/server/lib/blog'
import { updatePostAction } from '../../../actions'
import { PostForm } from '../../post-form'

export const dynamic = 'force-dynamic'

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getAdminPostById(Number(id))

  if (!data) {
    notFound()
  }

  const formData = {
    categories: data.categories.map(category => ({ id: category.id, name: category.name })),
    tags: data.tags.map(tag => ({ id: tag.id, name: tag.name })),
  }
  const post = {
    id: data.post.id,
    title: data.post.title,
    excerpt: data.post.excerpt,
    body: data.post.body,
    status: data.post.status,
    category_id: data.post.category_id,
    tags: data.post.tags.map(tag => ({ id: tag.id })),
  }

  return (
    <section>
      <h1>Edit post</h1>
      <PostForm action={updatePostAction.bind(null, data.post.id)} data={formData} post={post} submitLabel="Save post" />
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/admin/posts/new.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { postForm } from '#shared/schemas/blog'

const { data } = await useFetch('/api/admin/posts')
const form = useForm(postForm, {
  validateOn: 'blur',
  initialValues: {
    title: '',
    excerpt: '',
    body: '',
    status: 'published',
    categoryId: '',
    tagIds: [],
  },
  async submitter({ formData }) {
    const response = await fetch('/admin/posts/create', {
      method: 'POST',
      body: formData,
    })

    if (response.ok) {
      await navigateTo('/admin/posts')
      return { ok: true, status: response.status, data: undefined }
    }

    return await response.json()
  },
})
</script>

<template>
  <section>
    <h1>New post</h1>
    <form @submit.prevent="form.submit()">
      <input name="title" placeholder="Title" v-model="form.values.title" @blur="form.fields.title.onBlur()">
      <p v-if="form.errors.has('title')">{{ form.errors.first('title') }}</p>
      <textarea name="excerpt" placeholder="Excerpt" rows="3" v-model="form.values.excerpt"></textarea>
      <textarea name="body" placeholder="Body" rows="10" v-model="form.values.body" @blur="form.fields.body.onBlur()"></textarea>
      <p v-if="form.errors.has('body')">{{ form.errors.first('body') }}</p>
      <select name="categoryId" v-model="form.values.categoryId">
        <option value="">Uncategorized</option>
        <option v-for="category in data?.categories || []" :key="category.id" :value="category.id">{{ category.name }}</option>
      </select>
      <fieldset>
        <legend>Tags</legend>
        <label v-for="tag in data?.tags || []" :key="tag.id">
          <input type="checkbox" name="tagIds" :value="tag.id" v-model="form.values.tagIds">
          {{ tag.name }}
        </label>
      </fieldset>
      <select name="status" v-model="form.values.status">
        <option value="published">Published</option>
        <option value="draft">Draft</option>
      </select>
      <p v-if="form.errors.has('status')">{{ form.errors.first('status') }}</p>
      <button type="submit" :disabled="form.submitting">{{ form.submitting ? 'Creating post...' : 'Create post' }}</button>
    </form>
  </section>
</template>

<!-- app/pages/admin/posts/[id]/edit.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { postForm } from '#shared/schemas/blog'

const route = useRoute()
const { data } = await useFetch(`/api/admin/posts/${route.params.id}`, {
  pick: ['post', 'categories', 'tags'],
})

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Post not found' })
}

const form = useForm(postForm, {
  validateOn: 'blur',
  initialValues: {
    title: data.value.post.title,
    excerpt: data.value.post.excerpt ?? '',
    body: data.value.post.body,
    status: data.value.post.status === 'published' ? 'published' : 'draft',
    categoryId: data.value.post.category_id ? String(data.value.post.category_id) : '',
    tagIds: data.value.post.tags.map(tag => tag.id),
  },
  async submitter({ formData }) {
    const response = await fetch(`/admin/posts/${data.value?.post.id}/update`, {
      method: 'POST',
      body: formData,
    })

    if (response.ok) {
      await navigateTo('/admin/posts')
      return { ok: true, status: response.status, data: undefined }
    }

    return await response.json()
  },
})
</script>

<template>
  <section>
    <h1>Edit post</h1>
    <form @submit.prevent="form.submit()">
      <input name="title" v-model="form.values.title" @blur="form.fields.title.onBlur()">
      <p v-if="form.errors.has('title')">{{ form.errors.first('title') }}</p>
      <textarea name="excerpt" rows="3" v-model="form.values.excerpt"></textarea>
      <textarea name="body" rows="10" v-model="form.values.body" @blur="form.fields.body.onBlur()"></textarea>
      <p v-if="form.errors.has('body')">{{ form.errors.first('body') }}</p>
      <select name="categoryId" v-model="form.values.categoryId">
        <option value="">Uncategorized</option>
        <option v-for="category in data?.categories || []" :key="category.id" :value="category.id">{{ category.name }}</option>
      </select>
      <fieldset>
        <legend>Tags</legend>
        <label v-for="tag in data?.tags || []" :key="tag.id">
          <input type="checkbox" name="tagIds" :value="tag.id" v-model="form.values.tagIds">
          {{ tag.name }}
        </label>
      </fieldset>
      <select name="status" v-model="form.values.status">
        <option value="published">Published</option>
        <option value="draft">Draft</option>
      </select>
      <button type="submit" :disabled="form.submitting">{{ form.submitting ? 'Saving post...' : 'Save post' }}</button>
    </form>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/admin/posts/new/+page.svelte -->
<script>
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'

  export let data

  const errors = useValidationErrors()
</script>

<section>
  <h1>New post</h1>
  <form action="?/create" method="post" enctype="multipart/form-data">
    <input {...data.csrf.input}>
    <input name="title" placeholder="Title">
    {#if errors.has('title')}<p>{errors.first('title')}</p>{/if}
    <textarea name="excerpt" placeholder="Excerpt" rows="3"></textarea>
    <textarea name="body" placeholder="Body" rows="10"></textarea>
    {#if errors.has('body')}<p>{errors.first('body')}</p>{/if}
    <select name="categoryId">
      <option value="">Uncategorized</option>
      {#each data.categories as category}<option value={category.id}>{category.name}</option>{/each}
    </select>
    <fieldset>
      <legend>Tags</legend>
      {#each data.tags as tag}
        <label>
          <input type="checkbox" name="tagIds" value={tag.id}>
          {tag.name}
        </label>
      {/each}
    </fieldset>
    {#if errors.has('tagIds')}<p>{errors.first('tagIds')}</p>{/if}
    <select name="status"><option value="published">Published</option><option value="draft">Draft</option></select>
    {#if errors.has('status')}<p>{errors.first('status')}</p>{/if}
    <button type="submit">Create post</button>
  </form>
</section>

<!-- src/routes/admin/posts/[id]/edit/+page.svelte -->
<script>
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'

  export let data

  const selectedTagIds = new Set(data.post.tags.map(tag => tag.id))
  const errors = useValidationErrors()
</script>

<section>
  <h1>Edit post</h1>
  <form action="?/update" method="post" enctype="multipart/form-data">
    <input {...data.csrf.input}>
    <input name="title" value={data.post.title}>
    {#if errors.has('title')}<p>{errors.first('title')}</p>{/if}
    <textarea name="excerpt" rows="3">{data.post.excerpt || ''}</textarea>
    <textarea name="body" rows="10">{data.post.body}</textarea>
    {#if errors.has('body')}<p>{errors.first('body')}</p>{/if}
    <select name="categoryId" value={data.post.category_id || ''}>
      <option value="">Uncategorized</option>
      {#each data.categories as category}<option value={category.id}>{category.name}</option>{/each}
    </select>
    <fieldset>
      <legend>Tags</legend>
      {#each data.tags as tag}
        <label>
          <input type="checkbox" name="tagIds" value={tag.id} checked={selectedTagIds.has(tag.id)}>
          {tag.name}
        </label>
      {/each}
    </fieldset>
    <select name="status" value={data.post.status}><option value="published">Published</option><option value="draft">Draft</option></select>
    {#if errors.has('status')}<p>{errors.first('status')}</p>{/if}
    <button type="submit">Save post</button>
  </form>
</section>
```

:::

A few details worth knowing:

- **`validateOn: 'blur'`** checks a field when the user leaves it, so errors appear before they press submit.
- **Checkboxes named `tagIds`** send one value per checked box. The schema collects them into a `number[]`.
- **The forms already use `multipart/form-data`** (SvelteKit) or `FormData` (Next.js and Nuxt). That's what lets you add a file input in [chapter 9](/tutorial/media-uploads) without changing how the form is sent.
- The Next.js finished app writes the post form as a `.jsx` file. You can convert it to `.tsx` by adding prop types.

::: tip Server checks always run
The browser check is a convenience. The server runs the same schema on every request, so a user who edits the HTML or sends a request by hand still can't save a post with `status=deleted` or an empty body.
:::

## Step 5: Check it works

1. Open `/admin/posts/new`. Type "Hi" in the title and click into the body. An error appears under the title, because it's shorter than 3 characters.
2. Fill in a title and body, choose a category, tick two tags, set the status to **Draft**, and create the post.
3. The post appears in `/admin/posts` as `draft`. It does **not** appear on `/posts`, and its public URL returns 404.
4. Edit the post, set it to **Published**, untick one tag, and save. It now appears on `/posts` with only the remaining tag.
5. Edit it again and change only the excerpt. Its `published_at` date doesn't change.

## Next steps

Next, add sign-in in [Authentication](/tutorial/auth).

To learn more:

- [Validation](/basics/validation/)
- [Available rules](/basics/validation/rules)
- [Error messages](/basics/validation/errors)
- [Client-side forms](/basics/forms/client)
- [Forms in each framework](/basics/forms/frameworks)
