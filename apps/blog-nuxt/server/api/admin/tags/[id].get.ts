import auth from '@holo-js/auth'
import authorization from '@holo-js/authorization'

import { getAdminTagById } from '../../../lib/blog'
import Tag from '../../../models/Tag'

export default defineEventHandler(async (event) => {
  await authorization.forUser(await auth.user()).authorize('viewAny', Tag)

  return await getAdminTagById(Number(event.context.params?.id || 0))
})
