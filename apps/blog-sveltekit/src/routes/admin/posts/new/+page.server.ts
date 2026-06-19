import { redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { broadcast } from '@holo-js/broadcast'
import { ValidationException, validate } from '@holo-js/forms'
import { DB, uniqueSlug } from '@holo-js/db'
import { csrf } from '@holo-js/security'

import { postForm } from '$lib/schemas/blog'
import { ensureAuthorId, getAdminPostsData } from '$lib/server/blog'
import { blogPostChanged } from '../../../../../server/broadcast/blog-post-changed'
import BlogPostSaved from '../../../../../server/events/blog/post-saved'
import IndexBlogPost from '../../../../../server/jobs/blog/index-post'
import Post from '../../../../../server/models/Post'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ request }) => {
  return {
    ...await getAdminPostsData(),
    csrf: {
      input: await csrf.input(request),
    },
  }
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const formData = await request.formData()
    const data = await validate(formData, postForm)
    await authorize('create', Post)
    if (data.status === 'published') {
      await authorize('publish', Post)
    }

    const post = await DB.transaction(async () => {
      const post = await Post.create({
        user_id: await ensureAuthorId(),
        category_id: data.categoryId ? Number(data.categoryId) : null,
        title: data.title.trim(),
        slug: await uniqueSlug(Post, data.title),
        excerpt: data.excerpt?.trim() || null,
        body: data.body.trim(),
        status: data.status,
        published_at: data.status === 'published' ? new Date() : null,
      })

      if (data.tagIds.length > 0) {
        await post.tags().attach(data.tagIds)
      }

      return post
    })

    if (data.image?.size) {
      const result = await post.addMedia(data.image).toMediaCollection('images')
      if (result.error) {
        throw ValidationException.withMessages({
          image: [result.error.message],
        })
      }
    }

    await broadcast(blogPostChanged('created', post.id, post.title, post.status, post.slug))
    await BlogPostSaved.dispatch({
      action: 'created',
      postId: post.id,
      title: post.title,
      status: post.status,
      slug: post.slug,
    })
    await IndexBlogPost.dispatch({
      action: 'created',
      postId: post.id,
    }).onQueue('default')

    redirect(303, '/admin/posts')
  },
} satisfies Actions
