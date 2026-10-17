# Using with Auth

When [auth](/auth/) is installed, authorization knows who is signed in. `authorize()`, `can()`, `cannot()`, and `inspect()` check the current user without you passing it, and `authorization.guard(name)` checks the user of a specific guard.

## Check the signed-in user

```ts
import { authorize, can, cannot, inspect } from '@holo-js/authorization'

await authorize('update', post)

const canView = await can('view', post)
const cannotDelete = await cannot('delete', post)
const decision = await inspect('publish', post)
```

These use the user of your default guard (`defaults.guard` in `config/auth.ts`). A guest is checked with `user: null`, so your rules decide what guests may do.

## Check against a specific guard

`authorization.guard(name)` uses that guard's user. It has the same checks, plus `.policy()` and `.ability()`:

```ts
import authorization from '@holo-js/authorization'

await authorization.guard('admin').authorize('delete', post)

const canExport = await authorization.guard('admin').ability('reports.export').can({
  reportId: 'rpt_42',
  format: 'csv',
})
```

This also works for token guards: `authorization.guard('api')` checks the user of the request's [API token](/auth/api-tokens). Token abilities are separate; check them with `token.can()`.

Only checks through `authorization.guard(name)` pass the guard name to your rules. Use it when a rule depends on how the user signed in:

```ts [server/policies/PostPolicy.ts]
import { definePolicy } from '@holo-js/authorization'
import Post from '../models/Post'

export default definePolicy('posts', Post, {
  before({ guard, authenticated }) {
    return guard === 'admin' && authenticated ? true : undefined
  },
  record: {
    update({ user }, post) {
      return user !== null && String(user.id) === String(post.user_id)
    },
  },
})
```

::: warning
The top-level `authorize()`, `can()`, `cannot()`, and `inspect()` don't set `guard`, so it's `undefined` in your rules even though they use the default guard. If a rule depends on `guard`, call it through `authorization.guard(name)`.
:::

An unknown guard name throws `AuthorizationGuardNotFoundError`.

## What happens when `authorize()` says no

With auth installed, a failed `authorize()` throws your framework's own HTTP error, so you don't need to catch it:

| Framework | Error | What renders |
| --- | --- | --- |
| Next.js | Next's built-in forbidden / not-found error | `forbidden.tsx` or `not-found.tsx` |
| Nuxt | `createError({ statusCode, statusMessage })` | Your error page, or a JSON error from API routes |
| SvelteKit | `error(status, message)` | `+error.svelte`, or a JSON error from API routes |

The status is `403` for `deny()` and `404` for `denyAsNotFound()`. The message is the one you passed to `deny()`. In Next.js, `withHolo()` turns on the `authInterrupts` option that `forbidden.tsx` needs. See [Denied Responses](/authorization/errors).

## Check auth and authorization together

Authorization doesn't require a signed-in user; that's what your rules decide. Pages that need a user should still check auth first, so guests are sent to the login page instead of seeing a 403:

```ts [app/admin/layout.tsx]
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { authorize } from '@holo-js/authorization'
import Post from '@/server/models/Post'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated) {
    redirect('/login')
  }

  await authorize('viewAny', Post)

  return children
}
```

## Without auth

If auth isn't installed, the top-level checks and `authorization.guard()` throw `AuthorizationAuthIntegrationMissingError`. Use `authorization.forUser(user)` instead. See [Using without Auth](/authorization/standalone).

## Next steps

- [Using without Auth](/authorization/standalone)
- [Denied Responses (403 vs 404)](/authorization/errors)
- [Guards and Providers](/auth/guards-and-providers)
