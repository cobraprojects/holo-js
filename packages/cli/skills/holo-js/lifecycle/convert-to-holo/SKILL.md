---
name: holo-convert-to-holo
description: Convert an existing application, custom framework layer, or legacy implementation to first-party Holo-JS architecture and remove superseded code completely.
metadata:
  type: lifecycle
  source: https://docs.holo-js.com/upgrade-architecture
---

# Convert to Holo-JS

Read [upgrade architecture](https://docs.holo-js.com/upgrade-architecture), [architecture](https://docs.holo-js.com/architecture), [directory structure](https://docs.holo-js.com/directory-structure), and the focused skill for every subsystem being converted.

Read [high-risk conversion examples](../../references/conversion-examples.md) when the old application has validation registries, handwritten request types, repository wrappers, or cleanup residue.

Named files are examples unless the user explicitly limits scope to them. Treat the old wrappers and helpers as removal targets, not precedent, when they conflict with the requested Holo architecture.

## Conversion loop

1. Inventory production imports, tests, scripts, seeds, migrations, generated files, snapshots, configuration, and package dependencies for the old abstraction.
2. Map each responsibility to a public Holo package and direct documentation page.
3. Establish framework boot and request-context integration before converting feature code.
4. Convert one vertical slice through schema, handler, model or service, response, and tests.
5. Search again for old symbols, paths, configuration keys, and compatibility exports.
6. Delete superseded modules and dependencies once no supported path uses them.
7. Run package-focused tests, typechecking, linting, builds, and a final repository-wide search.

## Example: custom form action

Before, a route may parse input with a custom schema adapter, call a local repository wrapper, and reshape errors by hand.

After:

```ts
const data = await validate(request, createPostForm)
const post = await Post.create(data)
return redirect(`/posts/${post.id}`)
```

The browser binds `createPostForm` with `useForm`; the framework adapter owns validation-error transport; the route uses its native redirect API.

## No compatibility residue

Leaving test-only imports, migration-only helpers, snapshots, or compatibility exports behind is an incomplete conversion. Confirm every removed module has zero imports, including tests, seeds, scripts, and generated files.

Keep a wrapper only when it has an independent domain responsibility that no Holo API owns. Rename or reshape it so that responsibility is explicit.

## Documentation mismatch recovery

If a documented API is missing, report the mismatch. Report the documented API and installed package version. Inspect only that package's public `exports` and exported declarations. Use a public equivalent only when it preserves the documented behavior and types; otherwise stop and report the incompatibility.

## Completion check

- The new path is Holo-native from framework boundary through persistence and side effects.
- Old imports, wrappers, configuration, dependencies, snapshots, and orphaned tests are gone.
- Behavior and inferred types are verified at public boundaries.
