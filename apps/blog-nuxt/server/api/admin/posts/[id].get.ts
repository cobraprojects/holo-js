import { getAdminPostById } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const data = await getAdminPostById(Number(event.context.params?.id || 0))
  if (!data) {
    return null
  }

  return {
    ...data,
    imageUrl: await data.post.getFirstMediaUrl('images', 'thumb'),
  }
})
