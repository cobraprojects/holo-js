# Standalone Mode

Standalone mode is the authorization API without `@holo-js/auth`.

It works by passing the actor explicitly.

## Core API

```ts
import authorization from '@holo-js/authorization'

const post = { id: 'post-123', authorId: 'user-1' }

await authorization.forUser({ id: 'user-1', role: 'editor' }).authorize('update', post)
await authorization.forUser({ id: 'user-1', role: 'editor' }).can('view', post)
await authorization.forUser(null).can('view', post)
await authorization.forUser({ id: 'user-1', role: 'editor' }).policy('posts').authorize('update', post)
await authorization.forUser({ id: 'user-1', role: 'editor' }).ability('reports.export').can({
  reportId: 'rpt-1',
  format: 'csv',
})
```

`authorization.forUser(null)` is the guest form. It keeps the same policy and ability typing, which makes guest checks
safe and explicit.

## Why this mode exists

Standalone mode keeps authorization usable in:

- jobs
- tests
- background workers
- service code that already has a concrete actor
- projects that do not install auth

That keeps authorization decoupled from guard resolution.

## What not to do

Do not build standalone authorization around an implicit current user. If your code already has the actor, pass it
directly.

Do not use standalone mode for request identity lookup. That belongs to auth.

## Continue

- [Policies](/authorization/policies)
- [Abilities](/authorization/abilities)
- [Auth Integration](/authorization/auth-integrated-mode)
- [Jobs And Tests](/authorization/jobs-and-tests)
