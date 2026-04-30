import { createTag } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  await createTag({ name: body.name || '' })
  return sendRedirect(event, '/admin/tags', 303)
})
