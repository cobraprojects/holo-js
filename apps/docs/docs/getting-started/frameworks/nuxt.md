# Using Holo with Nuxt

Holo runs inside your Nuxt 4 project as a Nuxt module. You write Nitro event handlers in `server/api` as usual and call Holo models and services from them. Your pages fetch from those handlers with `useFetch`.

This page explains how Holo plugs into Nuxt and where your code goes. It assumes a project created with `npm create holo-js@latest -- --framework nuxt`.

## How Holo plugs in

Add the `@holo-js/adapter-nuxt` module to `nuxt.config.ts`. New projects already have it:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@holo-js/adapter-nuxt'],
})
```

The module:

- starts the Holo runtime when the Nitro server starts
- turns on Nitro's async context, so each request sees its own session and user
- turns thrown validation and rate-limit errors into JSON error responses
- auto-imports your models in server code
- registers the routes that storage, broadcasting, and realtime need, when those packages are installed

You don't need any other setup. Start the app with `npm run dev`, which runs `holo dev` and then `nuxt dev`.

## Where server code goes

Nuxt's `server/` folder holds both Nitro code and Holo code:

| Code | Location |
| --- | --- |
| API event handlers | `server/api/`, for example `server/api/posts.get.ts` |
| Server middleware | `server/middleware/` |
| Holo models, jobs, events, and so on | `server/models`, `server/jobs`, `server/events`, ... |
| Pages, layouts, route middleware | `app/pages`, `app/layouts`, `app/middleware` |
| Code shared by client and server, such as form schemas | `shared/` |

The scaffold's `tsconfig.json` is the one `nuxi init` writes. It points at the separate configs Nuxt generates in `.nuxt/` for app, server, shared, and build-time code. When Nuxt generates its types, Holo adds its generated types and your `config/` folder to the server config, so models, jobs, and config files are type-checked as server code.

## Use Holo in event handlers

Import models and services and use them inside `defineEventHandler`:

```ts [server/api/posts.get.ts]
import Post from '../models/Post'

export default defineEventHandler(async () => {
  const posts = await Post
    .with('category')
    .where('status', 'published')
    .latest('published_at')
    .get()

  return { posts }
})
```

Return models directly. Nitro serializes them to JSON.

Models in the top level of `server/models` are also auto-imported in server code under their file name, so `Post` works without the import line. An explicit import is clearer and works the same way in every framework, which is why these docs use one.

Read the request with Nitro's helpers as usual, for example `getQuery(event)`, `readBody(event)`, or `getRouterParam(event, 'id')`.

## Fetch from pages

Pages call your handlers with Nuxt's data fetching:

```vue [app/pages/posts/index.vue]
<script setup lang="ts">
const { data } = await useFetch('/api/posts')
</script>

<template>
  <ul>
    <li v-for="post in data?.posts" :key="post.id">
      {{ post.title }}
    </li>
  </ul>
</template>
```

Holo code runs on the server only. Don't import models or `@holo-js/config` in components or composables that run in the browser.

## Read the current user

With the `auth` package installed, use the functions from `@holo-js/auth` in event handlers. They read the session from the current request:

```ts [server/api/me.get.ts]
import { check, user } from '@holo-js/auth'

export default defineEventHandler(async (event) => {
  if (!await check()) {
    setResponseStatus(event, 401)
    return { message: 'Unauthenticated.' }
  }

  return { user: await user() }
})
```

Use `auth.guard('api').user()` (from the default export of `@holo-js/auth`) to check a different guard. On the client, `useAuth()` from `@holo-js/auth/nuxt` reads the current user from the `/api/auth/user` route that the `auth` package adds. See [Current User on the Client](/auth/current-user).

## Redirects

Use Nuxt's own redirect helpers. In event handlers that is `sendRedirect` from `h3`; in pages and route middleware it is `navigateTo`:

```ts [server/api/logout.post.ts]
import { logout } from '@holo-js/auth'
import { sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  await logout()

  return await sendRedirect(event, '/login', 303)
})
```

## Protect pages with route middleware

`authOnly()` and `guestOnly()` from `@holo-js/auth/nuxt/server` create Nuxt route middleware. Put them in `app/middleware`:

```ts [app/middleware/auth-only.global.ts]
import { authOnly } from '@holo-js/auth/nuxt/server'

export default authOnly({
  routes: ['/admin/*'],
  redirectTo: '/login',
})
```

```ts [app/middleware/guest-only.global.ts]
import { guestOnly } from '@holo-js/auth/nuxt/server'

export default guestOnly({
  routes: ['/login', '/register'],
  redirectTo: '/admin',
})
```

The `.global` suffix runs the middleware on every navigation; `routes` limits which paths it acts on. Each option also takes `guard` and a redirect `status`.

Route middleware only controls navigation. Always check auth in the event handlers that read or change data, too.

## CSRF protection

With the `security` or `auth` package, the scaffold adds a Nitro server middleware that rejects form posts without a valid CSRF token:

```ts [server/middleware/csrf.ts]
import { csrfProtection } from '@holo-js/security/nuxt/server'

export default csrfProtection()
```

See [CSRF Protection](/basics/security/csrf) for adding the token to your forms.

## Client composables

Client helpers come from `@holo-js/adapter-nuxt/client`, such as `useForm()` for forms with typed validation errors. See [Client-Side Forms](/basics/forms/client) and [Framework Recipes](/basics/forms/frameworks).

## Scripts

| Script | Runs |
| --- | --- |
| `npm run dev` | `holo dev`: refreshes generated files, watches `server/`, starts `nuxt dev` |
| `npm run build` | `holo build`: refreshes generated files, runs `nuxt build` |
| `npm run start` | `holo start`: runs the built server in `.output/server/index.mjs`. Use `--port` or `PORT` to change the port |
| `npm run typecheck` | `nuxt typecheck` |
| `postinstall` | `nuxt prepare`, after each install |

Arguments after the script are passed to Nuxt, for example `npm run dev -- --port 4000`.

## Next steps

- [Routing and Requests](/basics/routing)
- [Using Holo Services](/basics/services)
- [Forms: Framework Recipes](/basics/forms/frameworks)
- [Deploying Holo Apps](/deployment/)
