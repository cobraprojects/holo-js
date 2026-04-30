import { getAdminCategoryById } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getAdminCategoryById(Number(event.context.params?.id || 0)))
