# Many to Many

A many-to-many relationship connects rows on both sides through a third table, called the pivot table. A post has many tags, and a tag belongs to many posts. Each row in `post_tags` links one post to one tag.

```ts [server/models/Post.ts]
import { belongsToMany, defineModel } from '@holo-js/db'

export default defineModel('posts', {
  relations: {
    tags: belongsToMany('Tag', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'post_id',
      relatedPivotKey: 'tag_id',
    }),
  },
})
```

```ts [server/lib/posts.ts]
import Post from '../models/Post'

const post = await Post.with('tags').findOrFail(1)

post.tags.map(tag => tag.name)

await post.tags().sync([1, 2, 3])
```

`post.tags` is typed as an array of `Tag` models.

## The pivot table

A pivot table needs one column for each side. Create it in a [migration](/database/migrations):

```ts [server/db/migrations/2026_04_26_000130_create_post_tags.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('post_tags', (table) => {
      table.id()
      table.integer('post_id')
      table.integer('tag_id')
      table.boolean('is_primary').default(false)
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('post_tags')
  },
})
```

## Defining the relation

`belongsToMany` takes the related model and the pivot details:

| Option | Meaning | Default |
| --- | --- | --- |
| `pivotTable` | Name of the pivot table | required |
| `foreignPivotKey` | Pivot column pointing at *this* model | required |
| `relatedPivotKey` | Pivot column pointing at the *related* model | required |
| `parentKey` | Column on this model that `foreignPivotKey` matches | `'id'` |
| `relatedKey` | Column on the related model that `relatedPivotKey` matches | `'id'` |

You can also pass them positionally: `belongsToMany('Tag', 'post_tags', 'post_id', 'tag_id')`.

Define the inverse on the other model with the keys swapped:

```ts [server/models/Tag.ts]
import { belongsToMany, defineModel } from '@holo-js/db'

export default defineModel('tags', {
  relations: {
    posts: belongsToMany('Post', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'tag_id',
      relatedPivotKey: 'post_id',
    }),
  },
})
```

## Reading pivot columns

Every loaded related model gets a `pivot` property with the pivot row's columns. The pivot is typed from the pivot table's schema, so `is_primary` autocompletes:

```ts
const post = await Post.with('tags').findOrFail(1)

for (const tag of post.tags) {
  console.log(tag.name, tag.pivot.is_primary)
}
```

### Declaring writable pivot columns

Use `withPivot()` to list extra pivot columns you want to write through `attach()`, `sync()`, and `updateExistingPivot()`. Column names autocomplete against the pivot table:

```ts
tags: belongsToMany('Tag', {
  pivotTable: 'post_tags',
  foreignPivotKey: 'post_id',
  relatedPivotKey: 'tag_id',
}).withPivot('is_primary')
```

::: warning Undeclared pivot columns are rejected
Writing a pivot column that isn't listed in `withPivot()` throws a `SecurityError`. So does trying to set the key columns (`post_id`, `tag_id`) yourself. This stops request data from overwriting pivot rows you didn't intend to change.
:::

### Pivot timestamps

Add `withTimestamps()` to fill `created_at` and `updated_at` on the pivot automatically. `created_at` is set on insert, and `updated_at` on every insert and update:

```ts
tags: belongsToMany('Tag', {
  pivotTable: 'post_tags',
  foreignPivotKey: 'post_id',
  relatedPivotKey: 'tag_id',
}).withPivot('is_primary').withTimestamps()
```

### Renaming the pivot property

`as()` changes the property name from `pivot` to something that reads better. The type follows the new name:

```ts
members: belongsToMany('User', {
  pivotTable: 'team_members',
  foreignPivotKey: 'team_id',
  relatedPivotKey: 'user_id',
}).withPivot('role').as('membership')
```

```ts
const team = await Team.with('members').findOrFail(1)

team.members[0]?.membership.role
```

### Using a model for the pivot

`using()` turns each pivot row into an instance of a model you define, so [casts](/orm/casts) and model methods apply:

```ts [server/models/Team.ts]
import { belongsToMany, defineModel } from '@holo-js/db'
import Membership from './Membership'

export default defineModel('teams', {
  relations: {
    members: belongsToMany('User', {
      pivotTable: 'team_members',
      foreignPivotKey: 'team_id',
      relatedPivotKey: 'user_id',
    }).using(() => Membership).as('membership'),
  },
})
```

## Filtering and sorting by pivot columns

`wherePivot()` and `orderByPivot()` constrain the relation by pivot columns. Both autocomplete pivot column names:

```ts
primaryTags: belongsToMany('Tag', {
  pivotTable: 'post_tags',
  foreignPivotKey: 'post_id',
  relatedPivotKey: 'tag_id',
}).wherePivot('is_primary', true).orderByPivot('created_at', 'desc')
```

`wherePivot()` accepts an operator too: `.wherePivot('priority', '>', 2)`.

## Attaching and detaching

Call the relation as a method to change pivot rows. Pass the related models' IDs.

```ts
const post = await Post.findOrFail(1)

await post.tags().attach(5)
await post.tags().attach([5, 6, 7])
await post.tags().attach(5, { is_primary: true })

await post.tags().attach({
  5: { is_primary: true },
  6: { is_primary: false },
})
```

Attaching an ID that is already linked updates its pivot columns instead of inserting a duplicate.

`detach()` removes pivot rows and returns how many were removed. Call it with no arguments to remove them all:

```ts
await post.tags().detach(5)
await post.tags().detach([5, 6])
await post.tags().detach()
```

## Syncing

`sync()` makes the pivot match the list you pass: missing IDs are attached, extra IDs are detached, and changed pivot columns are updated. It returns what changed:

```ts
const changes = await post.tags().sync([1, 2, 3])
// { attached: [3], detached: [4], updated: [] }
```

Pass an object to set pivot columns per ID:

```ts
await post.tags().sync({
  1: { is_primary: true },
  2: { is_primary: false },
})
```

To add and update without removing anything, use `syncWithoutDetaching()` on the model:

```ts
await post.syncWithoutDetaching('tags', [7, 8])
```

## Toggling

`toggle()` detaches IDs that are attached and attaches the rest:

```ts
const { attached, detached } = await post.tags().toggle([1, 2])
```

## Updating a pivot row

`updateExistingPivot()` changes the pivot columns for one ID. It returns `1` if a row changed and `0` if it didn't exist or already had those values:

```ts
await post.tags().updateExistingPivot(1, { is_primary: false })
```

## Creating and saving through the relation

`create()` inserts a new related row and attaches it. `save()` does the same for a model you built:

```ts
import Tag from '../models/Tag'

const tag = await post.tags().create({ name: 'Databases', slug: 'databases' })

await post.tags().save(Tag.make({ name: 'SQL', slug: 'sql' }))
```

## How pivot writes behave

- Every `attach`, `detach`, `sync`, and `toggle` call runs in a [transaction](/database/transactions). If any write fails, the whole call is rolled back.
- Large ID lists are split into batches automatically, so you can sync thousands of IDs without hitting the database's parameter limit.
- Writes clear the loaded relation on the model. Call `post.load('tags')` to read the new state.

## Next steps

- [Through and Polymorphic](/orm/relationships/through-and-polymorphic)
- [Eager Loading and Aggregates](/orm/relationships/loading)
- [Migrations](/database/migrations)
