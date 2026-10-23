# 5. Admin CRUD

In this chapter you build the admin area: a dashboard with counts, full create/edit/delete screens for categories and tags, and a post list with a delete button. You'll add the post editor in the next chapter.

## What you'll build

| URL | Does |
| --- | --- |
| `/admin` | shows post, published, category, and tag counts |
| `/admin/categories` | lists, creates, and deletes categories |
| `/admin/categories/[id]/edit` | edits a category |
| `/admin/tags` and `/admin/tags/[id]/edit` | the same for tags |
| `/admin/posts` | lists all posts, including drafts, with a delete button |

For now anyone can open `/admin`. You'll lock it down in [chapter 7](/tutorial/auth) and [chapter 8](/tutorial/authorization).

::: warning Every form needs a CSRF token
Your project has CSRF protection turned on, so every `POST` must carry a token. Next.js and Nuxt forms in this tutorial submit through Holo's `useForm()`, which adds the token for you. SvelteKit forms include a hidden token field. A form that skips both gets a `419` response.
:::

## Step 1: Add the admin queries and writes

Add these imports to the top of your `blog.ts` file, next to the model imports:

```ts
import { DB, uniqueSlug } from '@holo-js/db'
```

Then add the admin functions at the bottom of the file:

```ts
export async function getAdminDashboardData() {
  const [postCount, publishedCount, categoryCount, tagCount] = await Promise.all([
    Post.count(),
    Post.where('status', 'published').count(),
    Category.count(),
    Tag.count(),
  ])

  return { postCount, publishedCount, categoryCount, tagCount }
}

export async function getAdminPostsData() {
  const [posts, categories, tags] = await Promise.all([
    Post.with('category', 'tags').orderBy('created_at', 'desc').get(),
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])

  return { posts, categories, tags }
}

export async function getAdminCategoriesData() {
  return { categories: await Category.orderBy('name').get() }
}

export async function getAdminCategoryById(id: number) {
  return await Category.where('id', id).first()
}

export async function getAdminTagsData() {
  return { tags: await Tag.orderBy('name').get() }
}

export async function getAdminTagById(id: number) {
  return await Tag.where('id', id).first()
}

export async function createCategory(input: { name: string, description?: string }) {
  const name = input.name.trim()

  await Category.create({
    name,
    slug: await uniqueSlug(Category, name),
    description: input.description?.trim() || null,
  })
}

export async function updateCategory(id: number, input: { name: string, description?: string }) {
  const name = input.name.trim()
  const category = await Category.findOrFail(id)

  await category.update({
    name,
    slug: await uniqueSlug(Category, name, { ignore: id }),
    description: input.description?.trim() || null,
  })
}

export async function deleteCategory(id: number) {
  await DB.transaction(async () => {
    await Post.where('category_id', id).update({ category_id: null })
    await Category.delete(id)
  })
}

export async function createTag(input: { name: string }) {
  const name = input.name.trim()

  await Tag.create({
    name,
    slug: await uniqueSlug(Tag, name),
  })
}

export async function updateTag(id: number, input: { name: string }) {
  const name = input.name.trim()
  const tag = await Tag.findOrFail(id)

  await tag.update({
    name,
    slug: await uniqueSlug(Tag, name, { ignore: id }),
  })
}

export async function deleteTag(id: number) {
  await DB.transaction(async () => {
    const tag = await Tag.find(id)
    if (tag) {
      await tag.posts().detach()
    }

    await Tag.delete(id)
  })
}

export async function deletePost(id: number) {
  await DB.transaction(async () => {
    const post = await Post.find(id)
    if (post) {
      await post.tags().detach()
    }

    await Post.delete(id)
  })
}
```

The new pieces:

- **`uniqueSlug(Category, name)`** turns "Release Notes" into `release-notes`, and adds a suffix if that slug is taken. On update, `{ ignore: id }` stops the record from clashing with its own slug.
- **`findOrFail(id)`** throws a not-found error when the record doesn't exist, so you don't need an `if` check.
- **`DB.transaction()`** runs several writes as one unit. If any write fails, none of them are saved. Deleting a category first un-assigns its posts; deleting a tag or post first removes its `post_tags` rows.
- **`tag.posts().detach()`** removes every link row for that tag.

## Step 2: Add the form schemas

A schema describes a form's fields and rules. The same schema checks the input in the browser and on the server. You'll learn more about schemas in [chapter 6](/tutorial/forms-and-validation).

::: code-group

```ts [Next.js]
// lib/schemas/blog.ts
import { field, schema } from '@holo-js/validation'

export const categoryForm = schema({
  name: field.string().required('Category name is required.'),
  description: field.string().optional(),
})

export const tagForm = schema({
  name: field.string().required('Tag name is required.'),
})

export const deleteForm = schema({})
```

```ts [Nuxt]
// shared/schemas/blog.ts
import { field, schema } from '@holo-js/validation'

export const categoryForm = schema({
  name: field.string().required('Category name is required.'),
  description: field.string().optional(),
})

export const tagForm = schema({
  name: field.string().required('Tag name is required.'),
})

export const deleteForm = schema({})
```

```ts [SvelteKit]
// src/lib/schemas/blog.ts
import { field, schema } from '@holo-js/validation'

export const categoryForm = schema({
  name: field.string().required('Category name is required.'),
  description: field.string().optional(),
})

export const tagForm = schema({
  name: field.string().required('Tag name is required.'),
})
```

:::

`deleteForm` has no fields. Next.js and Nuxt use it so delete buttons go through `useForm()` and carry the CSRF token.

In Nuxt, files in `shared/` can be imported from both pages and server code as `#shared/...`.

## Step 3: Handle the admin requests on the server

Each framework has its own way to load admin data and receive a form post. All three call the same `blog.ts` functions.

::: code-group

```ts [Next.js]
// app/admin/actions.ts
'use server'

import { redirect } from 'next/navigation'
import { validate } from '@holo-js/forms'

import { categoryForm, deleteForm, tagForm } from '@/lib/schemas/blog'
import {
  createCategory,
  createTag,
  deleteCategory,
  deletePost,
  deleteTag,
  updateCategory,
  updateTag,
} from '@/server/lib/blog'

export async function createCategoryAction(formData: FormData) {
  const data = await validate(formData, categoryForm)
  await createCategory(data)
  redirect('/admin/categories')
}

export async function updateCategoryAction(id: number, formData: FormData) {
  const data = await validate(formData, categoryForm)
  await updateCategory(id, data)
  redirect('/admin/categories')
}

export async function deleteCategoryAction(id: number, formData: FormData) {
  await validate(formData, deleteForm)
  await deleteCategory(id)
  redirect('/admin/categories')
}

export async function createTagAction(formData: FormData) {
  const data = await validate(formData, tagForm)
  await createTag(data)
  redirect('/admin/tags')
}

export async function updateTagAction(id: number, formData: FormData) {
  const data = await validate(formData, tagForm)
  await updateTag(id, data)
  redirect('/admin/tags')
}

export async function deleteTagAction(id: number, formData: FormData) {
  await validate(formData, deleteForm)
  await deleteTag(id)
  redirect('/admin/tags')
}

export async function deletePostAction(id: number, formData: FormData) {
  await validate(formData, deleteForm)
  await deletePost(id)
  redirect('/admin/posts')
}
```

```ts [Nuxt]
// server/api/admin/dashboard.get.ts
import { getAdminDashboardData } from '../../lib/blog'

export default defineEventHandler(async () => await getAdminDashboardData())

// server/api/admin/categories/index.get.ts
import { getAdminCategoriesData } from '../../../lib/blog'

export default defineEventHandler(async () => await getAdminCategoriesData())

// server/api/admin/categories/[id].get.ts
import { getAdminCategoryById } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getAdminCategoryById(Number(event.context.params?.id || 0)))

// server/api/admin/tags/index.get.ts
import { getAdminTagsData } from '../../../lib/blog'

export default defineEventHandler(async () => await getAdminTagsData())

// server/api/admin/tags/[id].get.ts
import { getAdminTagById } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getAdminTagById(Number(event.context.params?.id || 0)))

// server/api/admin/posts/index.get.ts
import { getAdminPostsData } from '../../../lib/blog'

export default defineEventHandler(async () => await getAdminPostsData())

// server/routes/admin/categories/create.post.ts
import { validate } from '@holo-js/forms'

import { categoryForm } from '#shared/schemas/blog'
import { createCategory } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const data = await validate(event, categoryForm)
  await createCategory(data)
  return sendRedirect(event, '/admin/categories', 303)
})

// server/routes/admin/categories/[id]/update.post.ts
import { validate } from '@holo-js/forms'

import { categoryForm } from '#shared/schemas/blog'
import { updateCategory } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  const data = await validate(event, categoryForm)
  await updateCategory(Number(event.context.params?.id || 0), data)
  return sendRedirect(event, '/admin/categories', 303)
})

// server/routes/admin/categories/[id]/delete.post.ts
import { deleteCategory } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  await deleteCategory(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/categories', 303)
})

// server/routes/admin/tags/create.post.ts
import { validate } from '@holo-js/forms'

import { tagForm } from '#shared/schemas/blog'
import { createTag } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const data = await validate(event, tagForm)
  await createTag(data)
  return sendRedirect(event, '/admin/tags', 303)
})

// server/routes/admin/tags/[id]/update.post.ts
import { validate } from '@holo-js/forms'

import { tagForm } from '#shared/schemas/blog'
import { updateTag } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  const data = await validate(event, tagForm)
  await updateTag(Number(event.context.params?.id || 0), data)
  return sendRedirect(event, '/admin/tags', 303)
})

// server/routes/admin/tags/[id]/delete.post.ts
import { deleteTag } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  await deleteTag(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/tags', 303)
})

// server/routes/admin/posts/[id]/delete.post.ts
import { deletePost } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  await deletePost(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/posts', 303)
})
```

```ts [SvelteKit]
// src/routes/+layout.server.ts
import { csrf } from '@holo-js/security'
import type { LayoutServerLoad } from './$types'

export const load = (async ({ request }) => ({
  csrf: { input: await csrf.input(request) },
})) satisfies LayoutServerLoad

// src/routes/admin/+page.server.ts
import { getAdminDashboardData } from '$lib/server/blog'

export async function load() {
  return await getAdminDashboardData()
}

// src/routes/admin/categories/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'

import { categoryForm } from '$lib/schemas/blog'
import { createCategory, deleteCategory, getAdminCategoriesData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminCategoriesData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const data = await validate(request, categoryForm)
    await createCategory(data)
    redirect(303, '/admin/categories')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    await deleteCategory(Number(formData.get('id')))
    redirect(303, '/admin/categories')
  },
} satisfies Actions

// src/routes/admin/categories/[id]/edit/+page.server.ts
import { error, redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'

import { categoryForm } from '$lib/schemas/blog'
import { getAdminCategoryById, updateCategory } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const category = await getAdminCategoryById(Number(params.id))
  if (!category) {
    throw error(404, 'Category not found')
  }

  return { category }
}) satisfies PageServerLoad

export const actions = {
  update: async ({ params, request }) => {
    const data = await validate(request, categoryForm)
    await updateCategory(Number(params.id), data)
    redirect(303, '/admin/categories')
  },
} satisfies Actions

// src/routes/admin/tags/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'

import { tagForm } from '$lib/schemas/blog'
import { createTag, deleteTag, getAdminTagsData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminTagsData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const data = await validate(request, tagForm)
    await createTag(data)
    redirect(303, '/admin/tags')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    await deleteTag(Number(formData.get('id')))
    redirect(303, '/admin/tags')
  },
} satisfies Actions

// src/routes/admin/tags/[id]/edit/+page.server.ts
import { error, redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'

import { tagForm } from '$lib/schemas/blog'
import { getAdminTagById, updateTag } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const tag = await getAdminTagById(Number(params.id))
  if (!tag) {
    throw error(404, 'Tag not found')
  }

  return { tag }
}) satisfies PageServerLoad

export const actions = {
  update: async ({ params, request }) => {
    const data = await validate(request, tagForm)
    await updateTag(Number(params.id), data)
    redirect(303, '/admin/tags')
  },
} satisfies Actions

// src/routes/admin/posts/+page.server.ts
import { redirect } from '@sveltejs/kit'

import { deletePost, getAdminPostsData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminPostsData()
}) satisfies PageServerLoad

export const actions = {
  delete: async ({ request }) => {
    const formData = await request.formData()
    await deletePost(Number(formData.get('id')))
    redirect(303, '/admin/posts')
  },
} satisfies Actions
```

:::

Each tab holds several files. Each file starts with a comment that holds its path.

- **Next.js** server components call `blog.ts` directly, so it only needs server actions for the writes.
- **Nuxt** pages read from `server/api/admin/*` and post forms to `server/routes/admin/*`.
- **SvelteKit** uses a `load` function for reads and named form actions (`?/create`, `?/delete`) for writes.

`validate()` reads the submitted fields, checks them against the schema, and returns typed data, so `data.name` is a `string`. If a rule fails, it throws a validation error that Holo sends back to the form. It accepts a `FormData`, a `Request`, or a Nuxt event.

In SvelteKit, the root layout returns `csrf.input`, a ready-made hidden input. Every page can read it as `data.csrf.input`.

## Step 4: Build the dashboard

::: code-group

```tsx [Next.js]
// app/admin/page.tsx
import Link from 'next/link'

import { getAdminDashboardData } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function AdminDashboardPage() {
  const dashboard = await getAdminDashboardData()

  return (
    <section>
      <h1>Admin</h1>
      <div>
        <article><strong>{dashboard.postCount}</strong> Posts</article>
        <article><strong>{dashboard.publishedCount}</strong> Published</article>
        <article><strong>{dashboard.categoryCount}</strong> Categories</article>
        <article><strong>{dashboard.tagCount}</strong> Tags</article>
      </div>
      <Link href="/admin/posts">Manage posts</Link>
      <Link href="/admin/categories">Manage categories</Link>
      <Link href="/admin/tags">Manage tags</Link>
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/admin/index.vue -->
<script setup lang="ts">
const { data } = await useFetch('/api/admin/dashboard', {
  pick: ['postCount', 'publishedCount', 'categoryCount', 'tagCount'],
})
</script>

<template>
  <section>
    <h1>Admin</h1>
    <div>
      <article><strong>{{ data?.postCount }}</strong> Posts</article>
      <article><strong>{{ data?.publishedCount }}</strong> Published</article>
      <article><strong>{{ data?.categoryCount }}</strong> Categories</article>
      <article><strong>{{ data?.tagCount }}</strong> Tags</article>
    </div>
    <NuxtLink to="/admin/posts">Manage posts</NuxtLink>
    <NuxtLink to="/admin/categories">Manage categories</NuxtLink>
    <NuxtLink to="/admin/tags">Manage tags</NuxtLink>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/admin/+page.svelte -->
<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<section>
  <h1>Admin</h1>
  <div>
    <article><strong>{data.postCount}</strong> Posts</article>
    <article><strong>{data.publishedCount}</strong> Published</article>
    <article><strong>{data.categoryCount}</strong> Categories</article>
    <article><strong>{data.tagCount}</strong> Tags</article>
  </div>
  <a href="/admin/posts">Manage posts</a>
  <a href="/admin/categories">Manage categories</a>
  <a href="/admin/tags">Manage tags</a>
</section>
```

:::

## Step 5: Add a delete button (Next.js and Nuxt)

Next.js and Nuxt send deletes through `useForm()` so the CSRF token goes along. Make one small component and reuse it on every list. SvelteKit uses a plain form with the hidden token, so it doesn't need this step.

::: code-group

```tsx [Next.js]
// app/admin/delete-button.tsx
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { deleteForm } from '@/lib/schemas/blog'

export function DeleteButton({ action }: { action: (formData: FormData) => Promise<void> }) {
  const form = useForm(deleteForm, {
    submitter: ({ formData }) => action(formData),
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <button type="submit" disabled={form.submitting}>Delete</button>
    </form>
  )
}
```

```vue [Nuxt]
<!-- app/components/DeleteButton.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { deleteForm } from '#shared/schemas/blog'

const props = defineProps<{ action: string }>()
const emit = defineEmits<{ deleted: [] }>()

const form = useForm(deleteForm, {
  async submitter({ formData }) {
    await $fetch(props.action, { method: 'POST', body: formData })
    emit('deleted')
  },
})
</script>

<template>
  <button type="button" :disabled="form.submitting" @click="form.submit()">Delete</button>
</template>
```

```svelte [SvelteKit]
<!-- Nothing to add. SvelteKit delete forms include {...data.csrf.input} directly. -->
```

:::

## Step 6: Build the category screens

::: code-group

```tsx [Next.js]
// app/admin/categories/category-form.tsx
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { categoryForm } from '@/lib/schemas/blog'

type CategoryFormProps = {
  action: (formData: FormData) => Promise<void>
  category?: { name: string, description: string | null }
  submitLabel: string
}

export function CategoryForm({ action, category, submitLabel }: CategoryFormProps) {
  const form = useForm(categoryForm, {
    initialValues: {
      name: category?.name ?? '',
      description: category?.description ?? '',
    },
    async submitter({ formData }) {
      return await action(formData)
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <input name="name" value={form.values.name} onInput={(event) => form.fields.name.onInput(event.currentTarget.value)} placeholder="Category name" />
      {form.errors.has('name') ? <span>{form.errors.first('name')}</span> : null}
      <textarea name="description" value={form.values.description ?? ''} onInput={(event) => form.fields.description.onInput(event.currentTarget.value)} rows={3} placeholder="Description" />
      <button type="submit" disabled={form.submitting}>{submitLabel}</button>
    </form>
  )
}

// app/admin/categories/page.tsx
import Link from 'next/link'

import { getAdminCategoriesData } from '@/server/lib/blog'
import { createCategoryAction, deleteCategoryAction } from '../actions'
import { DeleteButton } from '../delete-button'
import { CategoryForm } from './category-form'

export const dynamic = 'force-dynamic'

export default async function AdminCategoriesPage() {
  const { categories } = await getAdminCategoriesData()

  return (
    <section>
      <h1>Categories</h1>
      <CategoryForm action={createCategoryAction} submitLabel="Create category" />
      {categories.map(category => (
        <article key={category.id}>
          <strong>{category.name}</strong> <span>{category.slug}</span>
          <Link href={`/admin/categories/${category.id}/edit`}>Edit</Link>
          <DeleteButton action={deleteCategoryAction.bind(null, category.id)} />
        </article>
      ))}
    </section>
  )
}

// app/admin/categories/[id]/edit/page.tsx
import { notFound } from 'next/navigation'

import { getAdminCategoryById } from '@/server/lib/blog'
import { updateCategoryAction } from '../../../actions'
import { CategoryForm } from '../../category-form'

export const dynamic = 'force-dynamic'

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const category = await getAdminCategoryById(Number(id))

  if (!category) {
    notFound()
  }

  return (
    <section>
      <h1>Edit category</h1>
      <CategoryForm
        action={updateCategoryAction.bind(null, category.id)}
        category={{ name: category.name, description: category.description }}
        submitLabel="Save category"
      />
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/admin/categories/index.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { categoryForm } from '#shared/schemas/blog'

const { data, refresh } = await useFetch('/api/admin/categories')

const form = useForm(categoryForm, {
  initialValues: { name: '', description: '' },
  async submitter({ formData }) {
    const response = await fetch('/admin/categories/create', { method: 'POST', body: formData })
    if (!response.ok) {
      return await response.json()
    }

    await refresh()
    return { ok: true, status: response.status, data: undefined }
  },
})
</script>

<template>
  <section>
    <h1>Categories</h1>
    <form @submit.prevent="form.submit()">
      <input name="name" placeholder="Category name" v-model="form.values.name">
      <p v-if="form.errors.has('name')">{{ form.errors.first('name') }}</p>
      <textarea name="description" rows="3" placeholder="Description" v-model="form.values.description"></textarea>
      <button type="submit" :disabled="form.submitting">Create category</button>
    </form>
    <article v-for="category in data?.categories || []" :key="category.id">
      <strong>{{ category.name }}</strong> <span>{{ category.slug }}</span>
      <NuxtLink :to="`/admin/categories/${category.id}/edit`">Edit</NuxtLink>
      <DeleteButton :action="`/admin/categories/${category.id}/delete`" @deleted="refresh()" />
    </article>
  </section>
</template>

<!-- app/pages/admin/categories/[id]/edit.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { categoryForm } from '#shared/schemas/blog'

const route = useRoute()
const { data } = await useFetch(`/api/admin/categories/${route.params.id}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Category not found' })
}

const form = useForm(categoryForm, {
  initialValues: {
    name: data.value.name,
    description: data.value.description ?? '',
  },
  async submitter({ formData }) {
    const response = await fetch(`/admin/categories/${route.params.id}/update`, { method: 'POST', body: formData })
    if (!response.ok) {
      return await response.json()
    }

    await navigateTo('/admin/categories')
    return { ok: true, status: response.status, data: undefined }
  },
})
</script>

<template>
  <section>
    <h1>Edit category</h1>
    <form @submit.prevent="form.submit()">
      <input name="name" v-model="form.values.name">
      <p v-if="form.errors.has('name')">{{ form.errors.first('name') }}</p>
      <textarea name="description" rows="3" v-model="form.values.description"></textarea>
      <button type="submit" :disabled="form.submitting">Save category</button>
    </form>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/admin/categories/+page.svelte -->
<script lang="ts">
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'
  import { type PageData } from './$types'

  export let data: PageData

  const errors = useValidationErrors('default', { pageData: data })
</script>

<section>
  <h1>Categories</h1>
  <form action="?/create" method="post">
    <input {...data.csrf.input}>
    <input name="name" placeholder="Category name">
    {#if errors.has('name')}<p>{errors.first('name')}</p>{/if}
    <textarea name="description" rows="3" placeholder="Description"></textarea>
    <button type="submit">Create category</button>
  </form>
  {#each data.categories as category}
    <article>
      <strong>{category.name}</strong> <span>{category.slug}</span>
      <a href={`/admin/categories/${category.id}/edit`}>Edit</a>
      <form action="?/delete" method="post">
        <input {...data.csrf.input}>
        <input type="hidden" name="id" value={category.id}>
        <button type="submit">Delete</button>
      </form>
    </article>
  {/each}
</section>

<!-- src/routes/admin/categories/[id]/edit/+page.svelte -->
<script lang="ts">
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'
  import { type PageData } from './$types'

  export let data: PageData

  const errors = useValidationErrors('default', { pageData: data })
</script>

<section>
  <h1>Edit category</h1>
  <form action="?/update" method="post">
    <input {...data.csrf.input}>
    <input name="name" value={data.category.name}>
    {#if errors.has('name')}<p>{errors.first('name')}</p>{/if}
    <textarea name="description" rows="3">{data.category.description || ''}</textarea>
    <button type="submit">Save category</button>
  </form>
</section>
```

:::

How the forms work:

- **`useForm(schema, options)`** (Next.js and Nuxt) keeps the field values, runs the schema rules in the browser before sending, and adds the CSRF token. `submitter` decides where the data goes: a server action in Next.js, a `fetch` to a server route in Nuxt.
- **`form.errors.has('name')` and `form.errors.first('name')`** show the error for one field, whether it came from the browser check or from the server.
- **`useValidationErrors()`** (SvelteKit) reads the errors Holo sends back after a normal form post. Native SvelteKit forms keep working with JavaScript turned off.

## Step 7: Build the tag screens

Tags work the same way as categories, with only a `name` field.

::: code-group

```tsx [Next.js]
// app/admin/tags/tag-form.tsx
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { tagForm } from '@/lib/schemas/blog'

type TagFormProps = {
  action: (formData: FormData) => Promise<void>
  tag?: { name: string }
  submitLabel: string
}

export function TagForm({ action, tag, submitLabel }: TagFormProps) {
  const form = useForm(tagForm, {
    initialValues: { name: tag?.name ?? '' },
    async submitter({ formData }) {
      return await action(formData)
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <input name="name" value={form.values.name} onInput={(event) => form.fields.name.onInput(event.currentTarget.value)} placeholder="Tag name" />
      {form.errors.has('name') ? <span>{form.errors.first('name')}</span> : null}
      <button type="submit" disabled={form.submitting}>{submitLabel}</button>
    </form>
  )
}

// app/admin/tags/page.tsx
import Link from 'next/link'

import { getAdminTagsData } from '@/server/lib/blog'
import { createTagAction, deleteTagAction } from '../actions'
import { DeleteButton } from '../delete-button'
import { TagForm } from './tag-form'

export const dynamic = 'force-dynamic'

export default async function AdminTagsPage() {
  const { tags } = await getAdminTagsData()

  return (
    <section>
      <h1>Tags</h1>
      <TagForm action={createTagAction} submitLabel="Create tag" />
      {tags.map(tag => (
        <article key={tag.id}>
          <strong>#{tag.name}</strong>
          <Link href={`/admin/tags/${tag.id}/edit`}>Edit</Link>
          <DeleteButton action={deleteTagAction.bind(null, tag.id)} />
        </article>
      ))}
    </section>
  )
}

// app/admin/tags/[id]/edit/page.tsx
import { notFound } from 'next/navigation'

import { getAdminTagById } from '@/server/lib/blog'
import { updateTagAction } from '../../../actions'
import { TagForm } from '../../tag-form'

export const dynamic = 'force-dynamic'

export default async function EditTagPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tag = await getAdminTagById(Number(id))

  if (!tag) {
    notFound()
  }

  return (
    <section>
      <h1>Edit tag</h1>
      <TagForm action={updateTagAction.bind(null, tag.id)} tag={{ name: tag.name }} submitLabel="Save tag" />
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/admin/tags/index.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { tagForm } from '#shared/schemas/blog'

const { data, refresh } = await useFetch('/api/admin/tags')

const form = useForm(tagForm, {
  initialValues: { name: '' },
  async submitter({ formData }) {
    const response = await fetch('/admin/tags/create', { method: 'POST', body: formData })
    if (!response.ok) {
      return await response.json()
    }

    await refresh()
    return { ok: true, status: response.status, data: undefined }
  },
})
</script>

<template>
  <section>
    <h1>Tags</h1>
    <form @submit.prevent="form.submit()">
      <input name="name" placeholder="Tag name" v-model="form.values.name">
      <p v-if="form.errors.has('name')">{{ form.errors.first('name') }}</p>
      <button type="submit" :disabled="form.submitting">Create tag</button>
    </form>
    <article v-for="tag in data?.tags || []" :key="tag.id">
      <strong>#{{ tag.name }}</strong>
      <NuxtLink :to="`/admin/tags/${tag.id}/edit`">Edit</NuxtLink>
      <DeleteButton :action="`/admin/tags/${tag.id}/delete`" @deleted="refresh()" />
    </article>
  </section>
</template>

<!-- app/pages/admin/tags/[id]/edit.vue -->
<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { tagForm } from '#shared/schemas/blog'

const route = useRoute()
const { data } = await useFetch(`/api/admin/tags/${route.params.id}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Tag not found' })
}

const form = useForm(tagForm, {
  initialValues: { name: data.value.name },
  async submitter({ formData }) {
    const response = await fetch(`/admin/tags/${route.params.id}/update`, { method: 'POST', body: formData })
    if (!response.ok) {
      return await response.json()
    }

    await navigateTo('/admin/tags')
    return { ok: true, status: response.status, data: undefined }
  },
})
</script>

<template>
  <section>
    <h1>Edit tag</h1>
    <form @submit.prevent="form.submit()">
      <input name="name" v-model="form.values.name">
      <p v-if="form.errors.has('name')">{{ form.errors.first('name') }}</p>
      <button type="submit" :disabled="form.submitting">Save tag</button>
    </form>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/admin/tags/+page.svelte -->
<script lang="ts">
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'
  import { type PageData } from './$types'

  export let data: PageData

  const errors = useValidationErrors('default', { pageData: data })
</script>

<section>
  <h1>Tags</h1>
  <form action="?/create" method="post">
    <input {...data.csrf.input}>
    <input name="name" placeholder="Tag name">
    {#if errors.has('name')}<p>{errors.first('name')}</p>{/if}
    <button type="submit">Create tag</button>
  </form>
  {#each data.tags as tag}
    <article>
      <strong>#{tag.name}</strong>
      <a href={`/admin/tags/${tag.id}/edit`}>Edit</a>
      <form action="?/delete" method="post">
        <input {...data.csrf.input}>
        <input type="hidden" name="id" value={tag.id}>
        <button type="submit">Delete</button>
      </form>
    </article>
  {/each}
</section>

<!-- src/routes/admin/tags/[id]/edit/+page.svelte -->
<script lang="ts">
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'
  import { type PageData } from './$types'

  export let data: PageData

  const errors = useValidationErrors('default', { pageData: data })
</script>

<section>
  <h1>Edit tag</h1>
  <form action="?/update" method="post">
    <input {...data.csrf.input}>
    <input name="name" value={data.tag.name}>
    {#if errors.has('name')}<p>{errors.first('name')}</p>{/if}
    <button type="submit">Save tag</button>
  </form>
</section>
```

:::

## Step 8: List posts with a delete button

::: code-group

```tsx [Next.js]
// app/admin/posts/page.tsx
import Link from 'next/link'

import { getAdminPostsData } from '@/server/lib/blog'
import { deletePostAction } from '../actions'
import { DeleteButton } from '../delete-button'

export const dynamic = 'force-dynamic'

export default async function AdminPostsPage() {
  const { posts } = await getAdminPostsData()

  return (
    <section>
      <h1>Posts</h1>
      <Link href="/admin/posts/new">New post</Link>
      {posts.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <div>{post.status} · {post.category?.name ?? 'Uncategorized'}</div>
          <Link href={`/admin/posts/${post.id}/edit`}>Edit</Link>
          <DeleteButton action={deletePostAction.bind(null, post.id)} />
        </article>
      ))}
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/admin/posts/index.vue -->
<script setup lang="ts">
const { data, refresh } = await useFetch('/api/admin/posts', {
  pick: ['posts'],
})
</script>

<template>
  <section>
    <h1>Posts</h1>
    <NuxtLink to="/admin/posts/new">New post</NuxtLink>
    <article v-for="post in data?.posts || []" :key="post.id">
      <h2>{{ post.title }}</h2>
      <p>{{ post.status }} · {{ post.category?.name || 'Uncategorized' }}</p>
      <NuxtLink :to="`/admin/posts/${post.id}/edit`">Edit</NuxtLink>
      <DeleteButton :action="`/admin/posts/${post.id}/delete`" @deleted="refresh()" />
    </article>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/admin/posts/+page.svelte -->
<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<section>
  <h1>Posts</h1>
  <a href="/admin/posts/new">New post</a>
  {#each data.posts as post}
    <article>
      <h2>{post.title}</h2>
      <p>{post.status} · {post.category?.name || 'Uncategorized'}</p>
      <a href={`/admin/posts/${post.id}/edit`}>Edit</a>
      <form action="?/delete" method="post">
        <input {...data.csrf.input}>
        <input type="hidden" name="id" value={post.id}>
        <button type="submit">Delete</button>
      </form>
    </article>
  {/each}
</section>
```

:::

The "New post" and "Edit" links lead to pages you'll build in the next chapter.

## Step 9: Check it works

1. Open `/admin`. You should see 2 posts, 2 published, 2 categories, and 3 tags.
2. Open `/admin/categories` and create a category called "Release Notes". It appears with the slug `release-notes`.
3. Create a second "Release Notes". Its slug gets a suffix, because slugs are unique.
4. Submit the form with an empty name. You see "Category name is required." and nothing is saved.
5. Edit a category and rename it. The slug follows the new name.
6. Delete the "Engineering" category. Open `/admin/posts`: its post now shows "Uncategorized".
7. Delete a post. It disappears from `/admin/posts` and from the public `/posts` page.

To get the sample data back, run `npx holo migrate:fresh --seed`.

## Next steps

Next, build the post editor in [Forms and Validation](/tutorial/forms-and-validation).

To learn more:

- [Writing records](/orm/writes)
- [Transactions](/database/transactions)
- [Forms](/basics/forms/)
- [Handling submissions](/basics/forms/server)
- [CSRF protection](/basics/security/csrf)
