import { authorize } from '@holo-js/authorization'

import { deleteTag } from '../../../../lib/blog'
import Tag from '../../../../models/Tag'

export default defineEventHandler(async (event) => {
  const id = Number(event.context.params?.id || 0)
  const tag = await Tag.findOrFail(id)
  await authorize('delete', tag)

  await deleteTag(id)
  return sendRedirect(event, '/admin/tags', 303)
})
