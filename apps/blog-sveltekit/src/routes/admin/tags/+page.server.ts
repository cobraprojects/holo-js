import { fail, redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { validate } from '@holo-js/forms'

import { tagForm } from '$lib/schemas/blog'
import { createTag, deleteTag, getAdminTagsData } from '$lib/server/blog'
import Tag from '../../../../server/models/Tag'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminTagsData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const submission = await validate(request, tagForm)
    if (!submission.valid) {
      const failure = submission.fail(400)
      return fail(failure.status, failure)
    }

    await authorize('manage', Tag)
    await createTag({ name: submission.data.name })

    redirect(303, '/admin/tags')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    await authorize('manage', Tag)
    await deleteTag(Number(formData.get('id')))

    redirect(303, '/admin/tags')
  },
} satisfies Actions
