import { authorize } from '@holo-js/authorization'

import { createPost } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, string>>(event)
  const status = body.status === 'draft' ? 'draft' : 'published'
  await authorize('create', Post)
  if (status === 'published') {
    await authorize('publish', Post)
  }

  await createPost({
    title: body.title || '',
    excerpt: body.excerpt || '',
    body: body.body || '',
    status,
    categoryId: body.categoryId || '',
    tagIds: Array.isArray(body.tagIds) ? body.tagIds.join(',') : (body.tagIds || ''),
  })
  return sendRedirect(event, '/admin/posts', 303)
})
