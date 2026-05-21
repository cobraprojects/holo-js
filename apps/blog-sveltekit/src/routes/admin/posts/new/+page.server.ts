import { fail, redirect } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'
import { uniqueSlug } from '@holo-js/db'

import { postForm } from '$lib/schemas/blog'
import { ensureAuthorId, getAdminPostsData } from '$lib/server/blog'
import Post from '../../../../../server/models/Post'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminPostsData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const submission = await validate(request, postForm)
    if (!submission.valid) {
      const failure = submission.fail(400)
      return fail(failure.status, failure)
    }

    const data = submission.data
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

    redirect(303, '/admin/posts')
  },
} satisfies Actions
