import { defineEvent } from '@holo-js/events'

export const BlogPostSaved = defineEvent<{
  action: 'created' | 'updated' | 'deleted'
  postId: number
  title: string
  status: string
  slug: string
}>({
  name: 'blog.post.saved',
})

export default BlogPostSaved
