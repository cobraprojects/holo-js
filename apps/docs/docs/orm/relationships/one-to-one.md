# Relationships: One to One

One-to-one is the right fit when exactly one related record should exist on either side of the
association. Typical examples are `User -> Profile`, `Order -> Receipt`, or `Post -> SeoEntry`.

## `hasOne`

Use `hasOne` on the parent-facing side when the related table stores the foreign key.

```ts
const User = defineModel('users', {
  relations: {
    profile: hasOne(Profile, {
      foreignKey: 'user_id',
    }),
  },
})
```

### Save or create the related model

```ts
await user.profile().createRelated({
  locale: 'en',
  timezone: 'UTC',
})
```

### Query through the relation

```ts
const profile = await user.profile().first()
```

## `belongsTo`

Use `belongsTo` on the inverse side when the current model stores the foreign key.

```ts
const Profile = defineModel('profiles', {
  relations: {
    user: belongsTo(User, {
      foreignKey: 'user_id',
    }),
  },
})
```

### Access the related model

```ts
const profile = await Profile.findOrFail(1)
const user = await profile.user
```

### Eager load the inverse

```ts
const profiles = await Profile.with('user').get()
```

### Constrain by the parent

```ts
const profiles = await Profile.whereBelongsTo(user, 'user').get()
```

### Associate and dissociate

```ts
profile.user().associate(user)
await profile.save()

profile.user().dissociate()
await profile.save()
```

## One-to-one workflow example

Use a one-to-one relation when the dependent record belongs to one parent and should not be modeled as a
collection.

```ts
const user = await User.create({
  name: 'Amina',
  email: 'amina@example.com',
})

await user.profile().createRelated({
  locale: 'en',
  timezone: 'UTC',
})
```

## Practical notes

- define `hasOne` on the parent side
- define `belongsTo` on the record that stores the foreign key
- use eager loading when the response needs both sides
- use `associate(...)` and `dissociate(...)` when the inverse side already exists
