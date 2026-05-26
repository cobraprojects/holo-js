import { definePolicy, deny, denyAsNotFound } from '@holo-js/authorization'

import Post from '../models/Post'

export default definePolicy('posts', Post, {
  before({ user, authenticated, guard }) {
    return (guard === 'admin' && authenticated) || user?.email === 'super-admin@example.com'
      ? true
      : undefined
  },
  class: {
    viewAny({ user }) {
      return Boolean(user)
    },
    create({ user }) {
      return Boolean(user)
    },
    publish({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors and admins can publish posts.')
    },
  },
  record: {
    view({ user }, post) {
      if (post.status === 'published') {
        return true
      }

      if (!user) {
        return denyAsNotFound()
      }

      return String(user.id) === String(post.user_id) || user.email === 'editor@example.com'
        ? true
        : denyAsNotFound()
    },
    update({ user }, post) {
      if (!user) {
        return deny('Sign in required.')
      }

      return String(user.id) === String(post.user_id) || user.email === 'editor@example.com'
        ? true
        : deny('Only the author, editors, or admins can update posts.')
    },
    publish({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors and admins can publish posts.')
    },
    delete({ user }) {
      return user ? deny('Only admins can delete posts.') : deny('Sign in required.')
    },
  },
})
