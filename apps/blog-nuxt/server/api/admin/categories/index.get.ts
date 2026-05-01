import { getAdminCategoriesData } from '../../../lib/blog'

export default defineEventHandler(async () => await getAdminCategoriesData())
