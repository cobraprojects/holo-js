import { defineModel, hasMany } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email', 'password', 'avatar', 'email_verified_at'],
  hidden: ['password'],
  relations: {
    posts: hasMany('Post', { foreignKey: 'user_id' }),
    comments: hasMany('Comment', { foreignKey: 'user_id' }),
  },
})
