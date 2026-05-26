import { authorize } from '@holo-js/authorization'

import { updatePost } from '../../../../lib/blog'
import Post from '../../../../models/Post'

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, string>>(event)
  const id = Number(event.context.params?.id || 0)
  const status = body.status === 'draft' ? 'draft' : 'published'
  const post = await Post.findOrFail(id)
  await authorize('update', post)
  if (status === 'published') {
    await authorize('publish', post)
  }

  await updatePost(id, {
    title: body.title || '',
    excerpt: body.excerpt || '',
    body: body.body || '',
    status,
    categoryId: body.categoryId || '',
    tagIds: Array.isArray(body.tagIds) ? body.tagIds.join(',') : (body.tagIds || ''),
  })
  return sendRedirect(event, '/admin/posts', 303)
})
