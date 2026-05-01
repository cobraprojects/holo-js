import { getAdminTagsData } from '../../../lib/blog'

export default defineEventHandler(async () => await getAdminTagsData())
