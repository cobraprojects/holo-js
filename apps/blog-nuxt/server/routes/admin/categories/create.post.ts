import { authorize } from '@holo-js/authorization'

import { createCategory } from '../../../lib/blog'
import Category from '../../../models/Category'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, description?: string }>(event)
  await authorize('manage', Category)
  await createCategory({ name: body.name || '', description: body.description || '' })
  return sendRedirect(event, '/admin/categories', 303)
})
