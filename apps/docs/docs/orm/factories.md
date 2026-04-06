# ORM: Factories

Factories create valid model graphs for tests, seeders, demos, and operational scripts. Define a correct
default state once, then layer states, sequences, callbacks, and related graphs on top.

## Introduction

Factories are the fastest way to create realistic application data without hand-wiring every attribute and
foreign key in each test or setup script.

## Defining Model Factories

Put factory files under `server/db/factories`.

Use `holo make:factory UserFactory` to scaffold the file quickly.

```text
server/db/factories/UserFactory.ts
```

```ts
const UserFactory = defineFactory(User, ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
  active: true,
}))
```

The callback should return a valid baseline model state.

### Factory States

States describe named variations:

```ts
const UserFactory = defineFactory(User, ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
})).state('inactive', () => ({
  active: false,
}))
```

### Factory Callbacks

Factories can run work after instantiation and after persistence:

```ts
const UserFactory = defineFactory(User, () => ({
  name: 'Operations User',
})).afterCreate(async user => {
  await user.profile().createRelated({
    locale: 'en',
    timezone: 'UTC',
  })
})
```

## Creating Models Using Factories

Factories are called explicitly by your server-side code. They do not run on their own.

Typical places to call them:

- test setup
- seeders
- local scripts
- dev-only bootstrap flows

### Instantiating Models

`make()` builds an entity without inserting it.

### Persisting Models

```ts
const user = await UserFactory.create()
const draft = await PostFactory.make()
const users = await UserFactory.count(10).createMany()
```

- `create()` persists a model
- `makeMany()` and `createMany()` create batches
- `count(...)` turns the factory into a multi-record plan

### Sequences

Sequences are useful when a batch should rotate values deliberately:

```ts
await UserFactory.sequence(
  { locale: 'en' },
  { locale: 'ar' },
  { locale: 'fr' },
).count(9).createMany()
```

## Factory Relationships

### Has Many Relationships

```ts
await UserFactory
  .has(PostFactory.count(3), 'posts')
  .create()
```

### Belongs To Relationships

```ts
await PostFactory
  .for(UserFactory.state('inactive'), 'author')
  .create()
```

### Many to Many Relationships

```ts
await UserFactory
  .hasAttached(RoleFactory.count(2), { expiresAt: '2026-12-31T00:00:00.000Z' }, 'roles')
  .create()
```

### Polymorphic Relationships

`for(...)`, `has(...)`, and `hasAttached(...)` all support the matching polymorphic relation kinds where
the relation definition allows them.

### Defining Relationships Within Factories

The main helpers are:

- `for(...)` for `belongsTo` and `morphTo`
- `has(...)` for one-to-one and one-to-many
- `hasAttached(...)` for many-to-many and morph pivot relations

### Recycling an Existing Model for Relationships

`recycle(...)` reuses an existing model as the related parent or target when a batch should stay anchored
to one record.

## Read More

- [Seeding](/database/seeding)
- [ORM Getting Started](/orm/)
