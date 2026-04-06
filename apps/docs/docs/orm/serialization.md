# ORM: Serialization

Serialization controls how entities and loaded relations become JSON.

## When serialization matters

This matters whenever a model leaves the data layer and becomes an application response:

- API responses
- queue payloads
- audit events
- cached view models

Serialization decides what leaves the model boundary and how much of the loaded relation graph comes with
it.

## Common controls

- `makeHidden`
- `makeVisible`
- `setHidden`
- `setVisible`
- `append`
- `setAppends`
- `withoutAppends`

## Example

```ts
const user = await User.findOrFail(1)

user.append('display_name')
user.makeHidden('internalNotes')

return user.toJSON()
```

## Loaded relations serialize recursively

```ts
const user = await User
  .with('profile', 'roles')
  .findOrFail(1)

return user.toJSON()
```

Loaded relations are included recursively, which makes eager loading and serialization strategy tightly
connected. If the relation should be present in the payload, load it intentionally.

## Appends and presentation fields

Use appends for derived fields that belong in the JSON contract:

```ts
const user = await User.findOrFail(1)

user.setAppends(['display_name', 'avatar_url'])
```

When the response should be leaner, call `withoutAppends()` or adjust visibility for that specific
response shape.

## Date formatting

Models can customize date serialization through `serializeDate(...)`.

## A practical response workflow

1. query the model with the relations you actually want in the payload
2. append derived fields if the client expects them
3. hide private fields for that response shape
4. return `toJSON()`

That keeps transport concerns explicit without forcing every API shape into the model's global defaults.

## Read more

- [Mutators / Casts](/orm/mutators-casts)
- [ORM Getting Started](/orm/)
