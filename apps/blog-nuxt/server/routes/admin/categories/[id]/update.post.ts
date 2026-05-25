import { authorize } from '@holo-js/authorization'

import { updateCategory } from '../../../../lib/blog'
import Category from '../../../../models/Category'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, description?: string }>(event)
  await authorize('manage', Category)
  await updateCategory(Number(event.context.params?.id || 0), { name: body.name || '', description: body.description || '' })
  return sendRedirect(event, '/admin/categories', 303)
})
