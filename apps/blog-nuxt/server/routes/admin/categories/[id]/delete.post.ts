import { deleteCategory } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  await deleteCategory(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/categories', 303)
})
