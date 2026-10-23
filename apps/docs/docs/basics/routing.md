# Routing and Requests

Holo-JS doesn't add a router. You write routes, pages, and server actions the way your framework already does, and you use Holo inside them to validate input, query the database, check the current user, and return a response.

## Your first route

This route returns the latest published posts as JSON:

::: code-group

```ts [Next.js]
// app/api/posts/route.ts
import Post from '@/server/models/Post'

export async function GET() {
  const posts = await Post
    .where('status', 'published')
    .latest('published_at')
    .paginate(20)

  return Response.json(posts)
}
```

```ts [Nuxt]
// server/api/posts.get.ts
import Post from '../models/Post'

export default defineEventHandler(async () => {
  return await Post
    .where('status', 'published')
    .latest('published_at')
    .paginate(20)
})
```

```ts [SvelteKit]
// src/routes/api/posts/+server.ts

import Post from '../../../../server/models/Post'

export async function GET() {
  const posts = await Post
    .where('status', 'published')
    .latest('published_at')
    .paginate(20)

  return Response.json(posts)
}
```

:::

You don't create a database connection or pass an app object around. The Holo integration for your framework (`withHolo()` in Next.js, the `@holo-js/adapter-nuxt` module, or `withHoloSvelteKit()` in SvelteKit) sets everything up, so you import [models](/orm/) and other services and call them directly.

## Where routes live

Each framework keeps its own conventions:

| Framework | JSON endpoints | Pages and form handling |
|---|---|---|
| Next.js | `app/**/route.ts` exporting `GET`, `POST`, ... | Server components and server actions |
| Nuxt | `server/api/**` (for example `posts.get.ts`, `posts.post.ts`) and `server/routes/**` | Pages that call `server/api` endpoints |
| SvelteKit | `src/routes/**/+server.ts` | `load` and form `actions` in `+page.server.ts` |

Your backend code lives next to your routes, in folders Holo knows about: `server/models`, `server/jobs`, `server/events`, `server/listeners`, `server/policies`, and `config/`. See [project structure](/getting-started/project-structure) for the full layout.

## A typical handler

Most handlers do three things: validate the input, call a model, and return JSON.

First, define the input shape with a [validation](/basics/validation/) schema:

```ts [server/schemas/post.ts]
import { field, schema } from '@holo-js/validation'

export const createPostInput = schema({
  title: field.string().required().max(255),
  body: field.string().required(),
})
```

Then use it in a route:

::: code-group

```ts [Next.js]
// app/api/posts/route.ts
import { validate } from '@holo-js/validation'
import { createPostInput } from '@/server/schemas/post'
import Post from '@/server/models/Post'

export async function POST(request: Request) {
  const data = await validate(request, createPostInput)
  const post = await Post.create(data)

  return Response.json(post, { status: 201 })
}
```

```ts [Nuxt]
// server/api/posts.post.ts
import { validate } from '@holo-js/validation'
import { createPostInput } from '../schemas/post'
import Post from '../models/Post'

export default defineEventHandler(async (event) => {
  const data = await validate(await readBody(event), createPostInput)
  const post = await Post.create(data)

  setResponseStatus(event, 201)
  return post
})
```

```ts [SvelteKit]
// src/routes/api/posts/+server.ts

import { validate } from '@holo-js/validation'
import { createPostInput } from '../../../../server/schemas/post'
import Post from '../../../../server/models/Post'

export async function POST({ request }) {
  const data = await validate(request, createPostInput)
  const post = await Post.create(data)

  return Response.json(post, { status: 201 })
}
```

:::

If the input is invalid, `validate()` throws and Holo sends a `422` response with the field errors. You don't need a `try`/`catch`. See [error responses](/basics/errors) for how each framework handles this.

`data` is typed from the schema, so `data.title` is a `string` and unknown fields are dropped.

## Read route parameters

Use your framework's own way of reading parameters, then look the record up. Return a `404` when it doesn't exist:

::: code-group

```ts [Next.js]
// app/api/posts/[slug]/route.ts
import Post from '@/server/models/Post'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const post = await Post.where('slug', slug).first()

  if (!post) {
    return Response.json({ message: 'Post not found.' }, { status: 404 })
  }

  return Response.json(post)
}
```

```ts [Nuxt]
// server/api/posts/[slug].get.ts
import Post from '../../models/Post'

export default defineEventHandler(async (event) => {
  const post = await Post.where('slug', getRouterParam(event, 'slug') ?? '').first()

  if (!post) {
    throw createError({ statusCode: 404, statusMessage: 'Post not found.' })
  }

  return post
})
```

```ts [SvelteKit]
// src/routes/api/posts/[slug]/+server.ts
import { error } from '@sveltejs/kit'
import Post from '../../../../../server/models/Post'

export async function GET({ params }) {
  const post = await Post.where('slug', params.slug).first()

  if (!post) {
    error(404, 'Post not found.')
  }

  return Response.json(post)
}
```

:::

Models turn into plain JSON when you return them, including any relations you loaded with `with()`. See [serialization](/orm/serialization) to hide or add fields.

## What you can use inside a request

Everything below works in route handlers, server actions, `load` functions, and form actions:

| Task | Use | Learn more |
|---|---|---|
| Query and save records | Models, `DB` from `@holo-js/db` | [ORM](/orm/), [query builder](/database/query-builder/) |
| Check input | `validate()`, `safeParse()` | [Validation](/basics/validation/) |
| Handle HTML forms | `validate()` from `@holo-js/forms`, `useForm()` | [Forms](/basics/forms/) |
| Get the signed-in user | `user()`, `check()` from `@holo-js/auth` | [Authentication](/auth/) |
| Allow or deny an action | `authorize()` from `@holo-js/authorization` | [Authorization](/authorization/) |
| Throttle requests | `protect()`, `rateLimit()` from `@holo-js/security` | [Rate limiting](/basics/security/rate-limiting) |
| Store files | `Storage` from `@holo-js/storage/runtime` | [File storage](/storage/) |
| Run work later | Job `.dispatch()` | [Queues](/queue/) |
| Announce that something happened | Event `.dispatch()` | [Events](/events/) |

Here is a route that combines several of them:

```ts [app/api/v1/posts/route.ts]
import auth from '@holo-js/auth'
import Post from '@/server/models/Post'

export async function GET() {
  const currentUser = await auth.guard('api').user()

  if (!currentUser) {
    return Response.json({ message: 'Unauthenticated.' }, { status: 401 })
  }

  if (!await currentUser.can('viewAny', Post)) {
    return Response.json({ message: 'Forbidden.' }, { status: 403 })
  }

  const posts = await Post
    .with('category', 'tags')
    .where('user_id', currentUser.id)
    .orderBy('published_at', 'desc')
    .get()

  return Response.json({ posts })
}
```

See [using Holo services](/basics/services) for the full list of services and how they behave outside a request.

## Keep handlers small

When a route starts doing several database writes, uploads, and dispatches, move that work into a plain function under `server/` and call it from the route. The same function can then be reused from a server action, a [job](/queue/jobs), or a [custom command](/reference/custom-commands).

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'
import Post from '../models/Post'
import PostPublished from '../events/post-published'

export async function publishPost(id: number) {
  const post = await DB.transaction(async () => {
    const post = await Post.findOrFail(id)
    await post.update({ status: 'published', published_at: new Date() })
    return post
  })

  await PostPublished.dispatch({ postId: post.id })

  return post
}
```

## Next steps

- [Using Holo services](/basics/services)
- [Validation](/basics/validation/)
- [Error responses](/basics/errors)
- [Your framework: Next.js](/getting-started/frameworks/next), [Nuxt](/getting-started/frameworks/nuxt), [SvelteKit](/getting-started/frameworks/sveltekit)
