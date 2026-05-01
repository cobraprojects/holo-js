import { defineModel } from '@holo-js/db'
import { users } from '../db/schema.generated'

export default defineModel(users, {
  fillable: ['name', 'email', 'password', 'avatar'],
  hidden: ['password'],
})
