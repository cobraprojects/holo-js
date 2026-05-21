import { error, fail, redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'
import { DB, uniqueSlug } from '@holo-js/db'

import { postForm } from '$lib/schemas/blog'
import { getAdminPostById } from '$lib/server/blog'
import Post from '../../../../../../server/models/Post'
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
    const submission = await validate(request, postForm)
    if (!submission.valid) {
      const failure = submission.fail(400)
      return fail(failure.status, failure)
    }

    const id = Number(params.id)
    const data = submission.data

    await DB.transaction(async () => {
      const post = await Post.findOrFail(id)

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
    })

    redirect(303, '/admin/posts')
  },
} satisfies Actions
