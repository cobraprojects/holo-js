import { authorize } from '@holo-js/authorization'

import { updateCategory } from '../../../../lib/blog'
import Category from '../../../../models/Category'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, description?: string }>(event)
  const id = Number(event.context.params?.id || 0)
  const category = await Category.findOrFail(id)
  await authorize('update', category)

  await updateCategory(id, { name: body.name || '', description: body.description || '' })
  return sendRedirect(event, '/admin/categories', 303)
})
