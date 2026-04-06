# Relationships: Many to Many

Many-to-many relationships use pivot tables and relation helpers for attach, sync, toggle, and pivot
updates.

This is the right shape when neither side can own the foreign key directly. Users and roles, posts and
tags, teams and projects usually belong here.

## When to use it

Use a many-to-many relation when:

- one user can have many roles
- one role can belong to many users
- one post can have many tags
- one tag can belong to many posts

If one side owns the foreign key directly, use `hasMany` / `belongsTo` instead.

## Where the code lives

Define the relation in `server/models` and create the pivot table through a migration.

```text
server/db/migrations/2026_03_29_120000_create_role_user_table.ts
server/models/User.ts
server/models/Role.ts
```

## Define the relationship

```ts
const User = defineModel('users', {
  relations: {
    roles: belongsToMany(() => Role, {
      pivotTable: 'role_user',
      foreignPivotKey: 'user_id',
      relatedPivotKey: 'role_id',
    }),
  },
})
```

## Load related models

```ts
const users = await User.with('roles').get()
```

## Attach and detach

```ts
await user.roles().attach(roleId)
await user.roles().detach(roleId)
```

Use `attach(...)` / `detach(...)` for small targeted changes. Use `sync(...)` when the requested set
should become the source of truth.

## Sync

```ts
await user.roles().sync([1, 2, 3])
await user.roles().syncWithoutDetaching([3, 4])
await user.roles().toggle([4, 5])
```

## Attach with pivot data

```ts
await user.roles().attach(roleId, {
  expires_at: '2026-12-31T00:00:00.000Z',
})
```

## Update pivot data

```ts
await user.roles().updateExistingPivot(roleId, {
  expires_at: '2026-12-31T00:00:00.000Z',
})
```

## Query through the relationship

```ts
const roles = await user.roles().orderBy('name').get()
```

## Practical notes

- many-to-many helpers stay on the relation object, not the model itself
- morph pivot relationships use the same family of helpers, with polymorphic metadata underneath
- use `withCount('roles')` or `loadCount('roles')` when you only need counts
