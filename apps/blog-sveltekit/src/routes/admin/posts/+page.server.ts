import { redirect } from '@sveltejs/kit'

import { deletePost, getAdminPostsData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminPostsData()
}) satisfies PageServerLoad

export const actions = {
  delete: async ({ request }) => {
    const formData = await request.formData()
    await deletePost(Number(formData.get('id')))

    redirect(303, '/admin/posts')
  },
} satisfies Actions
