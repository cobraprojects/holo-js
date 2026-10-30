# Using Holo with Next.js

Holo runs inside your Next.js App Router project. You write route handlers, server components, and server actions as usual, and call Holo models and services from them.

This page explains how Holo plugs into Next.js and where your code goes. It assumes a project created with `npm create holo-js@latest -- --framework next`.

## How Holo plugs in

Holo connects to Next.js in three places:

- **`next.config.ts`** wraps your config with `withHolo()`. It tells Next.js to load Holo's server packages from `node_modules` instead of bundling them, and adds the build steps Holo needs.
- **`holo dev` and `holo start`** load the Holo runtime before Next.js starts, so models and services are ready in every request.
- **`proxy.ts`** (added with the `auth` or `security` package) runs CSRF checks and route protection.

```ts [next.config.ts]
import type { NextConfig } from 'next'
import { withHolo } from '@holo-js/adapter-next/config'

const nextConfig: NextConfig = withHolo({
  experimental: {
    serverActions: {
      bodySizeLimit: '3mb',
    },
  },
})

export default nextConfig
```

Put your own Next.js options inside the object you pass to `withHolo()`. Holo merges its settings with yours.

::: warning
Start the app with the package scripts (`npm run dev`, `npm run start`), not with `next dev` or `next start` directly. The scripts run `holo dev` and `holo start`, which prepare and load the Holo runtime first.
:::

## Where server code goes

| Code | Location |
| --- | --- |
| API route handlers | `app/**/route.ts`, for example `app/api/posts/route.ts` |
| Server components | `app/**/page.tsx` and `layout.tsx` |
| Server actions | files with `'use server'`, for example `app/posts/actions.ts` |
| Proxy (middleware) | `proxy.ts` at the project root |
| Models, jobs, events, and other Holo code | `server/` |

The scaffold's `tsconfig.json` is the one `create-next-app` writes, with `.holo-js/generated/**/*.ts` added to `include` for Holo's generated types. It maps `@/*` to the project root, so you can import `@/server/models/Post` from anywhere.

## Use Holo in route handlers

Import models and services directly. There is no app object to pass around.

```ts [app/api/posts/route.ts]
import Post from '@/server/models/Post'

export async function GET() {
  const posts = await Post
    .where('status', 'published')
    .latest('published_at')
    .get()

  return Response.json({ posts })
}
```

Holo wraps each exported handler (`GET`, `POST`, and so on) in `app/**/route.ts`. If a handler throws a validation or rate-limit error, the client gets a JSON error response with the right status code instead of a 500. See [Error Responses](/basics/errors).

## Use Holo in server components

Server components can query models while they render:

```tsx [app/posts/page.tsx]
import Post from '@/server/models/Post'

export const dynamic = 'force-dynamic'

export default async function PostsPage() {
  const posts = await Post.where('status', 'published').latest().get()

  return (
    <ul>
      {posts.map(post => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  )
}
```

::: tip
Add `export const dynamic = 'force-dynamic'` to pages that read from the database. Otherwise Next.js may try to render the page once at build time and serve stale data.
:::

## Use Holo in server actions

Server actions work the same way. Use Next.js's own `redirect()` and `revalidatePath()`:

```ts [app/posts/actions.ts]
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import Post from '@/server/models/Post'

export async function createPost(formData: FormData) {
  const post = await Post.create({
    title: String(formData.get('title')),
    body: String(formData.get('body')),
  })

  revalidatePath('/posts')
  redirect(`/posts/${post.id}`)
}
```

Holo wraps each action a `'use server'` file declares and exports. If an action called from the browser throws a validation or rate-limit error, it returns the failure payload instead of answering with a 500, and the error isn't logged. See [Framework Recipes](/basics/forms/frameworks#next-js-server-action).

For real forms, validate the input first with [Forms](/basics/forms/server). The [Framework Recipes](/basics/forms/frameworks) page shows a complete Next.js form.

## Read the current user

With the `auth` package installed, call `auth()` from `@holo-js/auth/next/server` in server components, layouts, and actions:

```tsx [app/admin/layout.tsx]
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated) {
    redirect('/login')
  }

  return children
}
```

`auth()` returns `{ authenticated, guard, provider, user }`. Pass `{ guard: 'admin' }` to check a different guard. In route handlers you can also use the `user()` and `check()` functions from `@holo-js/auth`. See [Authentication](/auth/).

## Protect routes in `proxy.ts`

Next.js 16 runs `proxy.ts` before each matching request. Use Holo's `authOnly()` and `guestOnly()` to redirect visitors, and `csrfProtection()` to reject forged form posts:

```ts [proxy.ts]
import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'
import { csrfProtection } from '@holo-js/security/next/server'

const csrf = csrfProtection()
const auth = protectRoutes(
  guestOnly({
    routes: ['/login', '/register'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)

export async function proxy(request: Parameters<typeof csrf>[0]) {
  const csrfResponse = await csrf(request)
  if (csrfResponse?.status === 419) {
    return csrfResponse
  }

  return await auth(request) ?? csrfResponse
}

export const config = {
  matcher: ['/login', '/register', '/admin/:path*', '/api/:path*'],
}
```

`routes` accepts path patterns, regular expressions, or functions. Each option also takes `guard` and a redirect `status`. If you only installed `security`, the scaffold's `proxy.ts` is just `export const proxy = csrfProtection()`.

## Authorization errors

When `authorize()` from [Authorization](/authorization/) denies access, Holo uses Next.js's built-in forbidden and not-found handling, so your `forbidden.tsx` or `not-found.tsx` pages render. `withHolo()` turns on the Next.js setting this needs. See [Denied Responses](/authorization/errors).

## Routes Holo adds

Some packages add small route files to `app/` that forward to code in `.holo-js/generated/`:

| Package | Route |
| --- | --- |
| `auth` | `app/api/auth/user/route.ts`, the current user as JSON for client code |
| `storage` | `app/storage/[[...path]]/route.ts`, serves files from the public disk |
| `broadcast` | `app/broadcasting/config/route.ts` and `app/broadcasting/auth/route.ts` |
| `realtime` | `app/holo/realtime/query/route.ts` and `app/holo/realtime/mutation/route.ts` |

Commit these files, but leave their contents alone.

## Client components

Client-side helpers come from `@holo-js/adapter-next/client`, such as `useForm()` for forms with typed validation errors. See [Client-Side Forms](/basics/forms/client) and [Current User on the Client](/auth/current-user).

## Scripts

| Script | Runs |
| --- | --- |
| `npm run dev` | `holo dev`: refreshes generated files, watches `server/`, starts `next dev` |
| `npm run build` | `holo build`: refreshes generated files, runs `next build` |
| `npm run start` | `holo start`: loads the Holo runtime, runs `next start`. Use `--port` or `PORT` to change the port |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` |

Arguments after the script are passed to Next.js, for example `npm run dev -- --port 4000`.

## Next steps

- [Routing and Requests](/basics/routing)
- [Using Holo Services](/basics/services)
- [Forms: Framework Recipes](/basics/forms/frameworks)
- [Deploying Holo Apps](/deployment/)
