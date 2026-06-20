# Database and Migrations

This chapter creates the blog schema: categories, tags, posts, and the post/tag pivot table.

## What you will build

- category records for archives
- tag records for filtering
- post records with draft and published states
- a many-to-many table between posts and tags

## Files you will create

```txt
server/db/migrations/create_categories.ts
server/db/migrations/create_tags.ts
server/db/migrations/create_posts.ts
server/db/migrations/create_post_tags.ts
```

The finished example uses these files:

- `apps/blog-next/server/db/migrations/2026_04_26_000100_create_categories.ts`
- `apps/blog-next/server/db/migrations/2026_04_26_000110_create_tags.ts`
- `apps/blog-next/server/db/migrations/2026_04_26_000120_create_posts.ts`
- `apps/blog-next/server/db/migrations/2026_04_26_000130_create_post_tags.ts`

## Categories

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('categories', (table) => {
      table.id()
      table.string('name')
      table.string('slug').unique()
      table.text('description').nullable()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('categories')
  },
})
```

## Tags

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('tags', (table) => {
      table.id()
      table.string('name')
      table.string('slug').unique()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('tags')
  },
})
```

## Posts

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('posts', (table) => {
      table.id()
      table.integer('user_id')
      table.integer('category_id').nullable()
      table.string('title')
      table.string('slug').unique()
      table.string('status').default('draft')
      table.text('excerpt').nullable()
      table.text('body')
      table.timestamp('published_at').nullable()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('posts')
  },
})
```

## Post tags

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('post_tags', (table) => {
      table.integer('post_id')
      table.integer('tag_id')
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('post_tags')
  },
})
```

## Run migrations

```bash
bun run migrate
```

## Checkpoint

The database now has `categories`, `tags`, `posts`, and `post_tags`. The next chapter maps those tables to Holo models.

## Related reference

- [Database Migrations](/database/migrations)
- [Database Commands](/database/commands)
- [Transactions](/database/transactions)
