import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('blog.admin', {
  type: 'private',
  authorize(user) {
    return Boolean(user)
  },
})
