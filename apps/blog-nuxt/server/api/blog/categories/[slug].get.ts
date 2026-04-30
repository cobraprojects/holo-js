import { getCategoryArchive } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getCategoryArchive(String(event.context.params?.slug || '')))
