# Database: Getting Started

Holo-JS's database layer is built around configurable runtime setup, typed model definitions, and a fluent query
surface.

## Typical flow

Most applications follow this path:

1. configure a connection in `config/database.ts`
2. write migrations in `server/db/migrations`
3. run `npx holo migrate`
4. let Holo-JS refresh the internal generated schema metadata under `.holo-js/generated`
5. define models under `server/models`
6. query through `DB.table(...)` or the ORM

## Database config

Put database setup in `config/database.ts`.

```ts
import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'
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

For bounded PostgreSQL pools and operational telemetry, configure the connection directly:

```ts
import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'

export default defineDatabaseConfig({
  connections: {
    main: {
      driver: 'postgres',
      url: env('DATABASE_URL'),
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      application_name: 'my-app',
      concurrency: { maxConcurrentQueries: 4, queueLimit: 32 },
      logging: true,
    },
  },
})
```

The PostgreSQL options use native `pg.PoolConfig` names and work with both `url` and
structured host/port credentials. `max` must be a positive integer; the timeout values must be
nonnegative integers in milliseconds. A timeout of zero disables that timeout. Budgets apply
per named connection and per process, so account for all application processes when sizing pools.

`concurrency` accepts `maxConcurrentQueries`, `queueLimit`, and `workerThreads`. It controls Holo's
query scheduler separately from PostgreSQL's pool. A zero queue limit rejects additional queries
when all scheduler slots are occupied. Transactions can hold pool connections for their full lifetime.

`logging: true` enables the built-in operational logger. It records query success/failure, connection
name, scope, duration, row or affected-row counts, and transaction outcomes. It omits SQL, bindings,
raw error messages, and savepoint names by default.

To explicitly enable SQL debugging for a connection:

```ts
{
  driver: 'postgres',
  url: env('DATABASE_URL'),
  logging: true,
  security: { debugSqlInLogs: true },
}
```

SQL debugging adds statement text to query success and failure logs. SQL can contain sensitive
literals, so enable it only when appropriate. Bindings and raw error messages remain omitted.
Logging is disabled when `logging` is false or absent, including when SQL debugging is enabled.

For specialized telemetry or a different logging destination, optionally provide a `logger` object:

```ts
import { type DatabaseLogger } from '@holo-js/db'

const logger: DatabaseLogger = {
  onQuerySuccess({ connectionName, kind, durationMs, rowCount }) {
    console.info({ connectionName, kind, durationMs, rowCount })
  },
}
```

Set `logger` on the connection config. It takes precedence over `logging: true` and survives
normalization and cached runtime boot; database config containing callbacks is reloaded from its
source file. SQL and bindings supplied to custom callbacks are redacted by default. The explicit
`security.debugSqlInLogs` setting also controls SQL redaction for custom callbacks. Custom callbacks
receive error objects that may contain sensitive data; select operational fields for safe telemetry.

Use SQLite for local development or switch to MySQL and Postgres by changing the named connection
definitions.

Install every concrete driver referenced by the configuration:

```bash
bun add @holo-js/db-sqlite
# or: bun add @holo-js/db-postgres
# or: bun add @holo-js/db-mysql
```

When constructing an adapter directly, import it from its concrete package:

```ts
import { createPostgresAdapter } from '@holo-js/db-postgres'

const adapter = createPostgresAdapter({
  connectionString: process.env.DATABASE_URL,
})
```

The MySQL adapter also accepts an existing `mysql2/promise` connection:

```ts
import { createConnection } from 'mysql2/promise'
import { createMySQLAdapter } from '@holo-js/db-mysql'

const client = await createConnection(process.env.DATABASE_URL!)
const adapter = createMySQLAdapter({ client })
```

The adapter owns the injected client's lifecycle and closes it when disconnected. Transactions sharing
that client run serially; use a pool when independent transactions need to overlap.

The same application-level query and model code should stay stable while the configured database driver
changes underneath it.

## CLI workflow

For day-to-day database work, use the Holo-JS CLI:

```bash
npx holo list
npx holo migrate
npx holo migrate:fresh --seed
npx holo seed
```

`npx holo list` shows internal database commands plus app commands auto-discovered from
`server/commands`.

## Multiple connections

One application can use more than one connection.

```ts
const events = await DB.table('audit_events', 'analytics').latest().get()
```

Models can target a named connection with `connectionName`.

## Defining models

```ts
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
