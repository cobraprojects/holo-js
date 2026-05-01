import { getAdminPostById } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getAdminPostById(Number(event.context.params?.id || 0)))
