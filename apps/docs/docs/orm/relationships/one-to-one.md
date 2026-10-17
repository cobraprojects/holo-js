# One to One

A one-to-one relationship links a single row to a single row: a user has one profile, and a profile belongs to one user. Use `hasOne` on the side without the foreign key, and `belongsTo` on the side that holds it.

```ts [server/models/User.ts]
import { defineModel, hasOne } from '@holo-js/db'

export default defineModel('users', {
  relations: {
    profile: hasOne('Profile', { foreignKey: 'user_id' }),
  },
})
```

```ts [server/models/Profile.ts]
import { belongsTo, defineModel } from '@holo-js/db'

export default defineModel('profiles', {
  relations: {
    user: belongsTo('User', { foreignKey: 'user_id' }),
  },
})
```

```ts [server/lib/profiles.ts]
import User from '../models/User'

const user = await User.with('profile').findOrFail(1)

user.profile?.bio
```

After `with('profile')`, `user.profile` is typed as the `Profile` model or `null` when no row matches.

## Has one

`hasOne(related, foreignKey, localKey?)` says the *other* table stores a key that points back at this model.

```ts
profile: hasOne('Profile', { foreignKey: 'user_id' })

profile: hasOne('Profile', 'user_id')
```

Both lines are equivalent. `foreignKey` is the column on `profiles`. `localKey` is the column on `users` it matches, and defaults to `id`:

```ts
profile: hasOne('Profile', { foreignKey: 'user_uuid', localKey: 'uuid' })
```

## Belongs to

`belongsTo(related, foreignKey, ownerKey?)` says *this* table stores the key. Use it for the inverse of `hasOne` and `hasMany`.

```ts
user: belongsTo('User', { foreignKey: 'user_id' })

user: belongsTo('User', 'user_id')
```

`ownerKey` is the column on the related table, and defaults to `id`:

```ts
user: belongsTo('User', { foreignKey: 'user_uuid', ownerKey: 'uuid' })
```

::: tip Which side gets `belongsTo`?
Look for the foreign key column. The model whose table has `user_id` uses `belongsTo('User', ...)`. The model it points at uses `hasOne` or `hasMany`.
:::

## Reading the related model

Load the relation with `with()` when you query, or with `load()` on a model you already have:

```ts
const profile = await Profile.with('user').findOrFail(5)
profile.user?.email

const user = await User.findOrFail(1)
const loaded = await user.load('profile')
loaded.profile?.bio
```

`load()` returns the same model, typed with the new relation. See [Eager Loading and Aggregates](/orm/relationships/loading) for nested paths and constraints.

## Creating the related model

Call the relation as a method to get its write helpers. On a `hasOne`, `create()` inserts the related row with the foreign key already set:

```ts
const user = await User.findOrFail(1)

const profile = await user.profile().create({ bio: 'Writes about databases.' })
```

`save()` does the same for a model you built yourself:

```ts
import Profile from '../models/Profile'

await user.profile().save(Profile.make({ bio: 'Writes about databases.' }))
```

The parent must already be saved. Holo throws if you create a related row through an unsaved parent.

## Associating a parent

On a `belongsTo`, use `associate()` to set the foreign key from a model, and `dissociate()` to clear it. Neither saves on its own, so call `save()` afterwards:

```ts
const profile = await Profile.findOrFail(5)
const user = await User.findOrFail(1)

profile.user().associate(user)
await profile.save()

profile.user().dissociate()
await profile.save()
```

`associate()` throws if the parent model hasn't been saved yet, because there's no key to copy.

## Querying by the relation

All relation filters work on one-to-one relations:

```ts
const usersWithProfiles = await User.has('profile').get()

const designers = await User.whereRelation('profile', 'job_title', 'Designer').get()

const profilesOfUser = await Profile.whereBelongsTo(user).get()
```

See [Querying by relationship](/orm/relationships/#querying-by-relationship) for the full list.

## Next steps

- [One to Many](/orm/relationships/one-to-many)
- [Eager Loading and Aggregates](/orm/relationships/loading)
- [Creating and Updating](/orm/writes)
