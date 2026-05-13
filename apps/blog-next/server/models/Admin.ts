import { defineModel } from '@holo-js/db'

export default defineModel('admins', {
  fillable: ['name', 'email', 'password', 'avatar'],
  hidden: ['password'],
})
