import { redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'

import { deletePost, getAdminPostsData } from '$lib/server/blog'
import Post from '../../../../server/models/Post'
import type { Actions, PageServerLoad } from './$types'

export const load = (async () => {
  return await getAdminPostsData()
}) satisfies PageServerLoad

export const actions = {
  delete: async ({ request }) => {
    const formData = await request.formData()
    const id = Number(formData.get('id'))
    await authorize('delete', await Post.findOrFail(id))
    await deletePost(id)

    redirect(303, '/admin/posts')
  },
} satisfies Actions
