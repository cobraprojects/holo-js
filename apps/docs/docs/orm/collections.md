# ORM: Collections

Model queries return model-aware collections that preserve ORM workflows after the query is complete.

## When you get a model collection

A collection is returned when a model query yields many rows:

```ts
const users = await User.where('active', true).get()
```

This is not just a plain array. It is the ORM-aware result wrapper for multiple models.

## Why model-aware collections matter

A plain array would lose too much context after the query finishes. Holo-JS collections keep enough model
knowledge to continue relationship loading, visibility shaping, and follow-up querying without rebuilding
that context manually.

Use them when the result set still needs model behavior after retrieval.

## Common helpers

- `modelKeys()`
- `toQuery()`
- `load()`
- `loadMissing()`
- `loadCount()`
- `loadExists()`
- `loadSum()`
- `loadAvg()`
- `fresh()`
- `append()`
- visibility controls

## Continue working with the same record set

```ts
const users = await User.where('active', true).get()

const refreshed = await users
  .toQuery()
  .with('posts')
  .latest()
  .get()
```

`toQuery()` is the bridge back to the query layer when the collection already represents the set you want
to keep operating on.

## Load relation data across the whole collection

Collections can batch-load relations and aggregates after the initial query:

```ts
const users = await User.latest().take(25).get()

await users.load('profile', 'roles')
await users.loadCount('posts')
await users.loadSum('payments', 'amount')
```

That keeps the common "query first, then enrich" workflow efficient and readable.

## Shape JSON output across the whole set

The same visibility and append helpers available on one entity also work across collections:

```ts
const users = await User.with('profile').get()

users.append('display_name')
users.makeHidden('internalNotes')
```

Use those collection helpers when an API response or export should expose a different shape without
changing the model's global defaults.

## When to use a collection helper instead of another query

Use collection helpers when:

- you already have the models
- you want to enrich or reshape that exact set
- you do not want to rebuild the selection logic

If you actually need a different record set, go back to a fresh query instead.

## Read more

[ORM Getting Started](/orm/)
