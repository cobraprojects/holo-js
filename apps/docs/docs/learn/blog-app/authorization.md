# Authorization

This chapter adds policy checks so only allowed users can manage blog content.

## What you will build

- post policies
- category policies
- tag policies
- publish permission checks
- admin action authorization

## Files you will create

```txt
server/policies/PostPolicy.ts
server/policies/CategoryPolicy.ts
server/policies/TagPolicy.ts
app/admin/actions.ts
```

The finished example uses:

- `apps/blog-next/server/policies/PostPolicy.ts`
- `apps/blog-next/server/policies/CategoryPolicy.ts`
- `apps/blog-next/server/policies/TagPolicy.ts`
- `apps/blog-next/app/admin/actions.ts`

## Authorize before writes

```ts
import { authorize } from '@holo-js/authorization'
import Post from '@/server/models/Post'

await authorize('create', Post)

if (status === 'published') {
  await authorize('publish', Post)
}
```

## Authorize model instances

```ts
const post = await Post.findOrFail(id)
await authorize('update', post)
await authorize('delete', post)
```

## Checkpoint

The admin UI is no longer just authenticated. Each write is guarded by a policy ability.

## Related reference

- [Authorization Overview](/authorization/)
- [Policies](/authorization/policies)
- [Abilities](/authorization/abilities)
- [403 vs 404](/authorization/errors)
