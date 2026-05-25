import { authorize } from '@holo-js/authorization'

import { deleteCategory } from '../../../../lib/blog'
import Category from '../../../../models/Category'

export default defineEventHandler(async (event) => {
  await authorize('manage', Category)
  await deleteCategory(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/categories', 303)
})
