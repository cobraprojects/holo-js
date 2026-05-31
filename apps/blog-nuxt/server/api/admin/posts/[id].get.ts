import auth from '@holo-js/auth'
import authorization from '@holo-js/authorization'

import { getAdminPostById } from '../../../lib/blog'
import Post from '../../../models/Post'

export default defineEventHandler(async (event) => {
  await authorization.forUser(await auth.user()).authorize('viewAny', Post)

  const data = await getAdminPostById(Number(event.context.params?.id || 0))
  if (!data) {
    return null
  }

  return {
    ...data,
    imageUrl: await data.post.getFirstMediaUrl('images', 'thumb'),
  }
})
