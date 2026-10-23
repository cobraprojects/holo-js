# Using Holo with SvelteKit

Holo runs inside your SvelteKit 2 project. You write `load` functions, form actions, and `+server.ts` endpoints as usual, and call Holo models and services from them.

This page explains how Holo plugs into SvelteKit and where your code goes. It assumes a project created with `npm create holo-js@latest -- --framework sveltekit`.

## How Holo plugs in

`svelte.config.js` wraps your config with `withHoloSvelteKit()`:

```js [svelte.config.js]
import adapter from '@sveltejs/adapter-node'
import { withHoloSvelteKit } from '@holo-js/adapter-sveltekit/config'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = withHoloSvelteKit({
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
})

export default config
```

The wrapper points SvelteKit's hook files at Holo-generated hooks in `.holo-js/generated/`. Those hooks start the Holo runtime, run each request with its own session and user, handle the routes Holo adds, and then call your own hooks from `src/hooks.server.ts` and `src/hooks.ts`.

Edit the object inside `withHoloSvelteKit()` like a normal SvelteKit config. Leave the wrapper in place.

::: warning
Don't set `kit.files.hooks` yourself. `withHoloSvelteKit()` throws an error if you point the hooks somewhere else. Put your hook code in `src/hooks.server.ts` and `src/hooks.ts` instead.
:::

New projects use `@sveltejs/adapter-node`. `vite.config.ts` also lists Holo's packages under `ssr.external` so Vite loads them from `node_modules` on the server.

## Where server code goes

| Code | Location |
| --- | --- |
| Page data | `src/routes/**/+page.server.ts` and `+layout.server.ts` |
| Form actions | `actions` in `+page.server.ts` |
| API endpoints | `src/routes/**/+server.ts` |
| Server hooks | `src/hooks.server.ts` |
| Server-only helpers | `src/lib/server/` |
| Holo models, jobs, events, and so on | `server/` at the project root |

## Use Holo in `load` functions

Import models and query them in a server `load` function:

```ts [src/routes/posts/+page.server.ts]
import Post from '../../../server/models/Post'
import type { PageServerLoad } from './$types'

export const load = (async () => {
  const posts = await Post
    .with('category')
    .where('status', 'published')
    .latest('published_at')
    .get()

  return { posts }
}) satisfies PageServerLoad
```

You can return models and collections from `load`. Holo registers a SvelteKit transport that serializes them for the page.

```svelte [src/routes/posts/+page.svelte]
<script lang="ts">
  let { data } = $props()
</script>

<ul>
  {#each data.posts as post (post.id)}
    <li>{post.title}</li>
  {/each}
</ul>
```

::: tip
Keep Holo calls in server-only files: `+page.server.ts`, `+layout.server.ts`, `+server.ts`, hooks, and `src/lib/server`. A universal `+page.ts` also runs in the browser, where Holo is not available.
:::

## Use Holo in endpoints

```ts [src/routes/api/posts/+server.ts]
import { json } from '@sveltejs/kit'

import Post from '../../../../server/models/Post'

export async function GET() {
  const posts = await Post.where('status', 'published').latest().get()

  return json({ posts })
}
```

If an endpoint or action throws a validation or rate-limit error, Holo's hooks turn it into the matching error response. See [Error Responses](/basics/errors).

## Form actions and redirects

Use SvelteKit's own `redirect()` in actions:

```ts [src/routes/posts/new/+page.server.ts]
import { redirect } from '@sveltejs/kit'

import Post from '../../../../server/models/Post'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const formData = await request.formData()
    const post = await Post.create({
      title: String(formData.get('title')),
      body: String(formData.get('body')),
    })

    redirect(303, `/posts/${post.id}`)
  },
} satisfies Actions
```

For real forms, validate the input first with [Forms](/basics/forms/server). The [Framework Recipes](/basics/forms/frameworks) page shows a complete SvelteKit form.

## Read the current user

With the `auth` package installed, call `auth()` from `@holo-js/auth/sveltekit/server` in any server `load`, action, or endpoint:

```ts [src/routes/+layout.server.ts]
import { auth } from '@holo-js/auth/sveltekit/server'
import type { LayoutServerLoad } from './$types'

export const load = (async () => {
  return { auth: await auth() }
}) satisfies LayoutServerLoad
```

`auth()` returns `{ authenticated, guard, provider, user }`. Pass `{ guard: 'admin' }` to check a different guard. See [Authentication](/auth/).

## Your own hooks

Export `handle`, `handleError`, or `handleFetch` from `src/hooks.server.ts`. Holo runs its own handling first, then yours. Use SvelteKit's `sequence()` to combine several handlers:

```ts [src/hooks.server.ts]
import { sequence } from '@sveltejs/kit/hooks'
import { authOnly, guestOnly } from '@holo-js/auth/sveltekit/server'
import { csrfProtection } from '@holo-js/security/sveltekit/server'

export const handle = sequence(
  csrfProtection(),
  guestOnly({
    routes: ['/login', '/register'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)
```

- `csrfProtection()` rejects form posts without a valid CSRF token. See [CSRF Protection](/basics/security/csrf).
- `authOnly()` and `guestOnly()` redirect visitors based on whether they are signed in. `routes` accepts path patterns, regular expressions, or functions. Each option also takes `guard` and a redirect `status`.

Without your own `handleError`, unexpected errors are logged and the response carries SvelteKit's generic message, unless `debug` is `true` in `config/app.ts`. See [Unexpected errors](/basics/errors#unexpected-errors-in-sveltekit).

In `src/hooks.ts` you can export `reroute` and `transport`. Holo merges them with its own.

## Authorization errors

When `authorize()` from [Authorization](/authorization/) denies access, Holo throws a SvelteKit `error()` with status 403 or 404, so your `+error.svelte` page renders. See [Denied Responses](/authorization/errors).

## Routes Holo adds

The Holo hooks answer a few routes directly, depending on which packages you installed:

| Package | Route |
| --- | --- |
| `auth` | `GET /api/auth/user`, the current user as JSON for client code |
| `storage` | files from the public disk under `/storage` |
| `broadcast` | `/broadcasting/config` and `/broadcasting/auth` |
| `realtime` | `/holo/realtime/query` and `/holo/realtime/mutation` |

## Client helpers

Client-side helpers come from `@holo-js/adapter-sveltekit/client`, such as `useForm()` for forms with typed validation errors. Pass `pageData: data` from the page's `data` prop, which comes from the root layout load that returns `readValidationFlash()`, so flashed errors and input are restored. See [Client-Side Forms](/basics/forms/client), [Framework Recipes](/basics/forms/frameworks#sveltekit-form-actions), and [Current User on the Client](/auth/current-user).

## Scripts

| Script | Runs |
| --- | --- |
| `npm run dev` | `holo dev`: refreshes generated files, watches `server/`, starts `vite dev` |
| `npm run build` | `holo build`: refreshes generated files, runs `vite build` |
| `npm run start` | `holo start`: runs the built server in `build/index.js`. Use `--port` or `PORT` to change the port |
| `npm run typecheck` | `svelte-kit sync && svelte-check` |

The SvelteKit dev server runs on `http://localhost:5173`.

## Next steps

- [Routing and Requests](/basics/routing)
- [Using Holo Services](/basics/services)
- [Forms: Framework Recipes](/basics/forms/frameworks)
- [Deploying Holo Apps](/deployment/)
