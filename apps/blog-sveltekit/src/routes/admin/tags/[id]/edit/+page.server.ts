import { error, fail, redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'

import { tagForm } from '$lib/schemas/blog'
import { getAdminTagById, updateTag } from '$lib/server/blog'
import Tag from '../../../../../../server/models/Tag'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const tag = await getAdminTagById(Number(params.id))
  if (!tag) {
    throw error(404, 'Tag not found')
  }

  return { tag }
}) satisfies PageServerLoad

export const actions = {
  update: async ({ params, request }) => {
    const submission = await validate(request, tagForm)
    if (!submission.valid) {
      const failure = submission.fail(400)
      return fail(failure.status, failure)
    }

    await authorize('manage', Tag)
    await updateTag(Number(params.id), { name: submission.data.name })

    redirect(303, '/admin/tags')
  },
} satisfies Actions
