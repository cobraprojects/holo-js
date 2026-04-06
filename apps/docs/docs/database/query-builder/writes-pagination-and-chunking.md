# Query Builder: Writes, Pagination & Chunking

This page covers writes, iteration helpers, pagination, and bulk workflows.

## Inserts

```ts
await DB.table('users').insert({
  name: 'Ava',
  email: 'ava@example.com',
  active: true,
})
```

Use `insertGetId()` when you want the generated key back immediately.

```ts
const id = await DB.table('users').insertGetId({
  name: 'Ava',
  email: 'ava@example.com',
})
```

Use direct inserts when the write is table-shaped and does not need model lifecycle behavior.

## Updates

```ts
await DB.table('users')
  .where('id', 1)
  .update({
    active: false,
    'settings->locale': 'en',
  })
```

Nested JSON updates compile per dialect.

Use the query builder update path for set-based changes or maintenance workflows. Use model entities when
casts, events, observers, or dirty tracking matter.

## Upserts

```ts
await DB.table('users').upsert(
  [
    { email: 'ops@example.com', name: 'Ops' },
    { email: 'team@example.com', name: 'Team' },
  ],
  ['email'],
  ['name']
)
```

Use upserts when the application has a natural unique key and the write should create-or-update in one
step.

## Deletes

```ts
await DB.table('users').where('banned', true).delete()
```

Set-based deletes are useful for maintenance or moderation flows where per-row model lifecycle behavior is
not required.

## Increment and decrement

```ts
await DB.table('posts')
  .where('id', 1)
  .increment('views', 1, { lastViewedAt: new Date().toISOString() })
```

## Pagination

```ts
const page = await DB.table('users')
  .orderBy('id')
  .paginate(25, { pageName: 'usersPage' })
```

Supported paginator families:

- `paginate`
- `simplePaginate`
- `cursorPaginate`
- manual paginator helpers

Use pagination for user-facing navigation. Use chunking or lazy iteration for background processing.

## Chunking

```ts
await DB.table('users')
  .orderBy('id')
  .chunk(500, async rows => {
    // process rows
  })

await DB.table('users')
  .chunkById(500, async rows => {
    // process rows
  })
```

Prefer `chunkById(...)` when the workload changes rows while processing or when stable primary-key progress
is safer than offset-based batching.

## Lazy iteration

```ts
for await (const row of DB.table('users').orderBy('id').lazy()) {
  console.log(row.email)
}
```

## Locks

```ts
const rows = await DB.table('orders')
  .where('status', 'pending')
  .lockForUpdate()
  .get()
```

Locks compile only on dialects that support them.

Use locking only inside transactions and only when concurrent writes are a real risk.
