import { redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { broadcast } from '@holo-js/broadcast'
import { csrf } from '@holo-js/security'

import { deletePost, getAdminPostsData } from '$lib/server/blog'
import { blogPostChanged } from '../../../../server/broadcast/blog-post-changed'
import Post from '../../../../server/models/Post'
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
  delete: async ({ request }) => {
    const formData = await request.formData()
    const id = Number(formData.get('id'))
    const post = await Post.findOrFail(id)
    await authorize('delete', post)
    await deletePost(id)
    await broadcast(blogPostChanged('deleted', post.id, post.title, post.status, post.slug))

    redirect(303, '/admin/posts')
  },
} satisfies Actions
