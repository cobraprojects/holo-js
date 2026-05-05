import { belongsTo, defineModel } from '@holo-js/db'

const relations = {
  post: belongsTo('Post', { foreignKey: 'post_id' }),
  user: belongsTo('User', { foreignKey: 'user_id' }),
}

export default defineModel('comments', {
  fillable: ['post_id', 'user_id', 'body', 'status'],
  relations,
})
