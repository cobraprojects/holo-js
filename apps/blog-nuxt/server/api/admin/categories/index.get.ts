import auth from '@holo-js/auth'
import authorization from '@holo-js/authorization'

import { getAdminCategoriesData } from '../../../lib/blog'
import Category from '../../../models/Category'

export default defineEventHandler(async () => {
  await authorization.forUser(await auth.user()).authorize('viewAny', Category)

  return await getAdminCategoriesData()
})
