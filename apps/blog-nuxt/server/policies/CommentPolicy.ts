import { definePolicy, deny } from '@holo-js/authorization'

import Comment from '../models/Comment'

export default definePolicy('comments', Comment, {
  before({ user, authenticated, guard }) {
    return (guard === 'admin' && authenticated) || user?.email === 'super-admin@example.com'
      ? true
      : undefined
  },
  class: {
    viewAny({ user }) {
      return Boolean(user)
    },
    moderate({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors and admins can moderate comments.')
    },
  },
  record: {
    moderate({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors and admins can moderate comments.')
    },
  },
})
