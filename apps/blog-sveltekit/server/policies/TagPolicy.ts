import { definePolicy, deny } from '@holo-js/authorization'

import Tag from '../models/Tag'

export default definePolicy('tags', Tag, {
  before({ user, guard }) {
    return guard === 'admin' || user?.email === 'super-admin@example.com'
      ? true
      : undefined
  },
  class: {
    viewAny({ user }) {
      return Boolean(user)
    },
    manage({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors and admins can manage tags.')
    },
  },
  record: {
    update({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors and admins can update tags.')
    },
    delete({ user }) {
      return user ? deny('Only admins can delete tags.') : deny('Sign in required.')
    },
  },
})
