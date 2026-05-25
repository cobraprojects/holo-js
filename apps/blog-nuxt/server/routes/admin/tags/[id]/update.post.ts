import { authorize } from '@holo-js/authorization'

import { updateTag } from '../../../../lib/blog'
import Tag from '../../../../models/Tag'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  await authorize('manage', Tag)
  await updateTag(Number(event.context.params?.id || 0), { name: body.name || '' })
  return sendRedirect(event, '/admin/tags', 303)
})
