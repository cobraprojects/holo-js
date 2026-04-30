import { getTagArchive } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getTagArchive(String(event.context.params?.slug || '')))
