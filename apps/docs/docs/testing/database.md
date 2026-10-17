# Database Tests

Database tests run your real models and queries against a real test database. This page shows how to build a fresh schema before the test run, create data with factories, and keep tests from leaking data into each other.

It assumes the Vitest setup from [Testing Your App](/testing/), including `APP_ENV=test` and a separate test database in `.env.test`.

## Migrate before the test run

Use a Vitest global setup file to rebuild the test database once, before any test runs:

```ts [tests/global-setup.ts]
import { execFileSync } from 'node:child_process'

export default function setup() {
  execFileSync('npx', ['holo', 'migrate:fresh'], {
    env: { ...process.env, APP_ENV: 'test' },
    stdio: 'inherit',
  })
}
```

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      APP_ENV: 'test',
    },
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
  },
})
```

`migrate:fresh` drops every table and runs all your [migrations](/database/migrations). Passing `APP_ENV: 'test'` makes the command read `.env.test`, so it targets the test database.

::: danger
Always check that `.env.test` points at a separate database before you run `migrate:fresh`. It deletes every table on the connection it uses.
:::

To load baseline data (roles, settings, and so on), add `--seed`, or `--seed --only roles` to run specific [seeders](/database/seeding):

```ts
execFileSync('npx', ['holo', 'migrate:fresh', '--seed'], {
  env: { ...process.env, APP_ENV: 'test' },
  stdio: 'inherit',
})
```

## Factories

[Factories](/orm/factories) create valid records with sensible defaults, so each test only spells out the fields it cares about. Generate one with:

```bash
npx holo make:factory PostFactory
```

```ts [server/db/factories/PostFactory.ts]
import { defineFactory } from '@holo-js/db'
import Post from '../../models/Post'

export default defineFactory(Post, ({ sequence }) => ({
  title: `Post ${sequence}`,
  slug: `post-${sequence}`,
  status: 'published',
}))
```

Use it in a test:

```ts [tests/published-posts.test.ts]
import { expect, it } from 'vitest'
import PostFactory from '../server/db/factories/PostFactory'
import Post from '../server/models/Post'

it('lists only published posts', async () => {
  await PostFactory.createMany(3)
  await PostFactory.state({ status: 'draft' }).createOne()

  const published = await Post.where('status', 'published').get()

  expect(published).toHaveLength(3)
})
```

Common factory calls:

| Call | Result |
| --- | --- |
| `createOne()` | Save one record and return it. |
| `createOne(1, { title: 'Custom' })` | Save one record with overrides. The first argument is the sequence number. |
| `createMany(3)` | Save three records. |
| `count(3).create()` | Same as `createMany(3)`. |
| `makeOne()` / `makeMany(3)` | Build records without saving them. |
| `state({ status: 'draft' })` | Change attributes for the records this factory creates. |
| `for(UserFactory, 'user')` | Create a parent record through a relation. |
| `has(CommentFactory.count(2), 'comments')` | Create child records through a relation. |

See [Factories](/orm/factories) for sequences, relations, and hooks.

## Keep tests independent

Tests share one database, so data from one test can affect the next. Pick one of these approaches.

### Clean tables between tests

Delete rows from the tables your tests write to:

```ts [tests/setup.ts]
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { initializeHolo, type HoloRuntime } from '@holo-js/core'
import { DB } from '@holo-js/db'

let holo: HoloRuntime

beforeAll(async () => {
  holo = await initializeHolo(process.cwd())
})

beforeEach(async () => {
  await DB.table('comments').delete()
  await DB.table('posts').delete()
})

afterAll(async () => {
  await holo.shutdown()
})
```

Delete child tables before parent tables so foreign keys don't block the delete.

### Assert on your own data

Instead of counting every row in a table, create data with unique values and query for it. This works well when cleaning tables is slow:

```ts
it('finds a post by slug', async () => {
  const post = await PostFactory.createOne(1, { slug: `slug-${crypto.randomUUID()}` })

  const found = await Post.where('slug', post.slug).first()

  expect(found?.id).toBe(post.id)
})
```

## Testing with Postgres or MySQL

SQLite is the fastest option for most tests. If your app uses Postgres- or MySQL-specific features, point `.env.test` at a dedicated test database instead:

```ini [.env.test]
APP_ENV=test
DB_DRIVER=postgres
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=
DB_DATABASE=blog_test
```

Create the `blog_test` database once. `migrate:fresh` takes care of the tables on every run.

## Next steps

- [Faking Services](/testing/fakes)
- [Factories](/orm/factories)
- [Seeding](/database/seeding)
