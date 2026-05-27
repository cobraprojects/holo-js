import { error, redirect } from '@sveltejs/kit'
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
    const input = await validate(request, tagForm)
    await authorize('manage', Tag)
    await createTag({ name: input.name })

    redirect(303, '/admin/tags')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    const id = Number(formData.get('id'))
    const tag = await Tag.find(id)
    if (!tag) {
      throw error(404, 'Tag not found')
    }

    await authorize('delete', tag)
    await deleteTag(id)

    redirect(303, '/admin/tags')
  },
} satisfies Actions
