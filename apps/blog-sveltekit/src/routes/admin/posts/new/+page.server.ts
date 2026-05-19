import { redirect } from '@sveltejs/kit'

import { createPost, getAdminPostsData } from '$lib/server/blog'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminPostsData()
}) satisfies PageServerLoad

export const actions = {
  create: async ({ request }) => {
    const formData = await request.formData()
    await createPost({
      title: String(formData.get('title') || ''),
      excerpt: String(formData.get('excerpt') || ''),
      body: String(formData.get('body') || ''),
      status: String(formData.get('status') || ''),
      categoryId: String(formData.get('categoryId') || ''),
      tagIds: formData.getAll('tagIds').map(String).join(','),
    })

    redirect(303, '/admin/posts')
  },
} satisfies Actions
