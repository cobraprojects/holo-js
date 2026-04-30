import { getAdminTagById } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getAdminTagById(Number(event.context.params?.id || 0)))
