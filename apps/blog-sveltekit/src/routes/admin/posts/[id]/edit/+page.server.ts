import { error, fail, redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { DB, uniqueSlug } from '@holo-js/db'
import { csrf } from '@holo-js/security'

import { postForm } from '$lib/schemas/blog'
import { getAdminPostById } from '$lib/server/blog'
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
    const submission = await validate(formData, postForm)
    if (!submission.valid) {
      const failure = submission.fail()
      return fail(failure.status, failure)
    }

    const id = Number(params.id)
    const data = submission.data

    const result = await DB.transaction(async () => {
      const post = await Post.findOrFail(id)
      await authorize('update', post)
      if (data.status === 'published') {
        await authorize('publish', post)
      }

      if (data.image?.size) {
        const { error } = await post.addMedia(data.image).toMediaCollection('images')
        if (error) {
          return { data: null, error }
        }
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

      return { data: post, error: null }
    })
    if (result.error) {
      const failure = submission.fail({
        status: result.error.status,
        errors: {
          image: [result.error.message],
        },
      })
      return fail(failure.status, failure)
    }

    redirect(303, '/admin/posts')
  },
} satisfies Actions
