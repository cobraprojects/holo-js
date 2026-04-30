import { deletePost } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  await deletePost(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/posts', 303)
})
