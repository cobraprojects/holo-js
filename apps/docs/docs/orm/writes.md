# ORM Writes

Use model writes when the application is working with domain records instead of raw tables.

This page covers:

- `create(...)`
- `make(...)` + `save()`
- `update(...)`
- `saveMany(...)`
- unique slug fields
- mass assignment with `fillable` and `guarded`
- trusted bypasses with `unguarded(...)` and `forceFill(...)`

## Creating Records

Use `create(...)` when you want to persist a new model in one step.

```ts
const user = await User.create({
  name: 'Amina',
  email: 'amina@example.com',
})
```

This is the most common pattern in:

- route handlers
- server services
- jobs
- seeders

## Making Then Saving

Use `make(...)` when you want an entity instance first, then decide when to persist it.

```ts
const user = User.make({
  name: 'Amina',
  email: 'amina@example.com',
})

user.set('status', 'active')

await user.save()
```

Use this form when:

- extra attributes need to be set before persistence
- you want dirty tracking before save
- the entity should go through a longer application workflow first

## Updating Records

Update a loaded entity when you are changing one record:

```ts
const user = await User.findOrFail(1)

await user.update({
  name: 'Amina Hassan',
})
```

You can still mutate attributes and save explicitly when the workflow needs intermediate steps:

```ts
const user = await User.findOrFail(1)

user.set('name', 'Amina Hassan')

await user.save()
```

Update several rows through a model query:

```ts
await Post
  .where('status', 'draft')
  .update({
    status: 'published',
    published_at: new Date(),
  })
```

## Unique Slug Fields

Use `uniqueSlug(...)` when a model needs a readable unique slug. The helper is typed from the model,
checks the existing rows for the target column, and returns the next available value.

```ts
import { uniqueSlug } from '@holo-js/db'
import Post from '../models/Post'

const post = await Post.create({
  title: input.title,
  slug: await uniqueSlug(Post, input.title),
  body: input.body,
})
```

On update, pass the current primary key with `ignore` so the row can keep its own slug:

```ts
const post = await Post.findOrFail(id)

await post.update({
  title: input.title,
  slug: await uniqueSlug(Post, input.title, { ignore: id }),
})
```

By default `uniqueSlug(...)` writes for the model's `slug` column. If the model uses another string
column, pass `column`; TypeScript infers the allowed column names from the model:

```ts
await uniqueSlug(Post, input.title, { column: 'public_slug' })
```

You can also change the separator or fallback base:

```ts
await uniqueSlug(Post, input.title, {
  separator: '_',
  fallback: 'post',
})
```

## Mass Assignment

Mass assignment controls which attributes are writable through `create(...)`, `update(...)`, and query-driven model updates.

### Allowlist Writes With `fillable`

```ts
export default defineModel('users', {
  fillable: ['name', 'email'],
})
```

With this model:

```ts
await User.create({
  name: 'Amina',
  email: 'amina@example.com',
})
```

works, but:

```ts
await User.create({
  role: 'admin',
})
```

fails because `role` is not writable.

### Block Specific Attributes With `guarded`

```ts
export default defineModel('users', {
  fillable: ['name', 'email', 'role'],
  guarded: ['role'],
})
```

Use this when a field exists on the model but should never be mass assigned from ordinary application input.

### Explicitly Block All Mass Assignment

```ts
export default defineModel('users', {
  fillable: [],
})
```

An explicit empty `fillable` array means no attribute is mass assignable.

That blocks:

```ts
await User.create({
  name: 'Amina',
})
```

until the write goes through a trusted path.

### Open Models

If `fillable` is omitted, Holo-JS falls back to the open-model behavior and only `guarded` restrictions apply.

Use that only when the model is not being written from broad request input.

## Trusted Write Paths

Sometimes application code needs to write internal fields that should not be mass assignable from normal input.

### `unguarded(...)`

Use `unguarded(...)` for a narrow trusted block:

```ts
await User.unguarded(() => User.create({
  name: 'Root',
  role: 'admin',
}))
```

Keep this scoped and explicit. It is for framework-internal or highly trusted application paths.

### `forceFill(...)`

Use `forceFill(...)` on an entity when you need a trusted assignment on that one instance:

```ts
const user = User.make({
  name: 'Amina',
})

user.forceFill({
  role: 'admin',
})

await user.save()
```

This is useful when:

- a record starts from normal writable input
- one or two protected fields are added by trusted server logic
- you do not want to disable guards for the whole callback

## Recommended Pattern

For route input:

```ts
export default defineModel('users', {
  fillable: ['name', 'email'],
})
```

```ts
const user = await User.create({
  name: body.name,
  email: body.email,
})
```

For internal server-side fields:

```ts
const user = User.make({
  name: body.name,
  email: body.email,
})

user.forceFill({
  role: 'member',
})

await user.save()
```

That keeps request-facing input narrow without blocking trusted application logic.
