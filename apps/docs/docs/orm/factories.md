# Factories

A factory describes how to build a valid model with sample data. Use factories in tests and seeders to create records in one line instead of spelling out every attribute.

```ts [server/db/factories/UserFactory.ts]
import { defineFactory } from '@holo-js/db'
import User from '../../models/User'

export default defineFactory(User, ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
  role: 'member',
}))
```

```ts [tests/users.test.ts]
import UserFactory from '../server/db/factories/UserFactory'

const user = await UserFactory.createOne()
const users = await UserFactory.createMany(10)
```

## Creating a factory

Generate a factory file for a model:

```bash
npx holo make:factory User
```

This creates `server/db/factories/UserFactory.ts` that imports `server/models/User.ts`. To create a model and its factory together:

```bash
npx holo make:model User --factory
```

The callback you pass to `defineFactory()` returns the default attributes. The attribute names and value types are checked against the model's columns, so you get autocomplete and a type error for unknown columns.

### Unique values with `sequence`

The callback receives a `sequence` number that starts at 1 and goes up for each model in a batch. Use it to keep values like emails unique:

```ts
export default defineFactory(User, ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
}))
```

The callback can be `async`.

::: warning
Factories save records with the model's `create()`, so every attribute they set must be in the model's `fillable` list. To fill guarded columns, wrap the call in `User.unguarded(() => UserFactory.createOne())`.
:::

## Building and saving models

| Method | Returns | Saved |
| --- | --- | --- |
| `createOne()` | One model | Yes |
| `createMany(amount)` | An array of models | Yes |
| `makeOne()` | One model | No |
| `makeMany(amount)` | An array of models | No |
| `raw()` | The attribute object | No |

```ts
const user = await UserFactory.createOne()

const draft = await UserFactory.makeOne()
draft.exists()
// false

const attributes = await UserFactory.raw()
// { name: 'User 1', email: 'user1@example.com', role: 'member' }
```

The returned models are typed, so `user.email` autocompletes.

### Overriding attributes

Pass attributes to `createMany()` or `makeMany()` after the amount. They win over the factory's defaults:

```ts
const admins = await UserFactory.createMany(3, { role: 'admin' })
```

For a single model, the first argument of `createOne()` and `makeOne()` is the sequence number, and the second is the overrides:

```ts
const amina = await UserFactory.createOne(1, { email: 'amina@example.com' })
```

### Setting the amount with `count`

`count()` sets how many models a factory builds. `createMany()` and `makeMany()` use it when you don't pass an amount:

```ts
const users = await UserFactory.count(5).createMany()
```

`create()` and `make()` also respect `count()`. They return one model when the count is 1 and an array otherwise, so prefer the `One` and `Many` methods when you want a precise type.

## States

A state changes some of the default attributes. Pass an object, or a function that receives the current attributes:

```ts
const admin = await UserFactory.state({ role: 'admin' }).createOne()

const suspended = await UserFactory
  .state(attributes => ({ name: `${attributes.name} (suspended)`, role: 'suspended' }))
  .createOne()
```

Each call returns a new factory, so you can save common states as their own factories:

```ts [server/db/factories/UserFactory.ts]
import { defineFactory } from '@holo-js/db'
import User from '../../models/User'

const UserFactory = defineFactory(User, ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
  role: 'member',
}))

export const AdminFactory = UserFactory.state({ role: 'admin' })

export default UserFactory
```

States are applied in the order you add them, after the defaults and before any overrides.

## Sequences

`sequence()` rotates through a list of states, one per model:

```ts
const users = await UserFactory
  .sequence(
    { role: 'admin' },
    { role: 'editor' },
    { role: 'member' },
  )
  .createMany(6)
// admin, editor, member, admin, editor, member
```

An item can be a function that receives the attributes and a context with the `sequence` number:

```ts
await UserFactory
  .sequence(
    { name: 'Amina' },
    (_attributes, { sequence }) => ({ name: `Guest ${sequence}` }),
  )
  .createMany(4)
```

## Relationships

Factories can create related records for you. The second argument is the name of a relation defined on the model.

### Belongs to

`for()` sets the parent of a `belongsTo` or `morphTo` relation. Pass a factory to create a new parent, or an existing model:

```ts
const post = await PostFactory.for(UserFactory, 'author').createOne()

const amina = await User.findOrFail(1)
const posts = await PostFactory.for(amina, 'author').createMany(3)
```

Holo fills in the foreign key and sets the loaded relation, so `post.getRelation('author')` returns the parent.

### Has one and has many

`has()` creates children for a `hasOne`, `hasMany`, `morphOne`, or `morphMany` relation. Use `count()` on the child factory to set how many:

```ts
const user = await UserFactory
  .has(PostFactory.count(3), 'posts')
  .createOne()
```

### Many to many

`hasAttached()` attaches records through a `belongsToMany`, `morphToMany`, or `morphedByMany` relation. The optional third argument sets pivot columns:

```ts
const user = await UserFactory
  .hasAttached(RoleFactory.count(2), 'roles', { assigned_by: 'seeder' })
  .createOne()
```

You can also attach existing models:

```ts
const roles = await Role.all()

await UserFactory.hasAttached(roles, 'roles').createOne()
```

When you use `createOne()` or `createMany()`, models you pass to `for()` or `hasAttached()` must already be saved.

### Reusing related models

`recycle()` gives the factory existing models to use instead of creating new ones. Holo uses them wherever a relation factory needs a model from the same table:

```ts
const team = await Team.create({ name: 'Core' })

const users = await UserFactory
  .recycle(team)
  .for(TeamFactory, 'team')
  .createMany(5)
// All five users belong to the same team
```

## Callbacks

Run code after each model is built or saved with `afterMaking()` and `afterCreating()`. The callback receives the model and a context with the `sequence` number:

```ts [server/db/factories/UserFactory.ts]
import { defineFactory } from '@holo-js/db'
import Role from '../../models/Role'
import User from '../../models/User'

export default defineFactory(User, ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
})).afterCreating(async (user) => {
  const memberRole = await Role.where('name', 'member').firstOrFail()
  await user.attach('roles', [memberRole.id])
})
```

`afterMaking()` runs for `makeOne()` and `makeMany()`. `afterCreating()` runs for `createOne()` and `createMany()`. If a callback throws, the factory call rejects with that error.

To create related records, prefer `has()`, `for()`, and `hasAttached()` over callbacks. They set foreign keys for you.

## Using factories in seeders

Import factories in a [seeder](/database/seeding) to fill your local database:

```ts [server/db/seeders/DatabaseSeeder.ts]
import { defineSeeder } from '@holo-js/db'
import UserFactory from '../factories/UserFactory'
import PostFactory from '../factories/PostFactory'

export default defineSeeder({
  name: 'DatabaseSeeder',
  async run() {
    await UserFactory
      .has(PostFactory.count(5), 'posts')
      .createMany(10)
  },
})
```

## Available methods

**Define:** [defineFactory()](#definefactory)

**Configure:** [count()](#count), [getAmount()](#getamount), [state()](#state), [sequence()](#sequence), [afterMaking()](#aftermaking), [afterCreating()](#aftercreating)

**Relate:** [for()](#for), [has()](#has), [hasAttached()](#hasattached), [recycle()](#recycle)

**Build and save:** [make()](#make), [makeOne()](#makeone), [makeMany()](#makemany), [create()](#create), [createOne()](#createone), [createMany()](#createmany)

**Inspect:** [raw()](#raw)

## Method reference

### defineFactory()

Creates a factory for a model. The callback receives the `sequence` number and the model, and returns the attributes for one model.

```ts [server/db/factories/PostFactory.ts]
import { defineFactory } from '@holo-js/db'
import Post from '../../models/Post'

export default defineFactory(Post, ({ sequence }) => ({
  title: `Post ${sequence}`,
  body: 'Lorem ipsum',
}))
```

### count()

Returns a copy of the factory that builds `amount` models. With more than one model, `make()` and `create()` return an array.

```ts
const posts = await PostFactory.count(3).create()
```

### getAmount()

Returns how many models the factory builds. It's `1` unless you called `count()`.

```ts
PostFactory.count(3).getAmount()
// 3
```

### state()

Returns a copy of the factory with extra attributes applied on top of the base definition. Pass an object, or a function that receives the attributes so far and the context.

```ts
const published = await PostFactory.state({ status: 'published' }).create()

const archived = await PostFactory
  .state((attributes, { sequence }) => ({ archived_at: new Date(), position: sequence }))
  .create()
```

### sequence()

Applies a different state to each model in turn, and loops back to the first state. Pass one state per entry.

```ts
const posts = await PostFactory
  .count(4)
  .sequence({ status: 'draft' }, { status: 'published' })
  .create()
// draft, published, draft, published
```

### afterMaking()

Runs a callback for each model after it's built and before it's saved. Callbacks run in the order you add them.

```ts
const post = await PostFactory.afterMaking((post) => {
  post.set('title', `[draft] ${post.get('title')}`)
}).make()
```

### afterCreating()

Runs a callback for each model after it's saved. Use it to create records that depend on the saved model.

```ts
const user = await UserFactory
  .afterCreating(async (user) => {
    await ProfileFactory.for(user, 'user').createOne()
  })
  .createOne()
```

### for()

Sets the parent of a `belongsTo` or `morphTo` relation. Pass another factory to build a new parent, or a saved model to reuse it.

```ts
const post = await PostFactory.for(UserFactory, 'author').createOne()
```

### has()

Builds child models for a `hasOne`, `hasMany`, `morphOne`, or `morphMany` relation, once the parent is saved.

```ts
const user = await UserFactory.has(PostFactory.count(3), 'posts').createOne()
```

### hasAttached()

Attaches models through a `belongsToMany` relation after the parent is saved. Pass a factory, a model, or an array of models, and optional pivot attributes.

```ts
const user = await UserFactory
  .hasAttached(RoleFactory.count(2), 'roles', { active: true })
  .createOne()
```

### recycle()

Gives the factory existing models to reuse for relations, instead of creating new ones. Only models from the relation's table and connection are used.

```ts
const team = await Team.create({ name: 'Core' })
const users = await UserFactory.recycle(team).for(TeamFactory, 'team').createMany(5)
```

### make()

Builds models without saving them. Returns one model, or an array when `count()` is above 1.

```ts
const post = await PostFactory.make({ title: 'Draft' })
```

### makeOne()

Builds one unsaved model. Pass a sequence number to choose which entry of `sequence()` applies.

```ts
const post = await PostFactory.makeOne(1, { title: 'Draft' })
```

### makeMany()

Builds several unsaved models. The amount defaults to the factory's `count()`.

```ts
const posts = await PostFactory.makeMany(5)
```

### create()

Builds and saves models. Returns one model, or an array when `count()` is above 1.

```ts
const post = await PostFactory.create({ title: 'Hello' })
```

### createOne()

Builds and saves one model. Pass a sequence number to choose which entry of `sequence()` applies.

```ts
const post = await PostFactory.createOne(1, { title: 'Hello' })
```

### createMany()

Builds and saves several models. The amount defaults to the factory's `count()`.

```ts
const posts = await PostFactory.createMany(10)
```

### raw()

Returns the attributes the factory would use, without building or saving a model. Returns an array when `count()` is above 1.

```ts
const attributes = await PostFactory.raw({ status: 'queued' })
```

## Next steps

- [Seeding](/database/seeding)
- [Database tests](/testing/database)
- [Relationships](/orm/relationships/)
- [CLI commands](/reference/cli)
