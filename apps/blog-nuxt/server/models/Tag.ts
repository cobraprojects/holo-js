import { belongsToMany, defineModel } from '@holo-js/db'

export default defineModel('tags', {
  fillable: ['name', 'slug'],
  relations: {
    posts: belongsToMany('Post', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'tag_id',
      relatedPivotKey: 'post_id',
    }),
  },
})
