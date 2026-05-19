import { error, redirect } from '@sveltejs/kit'

import { getAdminPostById, updatePost } from '$lib/server/blog'
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
    const formData = await request.formData()
    await updatePost(Number(params.id), {
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
