import { getPublishedPostBySlug } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getPublishedPostBySlug(String(getRouterParam(event, 'slug')|| '')))
