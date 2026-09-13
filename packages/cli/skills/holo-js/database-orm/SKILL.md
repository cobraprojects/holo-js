---
name: holo-database-orm
description: Implement Holo-JS tables, migrations, models, queries, scopes, relations, observers, factories, pagination, serialization, and transactions.
metadata:
  type: focused
  source: https://docs.holo-js.com/orm/
---

# Database and ORM

Use [database](https://docs.holo-js.com/database/), [ORM](https://docs.holo-js.com/orm/), [relationships](https://docs.holo-js.com/orm/relationships), [writes](https://docs.holo-js.com/orm/writes), [factories](https://docs.holo-js.com/orm/factories), and [transactions](https://docs.holo-js.com/database/transactions) as the authoritative guides.

## Choose the right layer

- Schema and migrations define persisted structure.
- Models define domain-facing records, relations, scopes, casts, serialization, and lifecycle behavior.
- Repositories and query builders perform reads and writes.
- Transactions own atomic multi-write workflows.
- Observers react to model lifecycle events; domain events communicate completed business facts.

```ts
export const Post = defineModel('posts', {
  fillable: ['title', 'body', 'status'],
  scopes: {
    published: query => query.where('status', 'published'),
  },
})

const posts = await Post.published()
  .with('author')
  .orderBy('publishedAt', 'desc')
  .paginate(20)
```

## Observers

Use observers for reusable model lifecycle concerns such as normalization, derived fields, audit records, and cleanup. Keep the observer registered at application boot, make ordering explicit, and avoid hidden network work in pre-write hooks.

Use an after-commit domain event instead when other subsystems should respond only after the transaction is durable.

## Inference and safety

- Let `defineTable()` carry select and insert types into `defineModel()` and `repository()`.
- Column arguments to `where`, `orderBy`, `select`, and `create` must retain autocomplete.
- Never cast around a missing column, relation, or scope.
- Use fillable or guarded model configuration and validate before mass assignment.
- Avoid N+1 reads by eager-loading documented relations.

## Completion check

- Migration, table, model, and relation definitions agree.
- Queries use public ORM APIs and retain concrete result types.
- Atomic workflows are transaction-bound and dependent events dispatch after commit.
- Tests exercise observable model behavior, relation loading, rollback, and observer effects.
