import { error, redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { broadcast } from '@holo-js/broadcast'
import { ValidationException, validate } from '@holo-js/forms'
import { DB, uniqueSlug } from '@holo-js/db'
import { csrf } from '@holo-js/security'

import { postForm } from '$lib/schemas/blog'
import { getAdminPostById } from '$lib/server/blog'
import { blogPostChanged } from '../../../../../../server/broadcast/blog-post-changed'
import BlogPostSaved from '../../../../../../server/events/blog/post-saved'
import Post from '../../../../../../server/models/Post'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ params, request }) => {
  const data = await getAdminPostById(Number(params.id))
  if (!data) {
    throw error(404, 'Post not found')
  }

  return {
    ...data,
    csrf: {
      input: await csrf.input(request),
    },
    imageUrl: await data.post.getFirstMediaUrl('images', 'thumb'),
  }
}) satisfies PageServerLoad

export const actions = {
  update: async ({ params, request }) => {
    const formData = await request.formData()
    const data = await validate(formData, postForm)
    const id = Number(params.id)

    const post = await DB.transaction(async () => {
      const post = await Post.findOrFail(id)
      await authorize('update', post)
      if (data.status === 'published') {
        await authorize('publish', post)
      }

      await post.update({
        category_id: data.categoryId ? Number(data.categoryId) : null,
        title: data.title.trim(),
        slug: await uniqueSlug(Post, data.title, { ignore: id }),
        excerpt: data.excerpt?.trim() || null,
        body: data.body.trim(),
        status: data.status,
        published_at: data.status === 'published' ? post.published_at ?? new Date() : null,
      })

      await post.tags().sync(data.tagIds)
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

    await broadcast(blogPostChanged('updated', post.id, post.title, post.status, post.slug))
    await BlogPostSaved.dispatch({
      action: 'updated',
      postId: post.id,
      title: post.title,
      status: post.status,
      slug: post.slug,
    })

    redirect(303, '/admin/posts')
  },
} satisfies Actions
