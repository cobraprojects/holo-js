import { fail, redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'
import { DB, uniqueSlug } from '@holo-js/db'
import { csrf } from '@holo-js/security'

import { postForm } from '$lib/schemas/blog'
import { ensureAuthorId, getAdminPostsData } from '$lib/server/blog'
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
    const submission = await validate(formData, postForm)
    if (!submission.valid) {
      const failure = submission.fail()
      return fail(failure.status, failure)
    }

    const data = submission.data
    await authorize('create', Post)
    if (data.status === 'published') {
      await authorize('publish', Post)
    }

    const result = await DB.transaction(async () => {
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

      if (data.image?.size) {
        const { error } = await post.addMedia(data.image).toMediaCollection('images')
        if (error) {
          return { data: null, error }
        }
      }

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
