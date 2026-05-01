import { getPublishedPosts } from '../../../lib/blog'

export default defineEventHandler(async () => await getPublishedPosts())
