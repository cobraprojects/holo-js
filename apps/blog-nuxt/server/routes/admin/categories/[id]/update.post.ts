import { updateCategory } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, description?: string }>(event)
  await updateCategory(Number(event.context.params?.id || 0), { name: body.name || '', description: body.description || '' })
  return sendRedirect(event, '/admin/categories', 303)
})
