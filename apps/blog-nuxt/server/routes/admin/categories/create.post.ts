import { createCategory } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, description?: string }>(event)
  await createCategory({ name: body.name || '', description: body.description || '' })
  return sendRedirect(event, '/admin/categories', 303)
})
