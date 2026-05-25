import { definePolicy, deny } from '@holo-js/authorization'

import Category from '../models/Category'

export default definePolicy('categories', Category, {
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
        : deny('Only editors and admins can manage categories.')
    },
  },
  record: {
    update({ user }) {
      return user?.email === 'editor@example.com'
        ? true
        : deny('Only editors and admins can update categories.')
    },
    delete({ user }) {
      return user ? deny('Only admins can delete categories.') : deny('Sign in required.')
    },
  },
})
