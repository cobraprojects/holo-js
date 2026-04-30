import '../db/schema.generated'

import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email', 'password', 'avatar', 'email_verified_at'],
  hidden: ['password'],
})
