# Media Uploads

This chapter adds featured image uploads to posts.

## What you will build

- a media-enabled post model
- an `images` media collection
- image MIME and extension restrictions
- a thumbnail conversion
- upload handling in create and update flows

## Files you will update

```txt
server/models/Post.ts
server/lib/blog.ts
lib/schemas/blog.ts
app/storage/[[...path]]/route.ts
config/storage.ts
```

The finished example uses:

- `apps/blog-next/server/models/Post.ts`
- `apps/blog-next/server/lib/blog.ts`
- `apps/blog-next/app/storage/[[...path]]/route.ts`
- `apps/blog-next/config/storage.ts`

## Media-enabled post model

`Post` is the base ORM model for the `posts` table. Create it first, then pass it to `defineMediaModel()` so the model keeps its normal query and relationship behavior while gaining media collections.

```ts
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
```

## Store uploaded image

```ts
if (input.image) {
  const result = await post.addMedia(input.image).toMediaCollection('images')
  if (result.error) {
    throw ValidationException.withMessages({
      image: [result.error.message],
    })
  }
}
```

## Checkpoint

Posts can now store one featured image and generate a thumbnail conversion.

## Related reference

- [Media](/media)
- [File Storage](/storage)
- [Forms Server Validation](/forms/server-validation)
