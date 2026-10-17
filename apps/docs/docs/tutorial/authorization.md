# 8. Authorization

Signing in proves who someone is. Authorization decides what they may do. In this chapter you write policies for posts, categories, and tags, and check them before every admin read and write.

## What you'll build

| Who | Can |
| --- | --- |
| any signed-in user | open the admin area, create draft posts, edit their own posts |
| the editor (`editor@example.com`) | everything: publish, edit any post, manage categories and tags, delete |
| guests | nothing in the admin area |

To keep the tutorial short, "editor" means the seeded `editor@example.com` account, the same check the finished app uses. In your own app you'd check a role column instead.

## Step 1: Write the post policy

A policy is a file in `server/policies/`. Holo finds it automatically, so there's nothing to register.

```ts [server/policies/PostPolicy.ts]
import { definePolicy, deny } from '@holo-js/authorization'

import Post from '../models/Post'

export default definePolicy('posts', Post, {
  class: {
    viewAny({ user }) {
      return Boolean(user)
    },
    create({ user }) {
      return Boolean(user)
    },
    publish({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can publish posts.')
    },
  },
  record: {
    update({ user }, post) {
      if (!user) {
        return deny('Sign in required.')
      }

      return String(user.id) === String(post.user_id) || user.email === 'editor@example.com'
        ? true
        : deny('Only the author or an editor can update this post.')
    },
    publish({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can publish posts.')
    },
    delete({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can delete posts.')
    },
  },
})
```

A policy has two kinds of abilities:

- **`class` abilities** answer questions about the model in general, such as "can this user create posts?". You check them with the model: `authorize('create', Post)`.
- **`record` abilities** answer questions about one record, such as "can this user edit *this* post?". They receive the record as the second argument. You check them with an instance: `authorize('update', post)`.

Each ability returns `true` to allow, or `deny('message')` to refuse with a message the user sees. `user` is the signed-in user, or `null` for guests, so a guest is refused automatically.

## Step 2: Write the category and tag policies

```ts [server/policies/CategoryPolicy.ts]
import { definePolicy, deny } from '@holo-js/authorization'

import Category from '../models/Category'

export default definePolicy('categories', Category, {
  class: {
    viewAny({ user }) {
      return Boolean(user)
    },
    manage({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can manage categories.')
    },
  },
  record: {
    update({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can update categories.')
    },
    delete({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can delete categories.')
    },
  },
})
```

```ts [server/policies/TagPolicy.ts]
import { definePolicy, deny } from '@holo-js/authorization'

import Tag from '../models/Tag'

export default definePolicy('tags', Tag, {
  class: {
    viewAny({ user }) {
      return Boolean(user)
    },
    manage({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can manage tags.')
    },
  },
  record: {
    update({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can update tags.')
    },
    delete({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors can delete tags.')
    },
  },
})
```

Ability names are yours to choose. `manage` is a custom ability for "create categories".

## Step 3: Check the policies before every write

`authorize(ability, modelOrRecord)` runs the matching ability for the signed-in user. If it's refused, it throws, and the request stops with a `403` page showing the `deny()` message. Put it before the write.

Here's where each check goes:

| Action | Check |
| --- | --- |
| open any admin page | `authorize('viewAny', Post)` |
| create a post | `authorize('create', Post)`, plus `authorize('publish', Post)` when the status is `published` |
| update a post | `authorize('update', post)`, plus `authorize('publish', post)` when publishing |
| delete a post | `authorize('delete', post)` |
| create a category or tag | `authorize('manage', Category)` / `authorize('manage', Tag)` |
| update or delete a category or tag | `authorize('update', category)` / `authorize('delete', category)` |

The post writes in each framework:

::: code-group

```ts [Next.js]
// app/admin/actions.ts — the post actions
import { authorize } from '@holo-js/authorization'
import Post from '@/server/models/Post'

export async function createPostAction(formData: FormData) {
  try {
    const currentAuth = await auth()
    if (!currentAuth.authenticated || !currentAuth.user) {
      redirect('/login')
    }

    const data = await validate(formData, postForm)
    await authorize('create', Post)
    if (data.status === 'published') {
      await authorize('publish', Post)
    }

    await createPost({
      ...data,
      authorId: currentAuth.user.id,
    })

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
    const post = await Post.findOrFail(id)
    await authorize('update', post)
    if (data.status === 'published') {
      await authorize('publish', post)
    }

    await updatePost(id, data)

    redirect('/admin/posts')
  } catch (error) {
    if (isValidationException(error)) {
      return error.toJSON()
    }

    throw error
  }
}

export async function deletePostAction(id: number, formData: FormData) {
  await validate(formData, deleteForm)
  await authorize('delete', await Post.findOrFail(id))
  await deletePost(id)
  redirect('/admin/posts')
}
```

```ts [Nuxt]
// server/routes/admin/posts/create.post.ts
import auth from '@holo-js/auth'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { createPost } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async (event) => {
  const user = await auth.user()
  if (!user) return sendRedirect(event, '/login', 303)

  const data = await validate(await readFormData(event), postForm)
  await authorize('create', Post)
  if (data.status === 'published') {
    await authorize('publish', Post)
  }

  await createPost({
    ...data,
    authorId: user.id,
  })

  return sendRedirect(event, '/admin/posts', 303)
})

// server/routes/admin/posts/[id]/update.post.ts
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { readFormData } from 'h3'

import { postForm } from '#shared/schemas/blog'
import { updatePost } from '../../../../lib/blog'
import Post from '../../../../models/Post'

export default defineEventHandler(async (event) => {
  const data = await validate(await readFormData(event), postForm)
  const id = Number(event.context.params?.id || 0)
  const post = await Post.findOrFail(id)
  await authorize('update', post)
  if (data.status === 'published') {
    await authorize('publish', post)
  }

  await updatePost(id, data)

  return sendRedirect(event, '/admin/posts', 303)
})

// server/routes/admin/posts/[id]/delete.post.ts
import { authorize } from '@holo-js/authorization'

import { deletePost } from '../../../../lib/blog'
import Post from '../../../../models/Post'

export default defineEventHandler(async (event) => {
  const id = Number(event.context.params?.id || 0)
  await authorize('delete', await Post.findOrFail(id))
  await deletePost(id)
  return sendRedirect(event, '/admin/posts', 303)
})
```

```ts [SvelteKit]
// src/routes/admin/posts/new/+page.server.ts — the create action
create: async ({ request }) => {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) redirect(303, '/login')

  const data = await validate(await request.formData(), postForm)
  await authorize('create', Post)
  if (data.status === 'published') {
    await authorize('publish', Post)
  }

  await createPost({
    ...data,
    authorId: currentAuth.user.id,
  })

  redirect(303, '/admin/posts')
},

// src/routes/admin/posts/[id]/edit/+page.server.ts — the update action
update: async ({ params, request }) => {
  const data = await validate(await request.formData(), postForm)
  const id = Number(params.id)
  const post = await Post.findOrFail(id)
  await authorize('update', post)
  if (data.status === 'published') {
    await authorize('publish', post)
  }

  await updatePost(id, data)
  redirect(303, '/admin/posts')
},

// src/routes/admin/posts/+page.server.ts — the delete action
delete: async ({ request }) => {
  const formData = await request.formData()
  const id = Number(formData.get('id'))
  await authorize('delete', await Post.findOrFail(id))
  await deletePost(id)
  redirect(303, '/admin/posts')
},

// Add these imports to the files above:
// import { authorize } from '@holo-js/authorization'
// import Post from '../../../../server/models/Post'   (adjust the ../ depth per file)
```

:::

Add the same kind of check to the category and tag writes. For example, the category create and delete:

::: code-group

```ts [Next.js]
// app/admin/actions.ts
import Category from '@/server/models/Category'

export async function createCategoryAction(formData: FormData) {
  const data = await validate(formData, categoryForm)
  await authorize('manage', Category)
  await createCategory(data)
  redirect('/admin/categories')
}

export async function deleteCategoryAction(id: number, formData: FormData) {
  await validate(formData, deleteForm)
  await authorize('delete', await Category.findOrFail(id))
  await deleteCategory(id)
  redirect('/admin/categories')
}
```

```ts [Nuxt]
// server/routes/admin/categories/create.post.ts
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'

import { categoryForm } from '#shared/schemas/blog'
import { createCategory } from '../../../lib/blog'
import Category from '../../../models/Category'

export default defineEventHandler(async (event) => {
  const data = await validate(event, categoryForm)
  await authorize('manage', Category)
  await createCategory(data)
  return sendRedirect(event, '/admin/categories', 303)
})

// server/routes/admin/categories/[id]/delete.post.ts
import { authorize } from '@holo-js/authorization'

import { deleteCategory } from '../../../../lib/blog'
import Category from '../../../../models/Category'

export default defineEventHandler(async (event) => {
  const id = Number(event.context.params?.id || 0)
  await authorize('delete', await Category.findOrFail(id))
  await deleteCategory(id)
  return sendRedirect(event, '/admin/categories', 303)
})
```

```ts [SvelteKit]
// src/routes/admin/categories/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'

import { categoryForm } from '$lib/schemas/blog'
import { createCategory, deleteCategory, getAdminCategoriesData } from '$lib/server/blog'
import Category from '../../../../server/models/Category'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  await authorize('viewAny', Category)
  return await getAdminCategoriesData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const data = await validate(request, categoryForm)
    await authorize('manage', Category)
    await createCategory(data)
    redirect(303, '/admin/categories')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    const id = Number(formData.get('id'))
    await authorize('delete', await Category.findOrFail(id))
    await deleteCategory(id)
    redirect(303, '/admin/categories')
  },
} satisfies Actions
```

:::

Repeat the pattern for category updates (`authorize('update', category)`) and for the three tag writes, using `Tag`.

## Step 4: Check the policies before admin reads

Reads need checks too, so a signed-in user without access can't load admin data by calling the endpoint directly.

::: code-group

```tsx [Next.js]
// app/admin/layout.tsx
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { authorize } from '@holo-js/authorization'

import Post from '@/server/models/Post'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)

  return children
}
```

```ts [Nuxt]
// server/api/admin/posts/index.get.ts
import { authorize } from '@holo-js/authorization'

import { getAdminPostsData } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async () => {
  await authorize('viewAny', Post)

  return await getAdminPostsData()
})

// Add the same first line to every file in server/api/admin/:
//   dashboard.get.ts and posts/*      -> authorize('viewAny', Post)
//   categories/*                      -> authorize('viewAny', Category)
//   tags/*                            -> authorize('viewAny', Tag)
```

```ts [SvelteKit]
// src/routes/admin/posts/+page.server.ts — the load function
export const load = (async () => {
  await authorize('viewAny', Post)
  return await getAdminPostsData()
}) satisfies PageServerLoad

// Add the same first line to every admin load function:
//   src/routes/admin/+page.server.ts and posts/*  -> authorize('viewAny', Post)
//   src/routes/admin/categories/*                 -> authorize('viewAny', Category)
//   src/routes/admin/tags/*                       -> authorize('viewAny', Tag)
```

:::

In the post edit page's loader, also check `authorize('update', post)` so users only open the editor for posts they may change. In Next.js, that's `await authorize('update', data.post)` in `app/admin/posts/[id]/edit/page.tsx`, right after the `notFound()` check.

::: tip 403 or 404?
`deny('message')` responds with `403 Forbidden`. When you don't want to reveal that a record exists at all, return `denyAsNotFound()` instead, and the user gets a `404`. See [403 vs 404](/authorization/errors).
:::

## Step 5: Check it works

1. Sign in as `editor@example.com`. Everything from earlier chapters still works: publish, edit, delete, manage categories and tags.
2. Sign out and register a new account, for example `writer@example.com`.
3. As the writer, create a post with status **Draft**. It saves.
4. Create another post with status **Published**. You get a 403 page that says "Only editors can publish posts."
5. Open the editor's seeded post at `/admin/posts/<id>/edit`. You get "Only the author or an editor can update this post."
6. Try to create a category. You get "Only editors can manage categories."
7. Sign back in as the editor and publish the writer's draft. It works, because the editor can publish any post.

## Next steps

Next, add featured images in [Media Uploads](/tutorial/media-uploads).

To learn more:

- [Authorization overview](/authorization/)
- [Policies](/authorization/policies)
- [Abilities](/authorization/abilities)
- [Using authorization with auth](/authorization/with-auth)
- [403 vs 404](/authorization/errors)
