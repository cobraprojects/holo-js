# 9. Media Uploads

In this chapter you let editors attach a featured image to each post. Holo checks the file, stores it on the public disk, and makes a resized thumbnail.

## What you'll build

- an `images` collection on posts that holds one image
- file type and size limits, checked in the form and again when storing
- a `thumb` conversion: 960 × 540, cropped to fit, saved as WebP
- an image field in the post editor, and the image on the public post page

## Step 1: Install media support

```bash
npx holo install media
npx holo migrate
```

The installer adds the `@holo-js/media` package, a `config/media.ts` file, and a migration for the `media` table. The `media` table stores one row per file and links it to its post, so you don't need an `image` column on `posts`.

## Step 2: Add an image collection to the Post model

Wrap the existing model with `defineMediaModel()`:

```ts [server/models/Post.ts]
import { belongsTo, belongsToMany, defineModel } from '@holo-js/db'
import { collection, conversion, defineMediaModel } from '@holo-js/media'

const Post = defineModel('posts', {
  fillable: ['title', 'slug', 'excerpt', 'body', 'status', 'published_at', 'user_id', 'category_id'],
  relations: {
    user: belongsTo('User', { foreignKey: 'user_id' }),
    category: belongsTo('Category', { foreignKey: 'category_id' }),
    tags: belongsToMany('Tag', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'post_id',
      relatedPivotKey: 'tag_id',
    }).withPivot('is_primary').withTimestamps(),
  },
})

export default defineMediaModel(Post, {
  collections: [
    collection('images')
      .disk('public')
      .singleFile()
      .acceptsMimeTypes(['image/jpeg', 'image/png', 'image/webp'])
      .acceptsExtensions(['jpg', 'jpeg', 'png', 'webp'])
      .maxSize(2 * 1024 * 1024),
  ],
  conversions: [
    conversion('thumb')
      .performOnCollections('images')
      .width(960)
      .height(540)
      .fit('cover')
      .format('webp')
      .quality(82),
  ],
})
```

The model keeps all its query and relationship methods, and gains media methods such as `addMedia()` and `getFirstMediaUrl()`.

- **`.disk('public')`** stores files on the `public` disk from `config/storage.ts`, so browsers can load them by URL.
- **`.singleFile()`** keeps one image per post. Uploading a new one replaces the old one.
- **`acceptsMimeTypes`, `acceptsExtensions`, `maxSize`** reject anything that isn't a JPEG, PNG, or WebP up to 2 MB.
- **`conversion('thumb')`** makes a resized copy every time an image is added to `images`.

## Step 3: Add the image field to the schema

Add one line to `postForm`:

```ts
export const postForm = schema({
  title: field.string().required('Title is required.').min(3),
  excerpt: field.string().optional(),
  body: field.string().required('Body is required.'),
  status: field.string().required('Select a valid post status.').in(['draft', 'published'], 'Select a valid post status.'),
  categoryId: field.string().optional(),
  tagIds: field.array(field.number()).default([]),
  image: field.file().optional().image('The selected file must be an image.').maxSize('2mb', 'The selected file must be 2 MB or smaller.'),
})
```

The form now rejects non-images and large files before upload. The collection rules from step 2 check again when the file is stored.

## Step 4: Store the image when saving a post

In `blog.ts`, import `ValidationException`:

```ts
import { ValidationException } from '@holo-js/validation'
```

Then let `createPost()` and `updatePost()` accept an optional image and store it after the post is saved:

```ts
export async function createPost(input: PostInput & { authorId: number, image?: Blob }) {
  const post = await DB.transaction(async () => {
    // ...the same create and attach code as before...
  })

  if (input.image) {
    const result = await post.addMedia(input.image).toMediaCollection('images')
    if (result.error) {
      throw ValidationException.withMessages({
        image: [result.error.message],
      })
    }
  }

  return post
}

export async function updatePost(id: number, input: PostInput & { image?: Blob }) {
  const post = await DB.transaction(async () => {
    // ...the same update and sync code as before...
  })

  if (input.image) {
    const result = await post.addMedia(input.image).toMediaCollection('images')
    if (result.error) {
      throw ValidationException.withMessages({
        image: [result.error.message],
      })
    }
  }

  return post
}
```

- **`addMedia(file).toMediaCollection('images')`** checks the file against the collection rules, saves it, and generates the `thumb` conversion.
- It returns a result instead of throwing. If `result.error` is set, the file was rejected.
- **`ValidationException.withMessages()`** turns that rejection into a normal form error on the `image` field, so the user sees it under the file input.
- The upload happens after the transaction, so a slow upload doesn't hold the database transaction open.

## Step 5: Pass the image from the form

An empty file input still sends an empty file. Only pass the image when it has content. In every create and update handler, change the call like this:

::: code-group

```ts [Next.js]
// app/admin/actions.ts — in createPostAction and updatePostAction
await createPost({
  ...data,
  authorId: currentAuth.user.id,
  ...(data.image?.size ? { image: data.image } : {}),
})

await updatePost(id, {
  ...data,
  ...(data.image?.size ? { image: data.image } : {}),
})
```

```ts [Nuxt]
// server/routes/admin/posts/create.post.ts and [id]/update.post.ts
await createPost({
  ...data,
  authorId: user.id,
  ...(data.image?.size ? { image: data.image } : {}),
})

await updatePost(id, {
  ...data,
  ...(data.image?.size ? { image: data.image } : {}),
})
```

```ts [SvelteKit]
// src/routes/admin/posts/new/+page.server.ts and [id]/edit/+page.server.ts
await createPost({
  ...data,
  authorId: currentAuth.user.id,
  ...(data.image?.size ? { image: data.image } : {}),
})

await updatePost(id, {
  ...data,
  ...(data.image?.size ? { image: data.image } : {}),
})
```

:::

In Next.js, also raise the server action body limit. The default is too small for a 2 MB image:

```ts [next.config.ts]
import type { NextConfig } from 'next'
import { withHolo } from '@holo-js/adapter-next/config'

const nextConfig: NextConfig = withHolo({
  experimental: {
    serverActions: {
      bodySizeLimit: '3mb' as const,
    },
  },
})

export default nextConfig
```

## Step 6: Add the file input to the post forms

Add a file input and its error under the body field, in both the new and edit forms. In Next.js, the whole form is shown, with a new `imagePath` prop for the preview:

::: code-group

```jsx [Next.js]
// app/admin/posts/post-form.jsx
'use client'

import { useForm } from '@holo-js/adapter-next/client'
import Image from 'next/image'
import { postForm } from '@/lib/schemas/blog'

export function PostForm({ action, data, imagePath, post, submitLabel }) {
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
      {imagePath ? <Image src={imagePath} alt="" width={448} height={252} /> : null}
      <input name="image" type="file" accept="image/png,image/jpeg,image/webp" />
      {form.errors.has('image') ? <span>{form.errors.first('image')}</span> : null}
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
```

```vue [Nuxt]
<!-- app/pages/admin/posts/new.vue and [id]/edit.vue, after the body field -->
<img v-if="data?.imageUrl" :src="data.imageUrl" alt="">
<input name="image" type="file" accept="image/png,image/jpeg,image/webp">
<p v-if="form.errors.has('image')">{{ form.errors.first('image') }}</p>
```

```svelte [SvelteKit]
<!-- src/routes/admin/posts/new/+page.svelte and [id]/edit/+page.svelte, after the body field -->
{#if data.imageUrl}<img src={data.imageUrl} alt="">{/if}
<input name="image" type="file" accept="image/png,image/jpeg,image/webp">
{#if errors.has('image')}<p>{errors.first('image')}</p>{/if}
```

:::

The new-post pages have no image yet, so the preview only shows on the edit pages. Load the current thumbnail for the edit page:

::: code-group

```tsx [Next.js]
// app/admin/posts/[id]/edit/page.tsx
const imagePath = await data.post.getFirstMediaPath('images', 'thumb')

// ...and pass it to the form:
<PostForm action={updatePostAction.bind(null, data.post.id)} data={formData} imagePath={imagePath} post={post} submitLabel="Save post" />

// app/admin/posts/new/page.tsx — no image yet:
<PostForm action={createPostAction} data={formData} imagePath={undefined} post={undefined} submitLabel="Create post" />
```

```ts [Nuxt]
// server/api/admin/posts/[id].get.ts
import { authorize } from '@holo-js/authorization'

import { getAdminPostById } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async (event) => {
  await authorize('viewAny', Post)

  const data = await getAdminPostById(Number(event.context.params?.id || 0))
  if (!data) {
    return null
  }

  return {
    ...data,
    imageUrl: await data.post.getFirstMediaUrl('images', 'thumb'),
  }
})
```

```ts [SvelteKit]
// src/routes/admin/posts/[id]/edit/+page.server.ts — the load function
export const load = (async ({ params }) => {
  await authorize('viewAny', Post)

  const data = await getAdminPostById(Number(params.id))
  if (!data) {
    throw error(404, 'Post not found')
  }

  await authorize('update', data.post)

  return {
    ...data,
    imageUrl: await data.post.getFirstMediaUrl('images', 'thumb'),
  }
}) satisfies PageServerLoad
```

:::

In Nuxt, also add `'imageUrl'` to the `pick` list in the edit page's `useFetch()`.

- **`getFirstMediaUrl('images', 'thumb')`** returns the full URL of the thumbnail, or `null` when there's no image.
- **`getFirstMediaPath('images', 'thumb')`** returns just the path part, such as `/storage/...`. Next.js uses it because `next/image` accepts local paths without extra configuration.

## Step 7: Show the image on the post page

::: code-group

```tsx [Next.js]
// app/posts/[slug]/page.tsx
import Image from 'next/image'

// after the notFound() check:
const imagePath = await post.getFirstMediaPath('images', 'thumb')

// in the JSX, under the title:
{imagePath ? <Image src={imagePath} alt="" width={1200} height={675} /> : null}
```

```ts [Nuxt]
// server/api/blog/posts/[slug].get.ts
import { getPublishedPostBySlug } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const post = await getPublishedPostBySlug(String(getRouterParam(event, 'slug') || ''))
  if (!post) {
    return null
  }

  return {
    ...post.toJSON(),
    imageUrl: await post.getFirstMediaUrl('images', 'thumb'),
  }
})

// app/pages/posts/[slug].vue — under the title:
// <img v-if="data?.imageUrl" :src="data.imageUrl" alt="">
```

```ts [SvelteKit]
// src/routes/posts/[slug]/+page.server.ts
return {
  post: post.toJSON(),
  imageUrl: await post.getFirstMediaUrl('images', 'thumb'),
}

// src/routes/posts/[slug]/+page.svelte — under the title:
// {#if data.imageUrl}<img src={data.imageUrl} alt="">{/if}
```

:::

Holo serves files from the public disk under `/storage` (set by `STORAGE_ROUTE_PREFIX`). In Next.js, the project creator added `app/storage/[[...path]]/route.ts` for this; Nuxt and SvelteKit handle it for you.

## Step 8: Check it works

1. Sign in as the editor and edit a post. Choose a JPEG or PNG under 2 MB and save.
2. Edit the post again. The thumbnail preview shows above the file input.
3. Open the post's public page. The image shows under the title. Its URL starts with `/storage/` and ends in `.webp`, because you're seeing the `thumb` conversion.
4. Look in `storage/app/public/`. You'll find the original file and the thumbnail.
5. Upload a new image to the same post. It replaces the old one, because the collection is `singleFile()`.
6. Try a PDF or an image larger than 2 MB. You get an error under the file input and the post isn't changed.

## Next steps

Next, make the admin update live in [Realtime and Notifications](/tutorial/realtime-and-notifications).

To learn more:

- [Media library](/media/)
- [Image conversions](/media/conversions)
- [File storage](/storage/)
- [Amazon S3 and compatible storage](/storage/s3)
