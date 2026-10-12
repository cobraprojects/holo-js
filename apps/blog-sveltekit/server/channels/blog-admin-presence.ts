import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('blog.admin.presence', {
  type: 'presence',
  authorize(user: { id: string | number, email: string } | null) {
    return user ? { id: String(user.id), email: user.email } : false
  },
})
