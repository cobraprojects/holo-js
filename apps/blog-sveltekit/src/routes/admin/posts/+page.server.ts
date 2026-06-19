import { redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import { broadcast } from '@holo-js/broadcast'
import { csrf } from '@holo-js/security'

import { deletePost, getAdminPostsData } from '$lib/server/blog'
import { blogPostChanged } from '../../../../server/broadcast/blog-post-changed'
import BlogPostSaved from '../../../../server/events/blog/post-saved'
import IndexBlogPost from '../../../../server/jobs/blog/index-post'
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
    await BlogPostSaved.dispatch({
      action: 'deleted',
      postId: post.id,
      title: post.title,
      status: post.status,
      slug: post.slug,
    })
    await IndexBlogPost.dispatch({
      action: 'deleted',
      postId: post.id,
    }).onQueue('default')

    redirect(303, '/admin/posts')
  },
} satisfies Actions
