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
import { defineDatabaseConfig, type DatabaseLogger } from '@holo-js/db'
import { env } from '@holo-js/config'

const logger: DatabaseLogger = {
  onQuerySuccess({ connectionName, kind, durationMs, rowCount, affectedRows }) {
    console.info({ connectionName, kind, durationMs, rowCount, affectedRows })
  },
  onQueryError({ connectionName, kind, durationMs }) {
    console.error({ connectionName, kind, durationMs })
  },
}

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
      logger,
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

Use an object of `DatabaseLogger` callbacks for custom telemetry. It survives config normalization
and cached runtime boot; database config containing callbacks is reloaded from its source file.
A custom `logger` takes precedence over `logging: true` and keeps SQL and binding redaction enabled.
The existing `logging: true` console logger prints SQL and error messages when no custom logger is
provided. For content-free telemetry, select only operational fields as above: driver error objects
may contain SQL or application data even when SQL and bindings are redacted.

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
