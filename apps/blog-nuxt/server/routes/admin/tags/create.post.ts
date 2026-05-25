import { authorize } from '@holo-js/authorization'

import { createTag } from '../../../lib/blog'
import Tag from '../../../models/Tag'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  await authorize('manage', Tag)
  await createTag({ name: body.name || '' })
  return sendRedirect(event, '/admin/tags', 303)
})
