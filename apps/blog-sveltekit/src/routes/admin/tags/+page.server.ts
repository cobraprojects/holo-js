import { redirect } from '@sveltejs/kit'

import { createTag, deleteTag, getAdminTagsData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminTagsData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const formData = await request.formData()
    await createTag({ name: String(formData.get('name') || '') })

    redirect(303, '/admin/tags')
  },
  delete: async ({ request }) => {
    const formData = await request.formData()
    await deleteTag(Number(formData.get('id')))

    redirect(303, '/admin/tags')
  },
} satisfies Actions
