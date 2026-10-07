# Share Flux membership rules through the existing internals export

Flux owns shared presence membership comparison, append, and removal rules while native effects, refs, stores, and cleanup remain with each framework adapter. We chose the existing `fluxInternals` export over new root functions or a package entry point to keep the adapter integration in the established seam. Comparison behavior and generic inference are preserved: adapters remove the first matching member, while core removes all matching members.

Approved additions to `fluxInternals`, retaining its existing members:

```ts
appendPresenceMember<TMember>(
  members: readonly TMember[],
  member: TMember,
): readonly TMember[]

removePresenceMember<TMember>(
  members: readonly TMember[],
  member: TMember,
): readonly TMember[]
```

Comparison remains private. Shared rules preserve per-event membership snapshots and compatibility with custom subscriptions.
