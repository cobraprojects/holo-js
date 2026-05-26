import { authorize } from '@holo-js/authorization'

import { deleteCategory } from '../../../../lib/blog'
import Category from '../../../../models/Category'

export default defineEventHandler(async (event) => {
  const id = Number(event.context.params?.id || 0)
  const category = await Category.findOrFail(id)
  await authorize('delete', category)

  await deleteCategory(id)
  return sendRedirect(event, '/admin/categories', 303)
})
