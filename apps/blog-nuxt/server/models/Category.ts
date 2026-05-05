import { defineModel, hasMany } from '@holo-js/db'

export default defineModel('categories', {
  fillable: ['name', 'slug', 'description'],
  relations: {
    posts: hasMany('Post', { foreignKey: 'category_id' }),
  },
})
