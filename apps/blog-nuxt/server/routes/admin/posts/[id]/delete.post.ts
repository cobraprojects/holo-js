import { authorize } from '@holo-js/authorization'

import { deletePost } from '../../../../lib/blog'
import Post from '../../../../models/Post'

export default defineEventHandler(async (event) => {
  const id = Number(event.context.params?.id || 0)
  await authorize('delete', await Post.findOrFail(id))
  await deletePost(id)
  return sendRedirect(event, '/admin/posts', 303)
})
