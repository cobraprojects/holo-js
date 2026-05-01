import { updateTag } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  await updateTag(Number(event.context.params?.id || 0), { name: body.name || '' })
  return sendRedirect(event, '/admin/tags', 303)
})
