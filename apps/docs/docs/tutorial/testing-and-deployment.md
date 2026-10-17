# 11. Testing and Deployment

In this last chapter you write an automated test for the main post workflow, then build the blog for production and learn what it needs to run.

## What you'll build

- a separate test database
- a test that creates, reads, updates, and deletes a post through `blog.ts`
- a production build, started with `holo start`
- a list of the settings and processes production needs

## Step 1: Install Vitest

```bash
npm install -D vitest
```

## Step 2: Give tests their own database

Create a `.env.test` file. Holo loads it on top of `.env` whenever the app runs in the `test` environment, and Vitest sets that environment for you.

```ini [.env.test]
APP_ENV=test
DB_URL=./storage/test.sqlite
BROADCAST_CONNECTION=null
```

- **`DB_URL`** points tests at their own SQLite file, so they never touch your development data.
- **`BROADCAST_CONNECTION=null`** uses the `null` broadcast connection from `config/broadcast.ts`. Tests don't need the broadcast server running.

Add a `test` script to `package.json` that rebuilds the test database and then runs Vitest:

```json [package.json]
{
  "scripts": {
    "test": "APP_ENV=test holo migrate:fresh && vitest run"
  }
}
```

Keep your other scripts as they are; just add the `test` line. `APP_ENV=test` makes `holo migrate:fresh` use `.env.test`, so it rebuilds `storage/test.sqlite` and never your development database.

## Step 3: Write the test

The test starts Holo for the project, then calls the same functions your pages use.

::: code-group

```ts [Next.js]
// tests/blog-crud.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '@holo-js/auth'
import { initializeHoloAdapterProject } from '@holo-js/core'

import Category from '../server/models/Category'
import Post from '../server/models/Post'
import Tag from '../server/models/Tag'
import User from '../server/models/User'
import {
  createCategory,
  createPost,
  createTag,
  deletePost,
  getPublishedPostBySlug,
  updatePost,
} from '../server/lib/blog'
```

```ts [Nuxt]
// tests/blog-crud.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '@holo-js/auth'
import { initializeHoloAdapterProject } from '@holo-js/core'

import Category from '../server/models/Category'
import Post from '../server/models/Post'
import Tag from '../server/models/Tag'
import User from '../server/models/User'
import {
  createCategory,
  createPost,
  createTag,
  deletePost,
  getPublishedPostBySlug,
  updatePost,
} from '../server/lib/blog'
```

```ts [SvelteKit]
// tests/blog-crud.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '@holo-js/auth'
import { initializeHoloAdapterProject } from '@holo-js/core'

import Category from '../server/models/Category'
import Post from '../server/models/Post'
import Tag from '../server/models/Tag'
import User from '../server/models/User'
import {
  createCategory,
  createPost,
  createTag,
  deletePost,
  getPublishedPostBySlug,
  updatePost,
} from '../src/lib/server/blog'
```

:::

Below the imports, the test itself is the same for every framework:

```ts
let project: Awaited<ReturnType<typeof initializeHoloAdapterProject>>

describe('blog posts', () => {
  beforeAll(async () => {
    project = await initializeHoloAdapterProject(process.cwd())
  })

  afterAll(async () => {
    await project.runtime.shutdown()
  })

  it('publishes, hides, and deletes a post', async () => {
    const author = await User.create({
      name: 'Test Author',
      email: 'author@example.com',
      password: await hashPassword('secret-secret'),
    })

    await createCategory({ name: 'Product', description: 'Product updates' })
    await createTag({ name: 'Release' })

    const category = await Category.where('slug', 'product').first()
    const tag = await Tag.where('slug', 'release').first()
    if (!category || !tag) {
      throw new Error('Expected the category and tag to exist.')
    }

    await createPost({
      title: 'Launching Holo Blog',
      excerpt: 'The first public post.',
      body: 'This post is created by the test.',
      status: 'published',
      categoryId: String(category.id),
      tagIds: [tag.id],
      authorId: author.id,
    })

    const published = await getPublishedPostBySlug('launching-holo-blog')
    if (!published) {
      throw new Error('Expected the published post to be visible.')
    }

    expect(published.title).toBe('Launching Holo Blog')
    expect(published.category?.slug).toBe('product')
    expect(published.tags.map(postTag => postTag.slug)).toEqual(['release'])

    await updatePost(published.id, {
      title: 'Launching Holo Blog Updated',
      body: 'This post was updated by the test.',
      status: 'draft',
      categoryId: String(category.id),
      tagIds: [tag.id],
    })

    expect(await getPublishedPostBySlug('launching-holo-blog-updated')).toBeUndefined()

    await deletePost(published.id)

    expect(await Post.find(published.id)).toBeUndefined()
  })
})
```

This one test covers what readers of the blog depend on:

- a published post is visible, with its category and tags
- turning it back into a draft hides it from the public site
- deleting it removes it

Two Holo calls make this work:

- **`initializeHoloAdapterProject(process.cwd())`** loads your config, models, and database connection, the same way the dev server does.
- **`project.runtime.shutdown()`** closes the database connection so Vitest can exit.

## Step 4: Run the test

```bash
npm test
```

You should see the migrations run, then one passing test.

::: tip Test the rules, not just the happy path
Good next tests: a validation failure (an empty title is rejected), an authorization failure (a non-editor can't publish), and a category delete that leaves its posts uncategorized. See [Testing your app](/testing/) and [Database tests](/testing/database).
:::

## Step 5: Build for production

```bash
npm run build
```

`build` runs `holo build`. It refreshes Holo's generated files and then runs your framework's production build.

Start the built app:

```bash
npm run start
```

`start` runs `holo start`, which loads Holo before starting your framework's production server. Use `holo start` in your process manager (PM2, systemd, Docker) instead of calling `next start` or `node build/index.js` directly.

## Step 6: Prepare the production environment

Set these on your server or hosting provider. Don't commit them.

| Setting | Why |
| --- | --- |
| `APP_ENV=production`, `APP_DEBUG=false` | Turns off development behavior and detailed error output |
| `APP_KEY` | The app's signing key, used for CSRF tokens and other signed values. `npx holo key:generate` writes one to `.env` if it's missing; keep the same key across deploys |
| `APP_URL` | Your public URL. Used for links in emails and for the broadcast server's allowed origin |
| `DB_URL` (or your database's settings) | Your production database |
| `SESSION_SECURE=true` | Sends the session cookie over HTTPS only |
| `MAIL_MAILER=smtp`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD` | Sends real email for verification and password resets |
| `BROADCAST_APP_ID`, `BROADCAST_APP_KEY`, `BROADCAST_APP_SECRET`, `BROADCAST_HOST`, `BROADCAST_PORT` | Connects the app to your broadcast server with private credentials |

Then deploy in this order:

1. Run `npm test` and `npm run build`.
2. Optionally run `npx holo config:cache` so production reads a cached copy of your config.
3. Deploy the build.
4. Run `npx holo migrate` against the production database.
5. Start the web app with `npm run start`.
6. Start the broadcast server with `npx holo broadcast:work` as its own long-running process. If you switched the queue to a background driver, also run `npx holo queue:work`.

::: warning Workers need a long-running host
The broadcast server and queue workers must keep running after a request ends. Serverless hosts can run the web app, but not these workers. Run them on a server, container service, or other always-on host with the same environment settings.
:::

Uploaded images live on the `public` disk in `storage/app/public`. If you run more than one server, move the disk to S3 or another shared store so every server sees the same files. See [Amazon S3 and compatible storage](/storage/s3).

## Step 7: Check it works

1. `npm test` passes.
2. `npm run build` finishes without errors.
3. `npm run start` serves the blog. Open it and browse the posts.
4. You've written down every setting from Step 6 for your host.

You've built a complete blog with Holo-JS: migrations, models, public pages, a validated admin, sign-in, policies, image uploads, live updates, and a test. Compare your code with the finished apps in the [Holo-JS repository](https://github.com/cobraprojects/holo-js/tree/main/apps) whenever you want to see the full version.

## Next steps

- [Testing your app](/testing/)
- [Faking services in tests](/testing/fakes)
- [Deploying Holo apps](/deployment/)
- [Production checklist](/deployment/checklist)
- [Environment variables](/reference/environment)
