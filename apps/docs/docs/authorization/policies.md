# Policies

A policy holds the authorization rules for one model, such as "who can create posts" and "who can edit this post". Put each policy in `server/policies`, and Holo picks it up automatically.

## Write a policy

```ts [server/policies/PostPolicy.ts]
import { allow, definePolicy, deny, denyAsNotFound } from '@holo-js/authorization'
import Post from '../models/Post'

export default definePolicy('posts', Post, {
  class: {
    viewAny({ user }) {
      return Boolean(user)
    },
    create({ user }) {
      return Boolean(user)
    },
  },
  record: {
    view({ user }, post) {
      if (post.status === 'published') {
        return true
      }

      return user && String(user.id) === String(post.user_id)
        ? true
        : denyAsNotFound()
    },
    update({ user }, post) {
      if (!user) {
        return deny('Sign in required.')
      }

      return String(user.id) === String(post.user_id)
        ? allow()
        : deny('Only the author can update this post.')
    },
  },
})
```

`definePolicy()` takes three arguments:

1. A name, `'posts'`. It must be unique.
2. The target the policy is for: a model like `Post`, or any class.
3. The rules, split into `class` actions and `record` actions.

Export the policy as the file's default export, one policy per file. Each target can have only one policy.

## Class actions and record actions

**Class actions** answer questions about the model as a whole: `viewAny`, `create`. Check them with the model:

```ts
await authorize('create', Post)
```

**Record actions** answer questions about one record: `view`, `update`, `delete`. Check them with the record, which the handler receives as its second argument:

```ts
const post = await Post.findOrFail(id)
await authorize('update', post)
```

Action names are yours to choose. The same name can be both a class and a record action, for example `publish` on new posts and on existing ones.

## What a rule returns

| Return | Result |
| --- | --- |
| `true` or `allow()` | Allowed |
| `false` or `deny()` | Denied with status 403 and the default message "You are not authorized to perform this action." |
| `deny('message')` | Denied with status 403 and your message |
| `denyAsNotFound()` | Denied with status 404 and "Resource not found.", to hide that the record exists |

Rules can be `async`, so they can query the database:

```ts
record: {
  async comment({ user }, post) {
    if (!user) return false
    const banned = await Ban.where('user_id', user.id).exists()
    return !banned && post.status === 'published'
  },
},
```

Each handler receives a context as its first argument:

| Field | Description |
| --- | --- |
| `user` | The user being checked, or `null` for a guest |
| `authenticated` | `true` when `user` isn't `null` |
| `guard` | The guard name, only when the check runs through `authorization.guard(name)`. See [Using with Auth](/authorization/with-auth#check-against-a-specific-guard) |

## Run a check before every action

`before` runs first for every action. Return a decision to stop there, or `undefined` to continue to the action's rule. This is the usual place for "admins can do anything":

```ts [server/policies/PostPolicy.ts]
export default definePolicy('posts', Post, {
  before({ user }) {
    return user?.role === 'admin' ? true : undefined
  },
  record: {
    update({ user }, post) {
      return user !== null && String(user.id) === String(post.user_id)
    },
  },
})
```

`before` receives the same context and the target, which is the model for class actions and the record for record actions.

::: warning
Return `undefined`, not `false`, when `before` has no opinion. `false` denies every action.
:::

## Pick a policy by name

Usually Holo finds the policy from the target. Use `.policy(name)` to be explicit, for example in shared code:

```ts
import authorization from '@holo-js/authorization'

await authorization.forUser(user).policy('posts').authorize('update', post)
```

Holo checks that the target belongs to that policy. This is available on `forUser(user)` and on `authorization.guard(name)`.

## Check from the user object

When [auth](/auth/) is installed, signed-in users have a `can()` method that runs the same policies:

```ts
import { user } from '@holo-js/auth'

const currentUser = await user()
const canEdit = await currentUser?.can('update', post)
```

## Policies for plain classes

The target doesn't have to be a model. Any class works, and its instances are the records:

```ts [server/policies/InvoicePolicy.ts]
import { definePolicy } from '@holo-js/authorization'
import { Invoice } from '../lib/billing/Invoice'

export default definePolicy('invoices', Invoice, {
  record: {
    download({ user }, invoice) {
      return user !== null && invoice.customerId === user.id
    },
  },
})
```

## When an action has no rule

If you check an action the policy doesn't define, Holo throws an `AuthorizationError` saying the action isn't defined. This also happens with `can()`, so typos fail loudly instead of quietly returning `false`. Checking a target with no policy throws `AuthorizationPolicyNotFoundError`.

## Next steps

- [Abilities](/authorization/abilities)
- [Using with Auth](/authorization/with-auth)
- [Denied Responses (403 vs 404)](/authorization/errors)
