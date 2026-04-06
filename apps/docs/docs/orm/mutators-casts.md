# ORM: Mutators / Casts

Holo-JS supports field-level casts, accessors, mutators, and serialization shaping.

## Why this layer exists

The database stores one representation. Application code often wants another.

Examples:

- booleans as real booleans
- JSON as structured objects
- enum fields as domain enums
- emails normalized before persistence
- display names derived at read time

This page is about that translation layer.

## Where this code lives

Put casts, accessors, and mutators in the model definition under `server/models`.

```text
server/models/User.ts
```

## Built-in cast families

- boolean
- json
- datetime
- timestamp
- enum
- vector

The schema still owns the database truth. Casts tell the model layer how to hydrate and serialize those
values for application code.

## Enum casts

If the backing column is an enum in the schema, define it there with:

```ts
post_status: column.enum(['draft', 'published'])
```

Then use the model cast layer only for the runtime representation you want, such as `enumCast(...)`.

Use this when the database stores a fixed string set but the application should work with a domain enum
instead of raw string literals.

## Example

```ts
const User = defineModel('users', {
  casts: {
    settings: 'json',
    status: enumCast(UserStatus),
  },
})
```

## Common cast patterns

```ts
const Account = defineModel('accounts', {
  casts: {
    active: 'boolean',
    settings: 'json',
    status: enumCast(AccountStatus),
    last_seen_at: 'datetime',
    published_at: 'timestamp',
    embedding: 'vector:1536',
  },
})
```

Use casts for the model-facing representation you want in code.

## Accessors and mutators

Accessors derive read-time values. Mutators normalize write-time values:

```ts
const User = defineModel('users', {
  accessors: {
    display_name: user => `${user.first_name} ${user.last_name}`.trim(),
  },
  mutators: {
    email: value => value.trim().toLowerCase(),
  },
})
```

Use an accessor when a value is derived and read-only. Use a mutator when every write should be normalized
before the entity is persisted.

## Query-time casts

Query-time casts are useful when one read should hydrate fields differently without changing the model
definition:

```ts
const page = await User
  .query()
  .withCasts({
    profile: 'json',
    status: enumCast(UserStatus),
  })
  .paginate(15)
```

Use this when one endpoint or export needs a different read shape than the default model behavior.

## Custom cast classes

When a string cast is not expressive enough, use a cast object or class:

```ts
const User = defineModel('users', {
  casts: {
    shipping_address: addressCast,
    balance: moneyCast,
  },
})
```

Holo-JS supports class-based custom casts, inbound-only casts, and value-object hydration where the field
should enter the application as a domain object instead of a primitive.

## Choosing the right tool

- use schema definitions for database truth
- use casts for type conversion
- use accessors for derived read-only values
- use mutators for normalization on write
- use serialization controls for presentation visibility

## Read more

- [Serialization](/orm/serialization)
- [ORM Getting Started](/orm/)
