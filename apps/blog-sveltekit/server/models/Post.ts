import { belongsTo, belongsToMany, defineModel, hasMany } from '@holo-js/db'
import { collection, conversion, defineMediaModel } from '@holo-js/media'

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

const Post = defineModel('posts', {
  fillable: ['title', 'slug', 'excerpt', 'body', 'status', 'published_at', 'user_id', 'category_id'],
  relations,
})

export default defineMediaModel(Post, {
  collections: [
    collection('images')
      .disk('public')
      .singleFile()
      .acceptsMimeTypes(['image/jpeg', 'image/png', 'image/webp'])
      .acceptsExtensions(['jpg', 'jpeg', 'png', 'webp'])
      .maxSize(2 * 1024 * 1024),
  ],
  conversions: [
    conversion('thumb')
      .performOnCollections('images')
      .width(960)
      .height(540)
      .fit('cover')
      .format('webp')
      .quality(82),
  ],
})
