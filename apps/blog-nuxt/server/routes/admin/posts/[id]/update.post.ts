import { updatePost } from '../../../../lib/blog'

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, string>>(event)
  await updatePost(Number(event.context.params?.id || 0), {
    title: body.title || '',
    excerpt: body.excerpt || '',
    body: body.body || '',
    status: body.status || 'published',
    categoryId: body.categoryId || '',
    tagIds: Array.isArray(body.tagIds) ? body.tagIds.join(',') : (body.tagIds || ''),
  })
  return sendRedirect(event, '/admin/posts', 303)
})
