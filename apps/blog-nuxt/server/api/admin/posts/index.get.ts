import auth from '@holo-js/auth'
import authorization from '@holo-js/authorization'

import { getAdminPostsData } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async () => {
  await authorization.forUser(await auth.user()).authorize('viewAny', Post)

  return await getAdminPostsData()
})
