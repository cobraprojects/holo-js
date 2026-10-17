# 2. Database and Migrations

In this chapter you create the blog's tables. A migration is a file that describes a change to the database, such as "create the posts table". Holo runs them in order and remembers which ones already ran.

## What you'll build

Four tables:

- `categories` — one category per post, such as "Engineering"
- `tags` — many tags per post, such as "release"
- `posts` — the posts, with a draft or published status
- `post_tags` — links posts to tags (a many-to-many table)

The `users` table already exists. The project creator added it, with the other auth tables, when you selected `auth`.

## Step 1: Generate the models and migrations

`make:model` creates a model file. The `--migration` flag also creates a matching migration:

```bash
npx holo make:model Category --migration
npx holo make:model Tag --migration
npx holo make:model Post --migration
```

The post–tag link table has no model of its own, so create just a migration for it:

```bash
npx holo make:migration create_post_tags --create post_tags
```

Run these in this order. Migrations run in the order they were created, and `posts` should exist before `post_tags`.

You now have three new models in `server/models/` and four new files in `server/db/migrations/`. Each migration file name starts with a timestamp, for example `2026_04_26_000100_create_categories_table.ts`. You'll fill in the models in the next chapter.

## Step 2: Describe the categories table

Open the `create_categories_table` migration and replace its contents:

```ts [server/db/migrations/..._create_categories_table.ts]
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

`up()` runs when you migrate. `down()` undoes it when you roll back.

- `table.id()` adds an auto-incrementing `id` primary key.
- `slug` is the URL-friendly name, such as `engineering`. It's unique so two categories can't share a URL.
- `table.timestamps()` adds `created_at` and `updated_at`.

## Step 3: Describe the tags table

```ts [server/db/migrations/..._create_tags_table.ts]
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

## Step 4: Describe the posts table

```ts [server/db/migrations/..._create_posts_table.ts]
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

A few things to notice:

- `user_id` stores the author. It points at the `users` table.
- `category_id` is `nullable()` so a post can be uncategorized.
- `status` defaults to `'draft'`. Only `'published'` posts show on the public site.
- `published_at` stays empty until the post is published.

## Step 5: Describe the post tags table

```ts [server/db/migrations/..._create_post_tags.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('post_tags', (table) => {
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

Each row links one post to one tag. `is_primary` marks the post's main topic. You'll read it on the post page in [chapter 4](/tutorial/public-pages).

## Step 6: Run the migrations

```bash
npx holo migrate
```

Holo runs every migration that hasn't run yet. That includes the auth and notifications tables the creator added, plus your four new tables.

After a successful run, Holo also refreshes the generated type information for your tables. That's what gives your models typed columns in the next chapter.

## Step 7: Check it works

Run the command again:

```bash
npx holo migrate
```

This time it prints `No migrations were executed.` Every migration has already run, so there's nothing to do.

::: tip Made a mistake in a migration?
Undo the last batch, fix the file, and migrate again:

```bash
npx holo migrate:rollback
npx holo migrate
```

During development you can also rebuild the whole database from scratch with `npx holo migrate:fresh`. It drops every table, so only use it on local data.
:::

## Next steps

Next, connect these tables to code in [Models and Queries](/tutorial/models-and-queries).

To learn more:

- [Migrations](/database/migrations)
- [Database overview](/database/)
- [CLI Commands](/reference/cli)
