import { defineListener } from '@holo-js/events'

import BlogPostSaved from '../../events/blog/post-saved'
import IndexBlogPost from '../../jobs/blog/index-post'

export default defineListener({
  listensTo: [BlogPostSaved],
  async handle(event) {
    await IndexBlogPost.dispatch({
      action: event.payload.action,
      postId: event.payload.postId,
    })
  },
})
