import auth from '@holo-js/auth'
import authorization from '@holo-js/authorization'

import { getAdminCategoryById } from '../../../lib/blog'
import Category from '../../../models/Category'

export default defineEventHandler(async (event) => {
  await authorization.forUser(await auth.user()).authorize('viewAny', Category)

  return await getAdminCategoryById(Number(event.context.params?.id || 0))
})
