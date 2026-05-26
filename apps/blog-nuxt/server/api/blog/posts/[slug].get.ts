import { getPublishedPostBySlug } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const post = await getPublishedPostBySlug(String(getRouterParam(event, 'slug') || ''))
  if (!post) {
    return null
  }

  return {
    ...post.toJSON(),
    imageUrl: await post.getFirstMediaUrl('images', 'thumb'),
  }
})
