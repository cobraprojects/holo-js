import { authorize } from '@holo-js/authorization'

import { updateTag } from '../../../../lib/blog'
import Tag from '../../../../models/Tag'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  const id = Number(event.context.params?.id || 0)
  const tag = await Tag.findOrFail(id)
  await authorize('update', tag)

  await updateTag(id, { name: body.name || '' })
  return sendRedirect(event, '/admin/tags', 303)
})
