import { belongsTo, belongsToMany, defineModel, hasMany } from '@holo-js/db'

const relations = {
  user: belongsTo('User', { foreignKey: 'user_id' }),
  category: belongsTo('Category', { foreignKey: 'category_id' }),
  tags: belongsToMany('Tag', {
    pivotTable: 'post_tags',
    foreignPivotKey: 'post_id',
    relatedPivotKey: 'tag_id',
  }),
  comments: hasMany('Comment', { foreignKey: 'post_id' }),
}

export default defineModel('posts', {
  fillable: ['title', 'slug', 'excerpt', 'body', 'status', 'published_at', 'user_id', 'category_id'],
  relations,
})
