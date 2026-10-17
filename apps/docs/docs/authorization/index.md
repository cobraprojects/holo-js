# Authorization

Authorization decides what a user is allowed to do: edit this post, delete that comment, export a report. You write the rules once, in policies and abilities, and check them in your routes with `authorize()` or `can()`. [Authentication](/auth/) tells you who the user is; authorization tells you what they may do.

## Quick example

Write a policy for the `Post` model:

```ts [server/policies/PostPolicy.ts]
import { definePolicy, deny } from '@holo-js/authorization'
import Post from '../models/Post'

export default definePolicy('posts', Post, {
  class: {
    create({ user }) {
      return Boolean(user)
    },
  },
  record: {
    update({ user }, post) {
      return user && String(user.id) === String(post.user_id)
        ? true
        : deny('Only the author can edit this post.')
    },
  },
})
```

Then check it before changing data:

::: code-group

```ts [Next.js]
// app/posts/[id]/edit/actions.ts
'use server'

import { authorize } from '@holo-js/authorization'
import { redirect } from 'next/navigation'
import Post from '@/server/models/Post'

export async function updatePostAction(id: number, formData: FormData) {
  const post = await Post.findOrFail(id)
  await authorize('update', post)

  await post.update({ title: String(formData.get('title')) })
  redirect(`/posts/${id}`)
}
```

```ts [Nuxt]
// server/api/posts/[id].put.ts
import { authorize } from '@holo-js/authorization'
import Post from '../../models/Post'

export default defineEventHandler(async (event) => {
  const post = await Post.findOrFail(Number(getRouterParam(event, 'id')))
  await authorize('update', post)

  const body = await readBody<{ title: string }>(event)
  await post.update({ title: body.title })
  return { ok: true }
})
```

```ts [SvelteKit]
// src/routes/posts/[id]/edit/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { authorize } from '@holo-js/authorization'
import Post from '../../../../../server/models/Post'
import type { Actions } from './$types'

export const actions = {
  default: async ({ params, request }) => {
    const post = await Post.findOrFail(Number(params.id))
    await authorize('update', post)

    const formData = await request.formData()
    await post.update({ title: String(formData.get('title')) })
    redirect(303, `/posts/${params.id}`)
  },
} satisfies Actions
```

:::

If the policy says no, `authorize()` stops the request with your framework's own `403` error, using the message from `deny()`. See [Denied Responses](/authorization/errors).

`authorize('update', post)` finds the right policy from the target: a `Post` record uses the `posts` policy. Once Holo has generated types for your policies, action names autocomplete and `authorize('updte', post)` is a type error.

## Install

```bash
npx holo install authorization
```

This adds `@holo-js/authorization` and creates two folders that Holo scans:

- `server/policies` for [policies](/authorization/policies): rules about a model, like "can update this post"
- `server/abilities` for [abilities](/authorization/abilities): rules not tied to a model, like "can export reports"

New projects can include it with `--package authorization` when running `npx holo new`.

## Who is the user?

When [auth](/auth/) is installed, `authorize()`, `can()`, `cannot()`, and `inspect()` check the signed-in user of your default guard. See [Using with Auth](/authorization/with-auth).

Without auth, or when you already have the user (in a job, a script, or a test), pass it in yourself:

```ts
import authorization from '@holo-js/authorization'

await authorization.forUser(user).authorize('update', post)
await authorization.forUser(null).can('view', post)
```

`forUser(null)` checks as a guest. See [Using without Auth](/authorization/standalone).

## The checks

| Function | Returns | When the answer is no |
| --- | --- | --- |
| `authorize(action, target)` | nothing | Throws a 403 or 404 error |
| `can(action, target)` | `true` / `false` | Returns `false` |
| `cannot(action, target)` | `true` / `false` | Returns `true` |
| `inspect(action, target)` | `{ allowed, status, message? }` | Returns the decision |

The target is a model class (`Post`) for actions that don't need a record, like `create`, or a record (`post`) for actions on one item, like `update`. Each check is also available on `authorization.forUser(user)` and `authorization.guard(name)`.

## Types

Holo scans `server/policies` and `server/abilities` and generates types for policy names, actions, and ability inputs. Run `npx holo prepare` after adding or renaming a policy if your editor doesn't pick it up.

## Authorization API reference

Every public function in `@holo-js/authorization`, grouped by task. Internal helpers aren't listed.

**Check access**: [authorize()](#authorize), [can()](#can), [cannot()](#cannot), [inspect()](#inspect)

**Choose who is checking**: [forUser()](#foruser), [guard()](#guard), [policy()](#policy), [ability()](#ability), [authorization (default export)](#authorization-default-export)

**Define rules**: [definePolicy()](#definepolicy), [defineAbility()](#defineability)

**Build decisions**: [allow()](#allow), [deny()](#deny), [denyAsNotFound()](#denyasnotfound), [normalizeAuthorizationDecision()](#normalizeauthorizationdecision)

**Type checks**: [isAuthorizationDecision()](#isauthorizationdecision), [isAuthorizationError()](#isauthorizationerror), [isAuthorizationPolicyDefinition()](#isauthorizationpolicydefinition), [isAuthorizationAbilityDefinition()](#isauthorizationabilitydefinition)

**Errors**: [AuthorizationError](#authorizationerror), [AuthorizationPolicyNotFoundError](#authorizationpolicynotfounderror), [AuthorizationAbilityNotFoundError](#authorizationabilitynotfounderror), [AuthorizationGuardNotFoundError](#authorizationguardnotfounderror), [AuthorizationAuthIntegrationMissingError](#authorizationauthintegrationmissingerror)

A check resolves to a decision: `{ allowed, status, message?, code? }`, where `status` is `200`, `403`, or `404`. `authorize()` throws an `AuthorizationError` for a denied decision, unless your framework's auth integration customizes the error. The other checks return the boolean or decision directly.

### authorize()

`authorize(action, target): Promise<void>`

Throws an `AuthorizationError` when the signed-in user (default guard) isn't allowed to do `action` on `target`. Pass a model class for class actions, or a record for record actions.

```ts
import { authorize } from '@holo-js/authorization'

await authorize('update', post)
```

### can()

`can(action, target): Promise<boolean>`

Returns `true` when the signed-in user may do `action` on `target`.

### cannot()

`cannot(action, target): Promise<boolean>`

Returns `true` when the signed-in user may not do `action`. It's the opposite of `can()`.

### inspect()

`inspect(action, target): Promise<AuthorizationDecision>`

Returns the full decision, including `status` and `message`, without throwing. Use it when a response should show the reason.

```ts
import { inspect } from '@holo-js/authorization'

const decision = await inspect('delete', comment)
if (!decision.allowed) {
  return Response.json({ message: decision.message }, { status: decision.status })
}
```

### forUser()

`forUser(actor: object | null): AuthorizationActorBuilder`

Runs the same checks as `can()`, `authorize()`, and the others for an actor you pass in. Pass `null` to check as a guest. The builder also has `policy(name)` and `ability(name)`. See [Using without Auth](/authorization/standalone).

### guard()

`guard(name: string): AuthorizationActorBuilder`

Runs the checks for the user signed in on another [auth guard](/auth/guards-and-providers), such as `'admin'`. Throws `AuthorizationGuardNotFoundError` for an unknown guard name.

### policy()

`authorization.forUser(actor).policy(name): { authorize, can, cannot, inspect }`

Checks against one named policy, so you can skip the target-to-policy lookup. The target must be the model that the policy was defined for, or `AuthorizationPolicyNotFoundError` is thrown.

```ts
import authorization from '@holo-js/authorization'

const allowed = await authorization.forUser(user).policy('posts').can('update', post)
```

### ability()

`authorization.forUser(actor).ability(name): { authorize, can, cannot, inspect }`

Runs a named ability with the input you pass. Each method takes the ability's input object, for example `{ report }`. Throws `AuthorizationAbilityNotFoundError` for an unknown name. See [Abilities](/authorization/abilities).

### authorization (default export)

`authorization: { forUser, guard, authorize, can, cannot, inspect }`

The default export of `@holo-js/authorization`. It holds the same functions listed above, so you can use `authorization.can(...)` or call them one at a time.

### definePolicy()

`definePolicy(name: string, target: Model, rules: { before?, class?, record? }): AuthorizationPolicyDefinition`

Defines the rules for a model. Put it in `server/policies`. `class` rules check actions on the model class, such as `create`. `record` rules check actions on one instance, such as `update`. Each rule returns `true`, `false`, or a decision. A `before(context, target)` hook runs first: returning `undefined` moves on to the rules, and returning a boolean or decision ends the check. Asking for an action with no matching rule throws an `AuthorizationError`. See [Policies](/authorization/policies).

### defineAbility()

`defineAbility(name: string, handle: (context, input) => boolean | AuthorizationDecision): AuthorizationAbilityDefinition`

Defines a rule that isn't tied to a model, such as "can export reports". Put it in `server/abilities`. The handler receives the actor context and the input you pass to `can()`.

### allow()

`allow(message?: string): AuthorizationDecision`

Returns an allowed decision with status `200`, and the optional message.

### deny()

`deny(message?: string): AuthorizationDecision`

Returns a denied decision with status `403`. The default message is "You are not authorized to perform this action."

```ts
import { allow, deny } from '@holo-js/authorization'

return post.user_id === user?.id ? allow() : deny('Only the author can edit this post.')
```

### denyAsNotFound()

`denyAsNotFound(message?: string): AuthorizationDecision`

Returns a denied decision with status `404`, for resources that a user shouldn't know exist. The default message is "Resource not found." See [Denied Responses](/authorization/errors).

### normalizeAuthorizationDecision()

`normalizeAuthorizationDecision(outcome: boolean | AuthorizationDecision | undefined, fallbackMessage?: string): AuthorizationDecision`

Converts a rule's return value into a decision. `true` becomes `allow()`, `false` becomes `deny()` with the fallback message, and anything that isn't a decision or boolean is denied.

### isAuthorizationDecision()

`isAuthorizationDecision(value: unknown): value is AuthorizationDecision`

Returns `true` when the value has a boolean `allowed` and a `status` of `200`, `403`, or `404`.

### isAuthorizationError()

`isAuthorizationError(value: unknown): value is AuthorizationError`

Returns `true` for an authorization error, meaning it has a `message` and a `decision`. Use it in a `catch` block.

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

### isAuthorizationPolicyDefinition()

`isAuthorizationPolicyDefinition(value: unknown): value is AuthorizationPolicyDefinition`

Returns `true` for a value that `definePolicy()` returned.

### isAuthorizationAbilityDefinition()

`isAuthorizationAbilityDefinition(value: unknown): value is AuthorizationAbilityDefinition`

Returns `true` for a value that `defineAbility()` returned.

### AuthorizationError

`new AuthorizationError(message: string, decision: AuthorizationDecision)`

The error thrown when a check is denied. Its `decision` has the `status` you should send back. Frameworks can turn it into a `403` or `404` response; see [Denied Responses](/authorization/errors).

### AuthorizationPolicyNotFoundError

Thrown when `policy(name)` names an unknown policy, or when the target doesn't match that policy's model.

### AuthorizationAbilityNotFoundError

Thrown when `ability(name)` names an unknown ability.

### AuthorizationGuardNotFoundError

Thrown by `guard(name)` when no auth guard has that name.

### AuthorizationAuthIntegrationMissingError

Thrown by `authorize()`, `can()`, `cannot()`, and `inspect()` when the auth package isn't set up, so there's no signed-in user to check. Use `forUser()` in that case. See [Using without Auth](/authorization/standalone).

## Next steps

- [Policies](/authorization/policies)
- [Abilities](/authorization/abilities)
- [Using with Auth](/authorization/with-auth)
- [Denied Responses (403 vs 404)](/authorization/errors)
- [Tutorial: Authorization](/tutorial/authorization)
