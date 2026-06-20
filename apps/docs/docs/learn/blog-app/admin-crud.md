# Admin CRUD

This chapter builds the admin area for creating and managing posts, categories, and tags.

## What you will build

- `/admin`
- `/admin/posts`
- `/admin/categories`
- `/admin/tags`
- server actions for create, update, and delete

## Files you will create

```txt
app/admin/layout.tsx
app/admin/page.tsx
app/admin/posts/page.tsx
app/admin/categories/page.tsx
app/admin/tags/page.tsx
app/admin/actions.ts
```

The finished example uses:

- `apps/blog-next/app/admin/page.tsx`
- `apps/blog-next/app/admin/posts/page.tsx`
- `apps/blog-next/app/admin/categories/page.tsx`
- `apps/blog-next/app/admin/tags/page.tsx`
- `apps/blog-next/app/admin/actions.ts`

## Admin dashboard data

```ts
export async function getAdminDashboardData() {
  const [postCount, publishedCount, categoryCount, tagCount] = await Promise.all([
    Post.count(),
    Post.where('status', 'published').count(),
    Category.count(),
    Tag.count(),
  ])

  return {
    postCount,
    publishedCount,
    categoryCount,
    tagCount,
  }
}
```

## Server action flow

Every admin write should:

1. read the current auth state
2. redirect guests to login
3. authorize the action
4. validate input
5. call the server-domain function
6. redirect back to the admin screen

```ts
'use server'

import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { postForm } from '@/lib/schemas/blog'
import { createPost } from '@/server/lib/blog'
import Post from '@/server/models/Post'

export async function createPostAction(formData: FormData) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }

  await authorize('create', Post)
  const data = await validate(formData, postForm)

  await createPost({
    ...data,
    authorId: currentAuth.user.id,
    tagIds: data.tagIds.join(','),
  })

  redirect('/admin/posts')
}
```

## Checkpoint

The admin area can create, update, and delete blog content. The next chapter adds strict form validation and upload validation.

## Related reference

- [Forms Overview](/forms/)
- [Authorization Policies](/authorization/policies)
- [Routing](/routing)
