import auth from '@holo-js/auth'
import authorization from '@holo-js/authorization'

import { getAdminTagsData } from '../../../lib/blog'
import Tag from '../../../models/Tag'

export default defineEventHandler(async () => {
  await authorization.forUser(await auth.user()).authorize('viewAny', Tag)

  return await getAdminTagsData()
})
