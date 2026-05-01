import { belongsTo, belongsToMany, defineModel } from '@holo-js/db'
import { posts } from '../db/schema.generated'

import Category from './Category'
import Tag from './Tag'

const relations = {
  category: belongsTo(() => Category, { foreignKey: 'category_id' }),
  tags: belongsToMany(() => Tag, {
    pivotTable: 'post_tags',
    foreignPivotKey: 'post_id',
    relatedPivotKey: 'tag_id',
  }),
}

export default defineModel(posts, {
  fillable: ['title', 'slug', 'excerpt', 'body', 'status', 'published_at', 'user_id', 'category_id'],
  relations,
})
