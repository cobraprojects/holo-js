# Authorization

Authorization is Holo's package for deciding what an authenticated or explicit actor may do.

Install it when your application needs policy checks, ability checks, or typed authorization decisions:

```bash
bunx holo install authorization
```

The package is optional and can be used without `@holo-js/auth`. When auth is installed, Holo wires the current
actor into the top-level helpers and named guard helpers. Without auth, use explicit actors with
`authorization.forUser(...)`.

## What authorization owns

The `@holo-js/authorization` package owns:

- policy definitions through `definePolicy(...)`
- ability definitions through `defineAbility(...)`
- authorization decisions through `authorize(...)`, `can(...)`, `cannot(...)`, and `inspect(...)`
- explicit actor flows through `authorization.forUser(user)`
- typed policy names, ability names, action names, and ability inputs
- `403` and `404` denial results

It does not own current-user resolution or guard management. Those still belong to `@holo-js/auth`.

## The two usage modes

Authorization works in two modes:

- standalone mode, where you pass the actor explicitly
- auth-integrated mode, where Holo resolves the current actor from the installed auth guard

Standalone mode always works:

```ts
import authorization from '@holo-js/authorization'

const canEdit = await authorization.forUser({ id: 'user-1' }).can('update', post)
```

Auth-integrated mode is available only when `@holo-js/auth` is installed:

```ts
import { can, authorize } from '@holo-js/authorization'

await authorize('update', post)
const allowed = await can('view', post)
```

## Why policies and abilities are separate

Policies are for resource-shaped authorization. They usually answer questions like:

- can this user create this model?
- can this user update this record?
- can this user delete this record?

Abilities are for non-resource actions. They answer questions like:

- can this user export a report?
- can this user publish a dashboard snapshot?
- can this user perform a named business action?

That split keeps the public API small and keeps inference precise.

## Install and scaffold

The CLI can install authorization into an existing project and scaffold the folders Holo discovers:

- `server/policies`
- `server/abilities`

New projects can enable it during `holo new` with `--package authorization`.

## Continue

- [Policies](/authorization/policies)
- [Abilities](/authorization/abilities)
- [Standalone Mode](/authorization/standalone-mode)
- [Auth Integration](/authorization/auth-integrated-mode)
- [Jobs And Tests](/authorization/jobs-and-tests)
- [403 Vs 404](/authorization/errors)
