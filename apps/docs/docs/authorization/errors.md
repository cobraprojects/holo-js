# Denied Responses (403 vs 404)

A rule can say no in two ways. `deny()` answers **403 Forbidden**: "this exists, but you can't do that". `denyAsNotFound()` answers **404 Not Found**: "as far as you know, this doesn't exist". This page covers which to use and how each one reaches the user.

## Choose 403 or 404

```ts [server/policies/PostPolicy.ts]
import { definePolicy, deny, denyAsNotFound } from '@holo-js/authorization'
import Post from '../models/Post'

export default definePolicy('posts', Post, {
  record: {
    view({ user }, post) {
      if (post.status === 'published') {
        return true
      }

      return user && String(user.id) === String(post.user_id)
        ? true
        : denyAsNotFound()
    },
    delete({ user }) {
      return user?.role === 'admin'
        ? true
        : deny('Only admins can delete posts.')
    },
  },
})
```

- Use **`deny()`** when the user can already see the record and just isn't allowed this action, like deleting a post they can read.
- Use **`denyAsNotFound()`** for private records, like someone else's draft or invoice. A 403 would confirm the record exists.

| Helper | Status | Default message |
| --- | --- | --- |
| `deny(message?)` | 403 | You are not authorized to perform this action. |
| `denyAsNotFound(message?)` | 404 | Resource not found. |
| `false` | 403 | You are not authorized to perform this action. |

Write `deny()` messages for the user; they're shown on the error page.

## How a denial reaches the user

With [auth](/auth/) installed, a failed `authorize()` throws your framework's own HTTP error with the status and message:

| Framework | Customize the page in |
| --- | --- |
| Next.js | `app/forbidden.tsx` for 403, `app/not-found.tsx` for 404 |
| Nuxt | `error.vue`. API routes return a JSON error |
| SvelteKit | `src/routes/+error.svelte`. `+server.ts` routes return a JSON error |

In Next.js, `withHolo()` in `next.config.ts` turns on `experimental.authInterrupts`, which `forbidden.tsx` needs.

## Return a custom response

Use `inspect()` when you want to build the response yourself, for example in a JSON API:

```ts [app/api/posts/[id]/route.ts]
import { inspect } from '@holo-js/authorization'
import Post from '@/server/models/Post'

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const post = await Post.findOrFail(Number(id))
  const decision = await inspect('delete', post)

  if (!decision.allowed) {
    return Response.json({ message: decision.message }, { status: decision.status })
  }

  await post.delete()
  return new Response(null, { status: 204 })
}
```

A decision is `{ allowed, status, message? }`, where `status` is `200`, `403`, or `404`.

## Handle the error yourself

Without auth installed, `authorize()` throws an `AuthorizationError` instead. Its `decision` holds the status and message:

```ts
import authorization, { isAuthorizationError } from '@holo-js/authorization'

try {
  await authorization.forUser(actor).authorize('update', post)
} catch (error) {
  if (isAuthorizationError(error)) {
    return Response.json({ message: error.message }, { status: error.decision.status })
  }
  throw error
}
```

## Errors that mean a bug

These aren't denials. They mean the code or setup is wrong, so let them surface:

| Error | Cause |
| --- | --- |
| `AuthorizationPolicyNotFoundError` | No policy for the target, or the target doesn't match the policy picked with `.policy(name)` |
| `AuthorizationAbilityNotFoundError` | No ability with that name |
| `AuthorizationGuardNotFoundError` | `authorization.guard(name)` with a guard that isn't in `config/auth.ts` |
| `AuthorizationAuthIntegrationMissingError` | Top-level checks or `guard()` used without auth installed |
| `AuthorizationError` "Policy action ... is not defined" | The policy has no rule for that action |

## Next steps

- [Policies](/authorization/policies)
- [Using with Auth](/authorization/with-auth)
- [Error Responses](/basics/errors)
