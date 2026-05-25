import { authorize } from '@holo-js/authorization'

import { deleteTag } from '../../../../lib/blog'
import Tag from '../../../../models/Tag'

export default defineEventHandler(async (event) => {
  await authorize('manage', Tag)
  await deleteTag(Number(event.context.params?.id || 0))
  return sendRedirect(event, '/admin/tags', 303)
})
