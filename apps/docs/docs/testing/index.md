# Testing Your App

Holo apps are tested with a regular test runner such as [Vitest](https://vitest.dev). Your tests boot Holo against a test database, call your server code (models, jobs, server functions), and check the result. This page sets up Vitest; the next pages cover [database tests](/testing/database) and [faking mail, notifications, and events](/testing/fakes).

## A first test

```ts [tests/posts.test.ts]
import { afterAll, beforeAll, expect, it } from 'vitest'
import { initializeHolo, type HoloRuntime } from '@holo-js/core'
import Post from '../server/models/Post'

let holo: HoloRuntime

beforeAll(async () => {
  holo = await initializeHolo(process.cwd())
})

afterAll(async () => {
  await holo.shutdown()
})

it('creates a draft post', async () => {
  const post = await Post.create({ title: 'Hello', slug: 'hello', status: 'draft' })

  expect(post.status).toBe('draft')
})
```

`initializeHolo()` loads your config and `.env` files, connects to the database, and sets up queues, mail, cache, and the other services you've installed. After that, models, `DB`, and the rest work in your tests the same way they do in your app. `shutdown()` closes the connections so Vitest can exit.

## Set up Vitest

New projects don't include a test runner, so install Vitest first:

```bash
npm install -D vitest
```

Add a config file:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      APP_ENV: 'test',
    },
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
  },
})
```

- `APP_ENV: 'test'` makes Holo load `.env` and then `.env.test`. See [env file loading](/reference/environment#env-files-and-loading-order).
- `fileParallelism: false` runs test files one at a time, so they don't fight over the same database.

Move the boot code into the setup file so every test file gets it:

```ts [tests/setup.ts]
import { afterAll, beforeAll } from 'vitest'
import { initializeHolo, type HoloRuntime } from '@holo-js/core'

let holo: HoloRuntime

beforeAll(async () => {
  holo = await initializeHolo(process.cwd())
})

afterAll(async () => {
  await holo.shutdown()
})
```

Test files can now import models and server code directly, without their own `beforeAll`. The rest of the testing pages assume this setup file.

Add a script to `package.json`:

```json [package.json]
{
  "scripts": {
    "test": "vitest"
  }
}
```

::: tip
Holo reads the generated files in `.holo-js/generated`. They're created by `holo dev`, `holo build`, and the `prepare` script that runs on install. If you add a model or job and run tests without starting the dev server, run `npx holo prepare` first.
:::

## Test environment settings

Put test-only settings in `.env.test`. Values here override `.env`:

```ini [.env.test]
APP_ENV=test
DB_URL=./storage/test.sqlite
QUEUE_CONNECTION=sync
MAIL_MAILER=fake
CACHE_DRIVER=memory
BROADCAST_CONNECTION=null
RATE_LIMIT_DRIVER=memory
```

| Setting | Why |
| --- | --- |
| `DB_URL` | A separate SQLite file, so tests never touch your dev data. Use a different `DB_DATABASE` for Postgres or MySQL. |
| `QUEUE_CONNECTION=sync` | Jobs run immediately inside the test, so you can check their effects. |
| `MAIL_MAILER=fake` | Mail is recorded instead of sent. See [Faking Services](/testing/fakes#mail). |
| `CACHE_DRIVER=memory` | Each test run starts with an empty cache. Needs a `memory` store in `config/cache.ts` (new projects include one). |
| `BROADCAST_CONNECTION=null` | Broadcasts are dropped instead of sent to a worker. |

These variable names come from the generated config files. If you changed a config file, use the names it reads. See [Environment Variables](/reference/environment).

## What to test

Test from the outside in, the way your app uses the code:

- **Server functions and route logic.** Call the functions your routes use (for example `createPost()` in `server/lib/posts.ts`) and check the database afterwards.
- **Models.** Scopes, relations, casts, and serialization rules.
- **Jobs and listeners.** Dispatch them with the `sync` driver and check the result.
- **Authorization rules.** Check [policies and abilities](/authorization/jobs-and-tests) with an explicit user.
- **Failure paths.** Invalid input, missing records, and denied access, not just the happy path.

Build test data with [factories](/testing/database#factories) instead of writing records by hand.

### Testing authorization

Pass the user explicitly so the test doesn't depend on a request:

```ts [tests/post-policy.test.ts]
import { expect, it } from 'vitest'
import authorization from '@holo-js/authorization'
import Post from '../server/models/Post'

it('only editors can publish', async () => {
  const post = await Post.create({ title: 'Draft', slug: 'draft', status: 'draft' })
  const author = { id: 1, role: 'author' }
  const editor = { id: 2, role: 'editor' }

  expect(await authorization.forUser(author).policy('posts').can('publish', post)).toBe(false)
  expect(await authorization.forUser(editor).policy('posts').can('publish', post)).toBe(true)
})
```

## Next steps

- [Database Tests](/testing/database) — migrations, factories, and clean data between tests
- [Faking Services](/testing/fakes) — mail, notifications, events, and queues
- [Factories](/orm/factories)
