# Policies

Policies handle resource-based authorization. They are the right tool when the decision depends on a model or class
target.

## Policy shape

```ts
import { definePolicy, allow, deny } from '@holo-js/authorization'
import { Post } from '@/server/models/Post'

export default definePolicy('posts', Post, {
  class: {
    create(context) {
      return Boolean(context.user)
    },
    viewAny(context) {
      return context.user?.role === 'admin'
    },
  },
  record: {
    view(context, post) {
      if (post.publishedAt) {
        return allow()
      }

      return context.user?.id === post.authorId
    },
    update(context, post) {
      return context.user?.id === post.authorId
    },
    delete(context) {
      return context.user?.role === 'admin'
        ? allow()
        : deny('Only admins can delete posts.')
    },
  },
})
```

The policy name is the registry key. Holo uses that name to generate typed discovery output and autocomplete.

## Class actions

Class actions apply to the model itself, not to a specific record.

Use them for actions such as:

- `create`
- `viewAny`

Example:

```ts
await authorization.forUser(user).policy('posts').authorize('create', Post)
```

## Record actions

Record actions apply to a specific instance.

Use them for actions such as:

- `view`
- `update`
- `delete`

Example:

```ts
await authorization.forUser(user).policy('posts').authorize('update', post)
```

## Before hooks

Policies can define a `before(...)` hook when you need a shared rule before individual actions run.

```ts
export default definePolicy('posts', Post, {
  before(context) {
    if (context.user?.role === 'admin') {
      return allow()
    }
  },
  record: {
    update(context, post) {
      return context.user?.id === post.authorId
    },
  },
})
```

Use `before(...)` for broad allow/deny shortcuts. Keep action handlers for the actual business rule.

## Discovery and typing

Policy files belong in `server/policies`. The CLI discovers them, generates typed registry artifacts, and gives you
autocomplete for:

- policy names
- policy class actions
- policy record actions
- target inference

That is what lets `authorization.forUser(user).policy('posts')` stay type-safe without manual annotations.

## Continue

- [Abilities](/authorization/abilities)
- [Standalone Mode](/authorization/standalone-mode)
- [Auth Integration](/authorization/auth-integrated-mode)
