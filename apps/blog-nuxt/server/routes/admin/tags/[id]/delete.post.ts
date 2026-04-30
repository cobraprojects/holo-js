import { deleteTag } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  await deleteTag(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/tags', 303)
})
