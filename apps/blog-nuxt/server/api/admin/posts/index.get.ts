import { getAdminPostsData } from '../../../lib/blog'

export default defineEventHandler(async () => await getAdminPostsData())
