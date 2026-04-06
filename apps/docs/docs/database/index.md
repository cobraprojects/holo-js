# Database: Getting Started

Holo-JS's database layer is built around configurable runtime setup, typed model definitions, and a fluent query
surface.

## Typical flow

Most applications follow this path:

1. configure a connection in `config/database.ts`
2. write migrations in `server/db/migrations`
3. run `bunx holo migrate`
4. let Holo-JS refresh `server/db/schema.generated.ts`
5. define models under `server/models`
6. query through `DB.table(...)` or the ORM

## Database config

Put database setup in `config/database.ts`.

```ts
import { defineDatabaseConfig, env } from '@holo-js/config'

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: './storage/database.sqlite',
    },
    analytics: {
      driver: 'postgres',
      url: env('ANALYTICS_DATABASE_URL'),
    },
  },
})
```

Use SQLite for local development or switch to MySQL and Postgres by changing the named connection
definitions.

The same application-level query and model code should stay stable while the configured database driver
changes underneath it.

## CLI workflow

For day-to-day database work, use the Holo-JS CLI:

```bash
bunx holo list
bunx holo migrate
bunx holo migrate:fresh --seed
bunx holo seed
```

`bunx holo list` shows internal database commands plus app commands auto-discovered from
`server/commands`.

## Multiple connections

One application can use more than one connection.

```ts
const events = await DB.table('audit_events', 'analytics').latest().get()
```

Models can target a named connection with `connectionName`.

## Defining models

```ts
import '../db/schema.generated'
import { defineModel } from '@holo-js/db'

export const User = defineModel('users', {
  fillable: ['name', 'email'],
})
```

Use the query builder directly for reporting, maintenance, and table-shaped responses. Use models when
the query belongs to one domain record type.

## Transactions

Transactions are explicit and context-scoped:

```ts
await DB.transaction(async (tx) => {
  await tx.table('users').insert({
    name: 'Ava',
    email: 'ava@example.com',
  })
})
```

## Continue

- [Database Commands](/database/commands)
- [Query Builder](/database/query-builder/)
- [Pagination](/database/pagination)
- [Migrations](/database/migrations)
- [Seeding](/database/seeding)
- [ORM Getting Started](/orm/)
