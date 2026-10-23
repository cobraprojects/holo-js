# Quick Start

In this guide you create a Holo-JS project, add a `Post` model with a database table, and return posts from an API route. It takes about ten minutes.

You need Node.js 22.18 or newer on the 22 line, or Node.js 24 or 26. The project uses SQLite, so there is no database server to set up. On Node.js 22, Nuxt projects installed with npm need npm 11; see [Installation](/getting-started/installation#requirements).

## 1. Create the project

::: code-group

```bash [npm]
npm create holo-js@latest my-app
```

```bash [pnpm]
pnpm create holo-js my-app
```

```bash [Yarn]
yarn create holo-js my-app
```

```bash [Bun]
bun create holo-js my-app
```

:::

The installer asks a few questions:

| Question | Pick for this guide |
| --- | --- |
| Framework | `next`, `nuxt`, or `sveltekit` |
| Database driver | `sqlite` |
| Package manager | the one you use |
| Optional packages | none (press Enter) |

Holo creates the `my-app` folder, writes the project files, and installs dependencies with the package manager you picked.

::: tip
The installer asks for the package manager separately, even if you ran it with `pnpm create` or `bun create`. Pick the same one so the lockfile matches.
:::

## 2. Start the dev server

```bash
cd my-app
npm run dev
```

Use `pnpm dev`, `yarn dev`, or `bun run dev` if you picked a different package manager.

Open the URL your framework prints: `http://localhost:3000` for Next.js and Nuxt, `http://localhost:5173` for SvelteKit. You see the starter page.

Leave the dev server running. Open a second terminal in `my-app` for the next steps.

## 3. Create a model and migration

```bash
npx holo make:model Post --migration --seeder
```

This creates three files:

- `server/models/Post.ts`: the model
- `server/db/migrations/<timestamp>_create_posts_table.ts`: a migration that creates the `posts` table
- `server/db/seeders/PostSeeder.ts`: a seeder for sample data

## 4. Define the table

Open the new migration and add columns for a title and body:

```ts [server/db/migrations/2026_01_01_000000_create_posts_table.ts]
import { defineMigration, type MigrationContext } from '@holo-js/db'

export default defineMigration({
  async up({ schema }: MigrationContext) {
    await schema.createTable('posts', (table) => {
      table.id()
      table.string('title')
      table.text('body')
      table.timestamps()
    })
  },
  async down({ schema }: MigrationContext) {
    await schema.dropTable('posts')
  },
})
```

Run the migration:

```bash
npx holo migrate
```

Holo creates the `posts` table in `storage/database.sqlite` and regenerates the database types, so the model now knows about `title` and `body`.

## 5. Allow mass assignment

Open the model and list the columns that `Post.create()` may fill:

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  fillable: ['title', 'body'],
})
```

`create()` throws an error if you pass a column that is not in `fillable`. This protects you from users setting fields like `is_admin` through a form.

## 6. Add sample data

Replace the seeder body with a couple of posts:

```ts [server/db/seeders/PostSeeder.ts]
import { defineSeeder } from '@holo-js/db'

import Post from '../../models/Post'

export default defineSeeder({
  name: 'PostSeeder',
  async run() {
    await Post.create({ title: 'Hello Holo', body: 'My first post.' })
    await Post.create({ title: 'Second post', body: 'Models are typed end to end.' })
  },
})
```

Run it:

```bash
npx holo seed
```

## 7. Query posts in a route

Create an API route for your framework. Import the model and query it like any other async function.

::: code-group

```ts [Next.js]
// app/api/posts/route.ts
import Post from '@/server/models/Post'

export async function GET() {
  const posts = await Post.latest().get()

  return Response.json(posts)
}
```

```ts [Nuxt]
// server/api/posts.get.ts
import Post from '../models/Post'

export default defineEventHandler(async () => {
  return await Post.latest().get()
})
```

```ts [SvelteKit]
// src/routes/api/posts/+server.ts

import Post from '../../../../server/models/Post'

export async function GET() {
  const posts = await Post.latest().get()

  return Response.json(posts)
}
```

:::

Open `/api/posts` in your browser (for example `http://localhost:3000/api/posts`). You see both posts as JSON, newest first.

Try typing `Post.where('` in your editor: `title`, `body`, and the other columns autocomplete.

## What you built

- A model in `server/models` that Holo discovers automatically.
- A migration that Holo tracks and can roll back with `npx holo migrate:rollback`.
- A seeder you can re-run on a fresh database with `npx holo migrate:fresh --seed`.
- An API route that uses your framework's normal routing and Holo's ORM.

## Next steps

- [Tutorial](/tutorial/): build a full blog with auth, admin pages, and uploads.
- [Project Structure](/getting-started/project-structure): what each folder in `my-app` is for.
- [Querying Models](/orm/querying): filters, ordering, pagination, and more.
- [Migrations](/database/migrations): all column types and table changes.
- Your framework guide: [Next.js](/getting-started/frameworks/next), [Nuxt](/getting-started/frameworks/nuxt), or [SvelteKit](/getting-started/frameworks/sveltekit).
