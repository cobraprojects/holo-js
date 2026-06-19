import { defineJob } from '@holo-js/queue'

import Post from '../../models/Post'

export const IndexBlogPost = defineJob<{
  action: 'created' | 'updated' | 'deleted'
  postId: number
}>({
  queue: 'default',
  async handle(payload) {
    const post = await Post.find(payload.postId)

    return {
      action: payload.action,
      postId: payload.postId,
      indexed: post !== undefined,
      title: post?.title ?? null,
    }
  },
})

export default IndexBlogPost
