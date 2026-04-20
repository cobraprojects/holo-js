# Jobs And Tests

Authorization is often easiest to use when you already have an explicit actor.

That is common in jobs, queues, tests, and service code.

## Jobs

```ts
import authorization from '@holo-js/authorization'

export async function runPublishJob(postId: string, actor: { id: string, role: string }) {
  const post = await Post.findOrFail(postId)

  await authorization.forUser(actor).policy('posts').authorize('update', post)

  await post.publish()
}
```

Passing the actor explicitly keeps the job deterministic. It does not depend on request context or auth state.
Use `.policy('posts')` to select the posts policy explicitly. If you omit it, the default policy resolution will be used.

## Tests

```ts
import authorization from '@holo-js/authorization'

await expect(
  authorization.forUser({ id: 'user-1', role: 'editor' }).policy('posts').authorize('update', post),
).resolves.toBeUndefined()

await expect(
  authorization.forUser(null).policy('posts').authorize('update', post),
).rejects.toThrow()
```

Use explicit actor tests when you want the authorization rule itself under test, not the request stack.

## What to prefer

- Use `authorization.forUser(user)` when the actor is already known.
- Use `authorization.guard('web')` or top-level helpers only when you want auth to resolve the actor for you.
- Use standalone mode in tests when you want to avoid booting auth.

## Continue

- [Standalone Mode](/authorization/standalone-mode)
- [Auth Integration](/authorization/auth-integrated-mode)
- [403 Vs 404](/authorization/errors)
