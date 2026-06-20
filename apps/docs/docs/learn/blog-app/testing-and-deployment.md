# Testing and Deployment

This chapter tests the blog the same way users depend on it: create a post, read it, update it, delete it, then verify the app still builds.

## What you will test

- creating a category and tag
- creating a published post
- reading the post from the public blog query
- updating the post to draft
- confirming drafts are hidden from public reads
- deleting the post
- building for deployment

## Files you will create

```txt
tests/blog-crud.test.ts
```

## Write a blog CRUD test

Create `tests/blog-crud.test.ts`.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initializeHoloAdapterProject } from '@holo-js/core'

import Category from '../server/models/Category'
import Post from '../server/models/Post'
import Tag from '../server/models/Tag'
import {
  createCategory,
  createPost,
  createTag,
  deleteCategory,
  deletePost,
  getPublishedPostBySlug,
  updateCategory,
  updatePost,
} from '../server/lib/blog'

let project: Awaited<ReturnType<typeof initializeHoloAdapterProject>>

describe('blog CRUD', () => {
  beforeAll(async () => {
    project = await initializeHoloAdapterProject(process.cwd())
  })

  afterAll(async () => {
    await project.runtime.shutdown()
  })

  it('creates, reads, updates, and deletes a blog post', async () => {
    await createCategory({
      name: 'Product',
      description: 'Product updates',
    })

    await createTag({ name: 'Release' })

    const category = await Category.where('slug', 'product').first()
    const tag = await Tag.where('slug', 'release').first()

    if (!category) {
      throw new Error('Expected product category to exist.')
    }

    if (!tag) {
      throw new Error('Expected release tag to exist.')
    }

    await createPost({
      title: 'Launching Holo Blog',
      excerpt: 'The first public post.',
      body: 'This post is created by the CRUD test.',
      status: 'published',
      categoryId: String(category.id),
      tagIds: String(tag.id),
    })

    const publishedPost = await getPublishedPostBySlug('launching-holo-blog')

    if (!publishedPost) {
      throw new Error('Expected published post to be visible.')
    }

    expect(publishedPost.title).toBe('Launching Holo Blog')
    expect(publishedPost.category_id).toBe(category.id)

    await updatePost(publishedPost.id, {
      title: 'Launching Holo Blog Updated',
      excerpt: 'The first public post, revised.',
      body: 'This post was updated by the CRUD test.',
      status: 'draft',
      categoryId: String(category.id),
      tagIds: String(tag.id),
    })

    const hiddenDraft = await getPublishedPostBySlug('launching-holo-blog-updated')

    expect(hiddenDraft).toBeUndefined()

    await deletePost(publishedPost.id)

    const deletedPost = await Post.find(publishedPost.id)

    expect(deletedPost).toBeUndefined()
  })
})
```

This test covers the blog behavior users care about:

- the app can create content
- published content is readable
- updates change public visibility
- deleted content is gone

## Run the test

```bash
vitest tests/blog-crud.test.ts --reporter=json
```

If the app uses a package script for tests, add this to `package.json`:

```json
{
  "scripts": {
    "test": "vitest --reporter=json"
  }
}
```

Then run:

```bash
bun run test
```

## Add more CRUD coverage

After the post workflow passes, add focused tests for category and tag behavior.

```ts
it('updates and deletes categories', async () => {
  await createCategory({
    name: 'Engineering',
    description: 'Engineering posts',
  })

  const category = await Category.where('slug', 'engineering').first()

  if (!category) {
    throw new Error('Expected engineering category to exist.')
  }

  await updateCategory(category.id, {
    name: 'Platform Engineering',
    description: 'Platform posts',
  })

  const updatedCategory = await Category.find(category.id)

  expect(updatedCategory?.slug).toBe('platform-engineering')

  await deleteCategory(category.id)

  expect(await Category.find(category.id)).toBeUndefined()
})
```

The same test file already imports `updateCategory` and `deleteCategory` from `server/lib/blog`.

## Build

After tests pass, build the app.

```bash
bun run build
```

## Production config

Before deployment, set production environment values for:

- database connection
- session secret
- auth provider secrets
- storage disk
- mail driver
- queue driver
- cache driver
- broadcast driver

Then cache config when appropriate:

```bash
bun run config:cache
```

## Checkpoint

The blog has a CRUD test that proves users can create, read, update, and delete content, and the app has a passing production build.

## Related reference

- [Testing](/testing)
- [Deployment](/deployment)
- [Configuration](/configuration)
- [Security](/security)
