import { error, redirect } from '@sveltejs/kit'

import { getAdminTagById, updateTag } from '$lib/server/blog'
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
    const formData = await request.formData()
    await updateTag(Number(params.id), { name: String(formData.get('name') || '') })

    redirect(303, '/admin/tags')
  },
} satisfies Actions
