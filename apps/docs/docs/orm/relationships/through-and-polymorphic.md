# Through and Polymorphic Relationships

Through relationships reach a model by passing through another one: a country's posts, via the users who live there. Polymorphic relationships let one table belong to several kinds of models: an `images` table that stores pictures for both users and posts.

```ts [server/models/Country.ts]
import { defineModel, hasManyThrough } from '@holo-js/db'
import Post from './Post'
import User from './User'

export default defineModel('countries', {
  relations: {
    posts: hasManyThrough(() => Post, () => User, 'country_id', 'user_id'),
  },
})
```

```ts [server/lib/countries.ts]
import Country from '../models/Country'

const country = await Country.with('posts').findOrFail(1)

country.posts.map(post => post.title)
```

Through and polymorphic relations take the related model as a function (`() => Post`), not a string name.

## Has many through

`hasManyThrough(related, through, firstKey, secondKey, localKey = 'id', secondLocalKey = 'id')` connects three tables:

```
countries        users              posts
  id      <──    country_id
                 id          <──    user_id
```

| Argument | Column | In the example |
| --- | --- | --- |
| `firstKey` | Foreign key on the *through* table pointing at this model | `users.country_id` |
| `secondKey` | Foreign key on the *related* table pointing at the through model | `posts.user_id` |
| `localKey` | Key on this model that `firstKey` matches | `countries.id` |
| `secondLocalKey` | Key on the through model that `secondKey` matches | `users.id` |

## Has one through

`hasOneThrough` takes the same arguments and loads a single model or `null`. A mechanic has one car, and the car has one owner:

```ts [server/models/Mechanic.ts]
import { defineModel, hasOneThrough } from '@holo-js/db'
import Car from './Car'
import Owner from './Owner'

export default defineModel('mechanics', {
  relations: {
    carOwner: hasOneThrough(() => Owner, () => Car, 'mechanic_id', 'car_id'),
  },
})
```

```ts
const mechanic = await Mechanic.with('carOwner').findOrFail(1)

mechanic.carOwner?.name
```

Through relations are read-only. They support loading, filtering, and aggregates, but `create()` and `save()` throw because Holo can't know how to fill the intermediate row.

## Polymorphic relationships

A polymorphic table stores two columns instead of one foreign key: a *type* column naming the parent model, and an *id* column holding the parent's key. For a relation named `imageable`, those default to `imageable_type` and `imageable_id`.

```ts [server/db/migrations/2026_05_01_000100_create_images.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('images', (table) => {
      table.id()
      table.string('url')
      table.string('imageable_type')
      table.integer('imageable_id')
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('images')
  },
})
```

### One to one and one to many

The child uses `morphTo(name)`. Each parent uses `morphOne` or `morphMany` with the same name:

```ts [server/models/Image.ts]
import { defineModel, morphTo } from '@holo-js/db'

export default defineModel('images', {
  relations: {
    imageable: morphTo('imageable'),
  },
})
```

```ts [server/models/User.ts]
import { defineModel, morphOne } from '@holo-js/db'
import Image from './Image'

export default defineModel('users', {
  relations: {
    avatar: morphOne(() => Image, 'imageable'),
  },
})
```

```ts [server/models/Post.ts]
import { defineModel, morphMany } from '@holo-js/db'
import Image from './Image'

export default defineModel('posts', {
  relations: {
    images: morphMany(() => Image, 'imageable'),
  },
})
```

```ts
const user = await User.with('avatar').findOrFail(1)
user.avatar?.url

const post = await Post.with('images').findOrFail(1)
post.images.map(image => image.url)

const image = await Image.with('imageable').findOrFail(10)
image.imageable
```

`user.avatar` is typed as `Image | null` and `post.images` as `Image[]`. `image.imageable` can be a `User` or a `Post`, so it loads as a generic model.

If your columns have different names, pass them after the name:

```ts
imageable: morphTo('imageable', 'owner_type', 'owner_id')

images: morphMany(() => Image, 'imageable', 'owner_type', 'owner_id')
```

The full signatures are `morphTo(name, type?, id?)` and `morphOne` / `morphMany(related, name, type?, id?, localKey = 'id')`.

Creating through `morphOne` and `morphMany` fills both columns for you:

```ts
await post.images().create({ url: '/uploads/cover.png' })
```

### The stored type value

The type column stores the parent's *morph class*, which defaults to the model name (`'User'`, `'Post'`). Set `morphClass` to store a different value, for example to keep existing data or decouple the database from model names:

```ts [server/models/Post.ts]
import { defineModel, morphMany } from '@holo-js/db'
import Image from './Image'

export default defineModel('posts', {
  morphClass: 'posts',
  relations: {
    images: morphMany(() => Image, 'imageable'),
  },
})
```

Holo registers every model's morph class when the model is defined, which is how `morphTo` finds the right model for each row.

::: warning Changing `morphClass` on existing data
Rows already in the table keep the old type value. If you change `morphClass`, update the type column in a migration, or those rows will stop resolving.
:::

### Latest and oldest of a morph many

`latestMorphOne` and `oldestMorphOne` pick a single row out of a `morphMany`, and `morphOfMany` picks by the `'max'` or `'min'` of any column:

```ts [server/models/Post.ts]
import { defineModel, latestMorphOne, morphOfMany, oldestMorphOne } from '@holo-js/db'
import Image from './Image'

export default defineModel('posts', {
  relations: {
    latestImage: latestMorphOne(() => Image, 'imageable'),
    firstImage: oldestMorphOne(() => Image, 'imageable'),
    largestImage: morphOfMany(() => Image, 'imageable', 'size', 'max'),
  },
})
```

`latestMorphOne` and `oldestMorphOne` order by `id` unless you pass a column as the third argument.

### Many to many

A polymorphic many-to-many lets tags attach to posts *and* videos through one `taggables` pivot table with `tag_id`, `taggable_type`, and `taggable_id` columns.

Use `morphToMany` on each model that can be tagged, and `morphedByMany` on the tag for each taggable type:

```ts [server/models/Post.ts]
import { defineModel, morphToMany } from '@holo-js/db'
import Tag from './Tag'

export default defineModel('posts', {
  relations: {
    tags: morphToMany(() => Tag, 'taggable', 'taggables', 'tag_id'),
  },
})
```

```ts [server/models/Tag.ts]
import { defineModel, morphedByMany } from '@holo-js/db'
import Post from './Post'
import Video from './Video'

export default defineModel('tags', {
  relations: {
    posts: morphedByMany(() => Post, 'taggable', 'taggables', 'tag_id'),
    videos: morphedByMany(() => Video, 'taggable', 'taggables', 'tag_id'),
  },
})
```

In both, the fourth argument is the pivot column holding the tag's key. The full signature is `(related, name, pivotTable, foreignPivotKey, parentKey = 'id', relatedKey = 'id', type?, id?)`.

These relations work like [`belongsToMany`](/orm/relationships/many-to-many): `withPivot()`, `withTimestamps()`, `wherePivot()`, `as()`, `using()`, and `attach` / `detach` / `sync` / `toggle` are all available. Pivot writes fill the type column automatically and only touch rows for the current model type.

```ts
await post.tags().sync([1, 2])
```

## Querying polymorphic relations

`whereMorphedTo()` finds rows whose `morphTo` points at a given model, a model class, or a morph type string. Pass `null` to find rows with no parent:

```ts
const user = await User.findOrFail(1)

const userImages = await Image.whereMorphedTo('imageable', user).get()
const postImages = await Image.whereMorphedTo('imageable', Post).get()
const orphans = await Image.whereMorphedTo('imageable', null).get()
```

`whereNotMorphedTo()` is the opposite. Both have `or` variants.

`whereMorphRelation()` adds a condition on the parent, limited to the types you list. Pass one type or an array of model classes and morph type strings:

```ts
const images = await Image.query()
  .whereMorphRelation('imageable', User, 'name', 'Mohamed')
  .get()

const featured = await Image.query()
  .whereMorphRelation('imageable', ['Post', Video], 'is_featured', true)
  .get()
```

`has()`, `whereHas()`, and `withCount()` also work on all polymorphic relations. Column aggregates such as `withSum()` are not supported on `morphTo`, because the target table varies.

To load different nested relations for each parent type, use [`loadMorph()`](/orm/relationships/loading#polymorphic-loading).

## Next steps

- [Eager Loading and Aggregates](/orm/relationships/loading)
- [Many to Many](/orm/relationships/many-to-many)
- [Migrations](/database/migrations)
