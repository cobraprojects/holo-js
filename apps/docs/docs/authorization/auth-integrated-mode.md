# Auth Integration

When `@holo-js/auth` is installed, authorization can use the current actor resolved by auth.

That gives you top-level helpers and named guard helpers without changing the package boundary.

## Top-level helpers

```ts
import { authorize, can, cannot, inspect } from '@holo-js/authorization'

await authorize('update', post)
const allowed = await can('view', post)
const denied = await cannot('delete', post)
const decision = await inspect('view', post)
```

These helpers use the default guard from auth.

## Named guards

```ts
import authorization from '@holo-js/authorization'

await authorization.guard('web').authorize('view', post)
await authorization.guard('admin').authorize('delete', post)

const canExport = await authorization.guard('admin').ability('reports.export').can({
  reportId: 'rpt-1',
  format: 'csv',
})
```

Use named guards when the request should be checked against a non-default auth path.

## Guard context

Auth-integrated handlers receive the resolved guard context, so a policy or ability can branch when the guard itself
matters.

```ts
export default definePolicy('posts', Post, {
  record: {
    update(context, post) {
      if (context.guard === 'admin') {
        return context.user?.role === 'admin'
      }

      return context.user?.id === post.authorId
    },
  },
})
```

## Missing auth integration

If auth is not installed, top-level helpers and named guard helpers fail with a targeted runtime error.

Use `authorization.forUser(...)` when you want authorization to work without auth.

## Continue

- [Standalone Mode](/authorization/standalone-mode)
- [Jobs And Tests](/authorization/jobs-and-tests)
- [403 Vs 404](/authorization/errors)
