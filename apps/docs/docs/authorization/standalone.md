# Using without Auth

Authorization works without `@holo-js/auth`. Pass the user to `authorization.forUser()` and run the same policies and abilities. This is also the right tool when you already have the user, even in an app that uses auth: in jobs, scripts, and services.

## Check a user you already have

```ts
import authorization from '@holo-js/authorization'

const actor = { id: 7, role: 'editor' }

await authorization.forUser(actor).authorize('update', post)

const canView = await authorization.forUser(actor).can('view', post)
const decision = await authorization.forUser(actor).inspect('delete', post)
```

`forUser()` returns an object with `authorize()`, `can()`, `cannot()`, `inspect()`, `policy(name)`, and `ability(name)`:

```ts
await authorization.forUser(actor).policy('posts').authorize('update', post)

await authorization.forUser(actor).ability('reports.export').authorize({
  reportId: 'rpt_42',
  format: 'csv',
})
```

The user can be any object: a model instance, a row from your own auth system, or a plain object. Your rules receive it as `user`.

## Check a guest

Pass `null`:

```ts
const guestCanView = await authorization.forUser(null).can('view', post)
```

Rules get `user: null` and `authenticated: false`.

## Use your own auth system

If users sign in through something other than Holo Auth, load the user however you normally do and pass it in:

```ts [app/api/posts/[id]/route.ts]
import authorization from '@holo-js/authorization'
import { getSessionUser } from '@/lib/session'
import Post from '@/server/models/Post'

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const post = await Post.findOrFail(Number(id))
  const decision = await authorization.forUser(await getSessionUser(request)).inspect('delete', post)

  if (!decision.allowed) {
    return Response.json({ message: decision.message }, { status: decision.status })
  }

  await post.delete()
  return new Response(null, { status: 204 })
}
```

Here `getSessionUser()` stands for your own code.

## When `authorize()` says no

Without auth installed, a failed `authorize()` throws an `AuthorizationError`. Its `decision` has the `status` (`403` or `404`) and `message`, so turn it into a response yourself, or use `inspect()` as above. See [Denied Responses](/authorization/errors#handle-the-error-yourself).

When auth is installed, `forUser().authorize()` throws your framework's HTTP error instead, the same as the top-level `authorize()`.

## What's not available

`authorize()`, `can()`, `cannot()`, and `inspect()` imported directly, and `authorization.guard()`, need auth to know who is signed in. Without auth they throw `AuthorizationAuthIntegrationMissingError`. Use `forUser()` everywhere instead.

## Next steps

- [Jobs and Tests](/authorization/jobs-and-tests)
- [Policies](/authorization/policies)
- [Denied Responses (403 vs 404)](/authorization/errors)
