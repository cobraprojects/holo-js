# Multiple Connections

An app can talk to more than one database. Give each one a name in `config/database.ts`, then pick a connection by name in queries, models, and transactions.

## Quick example

```ts [config/database.ts]
import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: env('DB_URL', './storage/database.sqlite'),
    },
    analytics: {
      driver: 'postgres',
      url: env('ANALYTICS_DATABASE_URL'),
    },
  },
})
```

```ts [server/lib/reports.ts]
import { DB } from '@holo-js/db'

export async function recentPageViews() {
  return DB.table('page_views', 'analytics').latest('viewed_at').limit(50).get()
}
```

Queries without a connection name use `defaultConnection`. Each driver you reference needs its package installed. See [installing a driver](/database/#install-a-driver).

## Mixing drivers

Connections are independent, so they can use different drivers. A common setup is SQLite or PostgreSQL for the app plus a separate PostgreSQL or MySQL database for reporting or a legacy system.

```ts [config/database.ts]
import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'postgres',
      url: env('DATABASE_URL'),
    },
    legacy: {
      driver: 'mysql',
      host: env('LEGACY_DB_HOST', '127.0.0.1'),
      port: env('LEGACY_DB_PORT', '3306'),
      username: env('LEGACY_DB_USERNAME', 'root'),
      password: env('LEGACY_DB_PASSWORD'),
      database: env('LEGACY_DB_DATABASE', 'legacy'),
    },
  },
})
```

Each connection has its own settings for pooling, logging, and raw SQL. Turning on `security.allowUnsafeRawSql` for `legacy` doesn't turn it on for `main`.

## Query a named connection

Pass the connection name as the second argument to `DB.table()`:

```ts
import { DB } from '@holo-js/db'

const orders = await DB.table('orders', 'legacy').where('status', 'open').get()
```

Or get the connection first with `DB.connection()`:

```ts
import { DB } from '@holo-js/db'

const legacy = DB.connection('legacy')

const customers = await legacy.table('customers').count()
const driver = legacy.getDialect().name
```

`DB.connection()` with no name returns the default connection. An unknown name throws a `ConfigurationError`.

## Point a model at a connection

Set `connectionName` when you define the model. Every query, create, update, and delete for that model then uses that connection.

```ts [server/models/PageView.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('page_views', {
  connectionName: 'analytics',
})
```

```ts
import PageView from '../models/PageView'

const views = await PageView.where('path', '/pricing').count()
```

Models without `connectionName` use the default connection.

## Transactions on a named connection

Pass the connection name after the callback:

```ts
import { DB } from '@holo-js/db'

await DB.transaction(async (tx) => {
  await tx.table('orders').where('id', orderId).update({ status: 'shipped' })
  await tx.table('order_events').insert({ order_id: orderId, type: 'shipped' })
}, 'legacy')
```

`DB.writeTransaction()`, `DB.afterCommit()`, `DB.afterRollback()`, `DB.unsafeQuery()`, and `DB.unsafeExecute()` accept a connection name in the same way. See [transactions](/database/transactions).

::: warning
A transaction covers one connection only. Writes to a different connection inside the callback are not rolled back with it.

Inside a transaction, queries and models that don't name a connection join the active transaction, even when that transaction is on a non-default connection. Models with their own `connectionName` always use that connection.
:::

## Migrations and seeders

`npx holo migrate` and `npx holo seed` run against the default connection. Inside a migration, `db` is that connection, so you can check which driver you're on:

```ts [server/db/migrations/2026_10_11_140000_create_audit_log.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema, db }) {
    await schema.createTable('audit_log', (table) => {
      table.id()
      table.string('action')
      table.timestamps()
    })

    if (db.getDialect().name === 'postgres') {
      // PostgreSQL-only setup
    }
  },
  async down({ schema }) {
    await schema.dropTable('audit_log')
  },
})
```

## Connection methods

`DB.connection()` returns a connection object. These are the methods you call on it.

### connection()

Returns the connection with the given name, or the default connection when you pass no name. An unknown name throws a `ConfigurationError`.

```ts
const legacy = DB.connection('legacy')
```

### table()

Starts a query builder on this connection. It works the same as `DB.table()` with a connection name.

```ts
const customers = await DB.connection('legacy').table('customers').count()
```

### transaction()

Runs a callback in a transaction on this connection. See [transactions](/database/transactions).

```ts
await DB.connection('legacy').transaction(async (tx) => {
  await tx.table('orders').where('id', orderId).update({ status: 'shipped' })
})
```

### getConnectionName()

Returns the name this connection was registered under.

```ts
const name = DB.connection().getConnectionName()
```

### getDriver()

Returns the driver name, such as `'sqlite'`, `'postgres'`, or `'mysql'`.

```ts
const driver = DB.connection('legacy').getDriver()
```

### getDialect()

Returns the SQL dialect object. Its `name` property identifies the database.

```ts
if (DB.connection('legacy').getDialect().name === 'mysql') {
  // MySQL-only statement
}
```

## Read and write replicas

Holo doesn't split reads and writes across replicas. Each named connection points at one database. To read from a replica, add it as its own connection and query it by name:

```ts
const report = await DB.table('orders', 'replica').where('created_at', '>', since).count()
```

## Next steps

- [Database configuration](/database/)
- [Transactions](/database/transactions)
- [Defining models](/orm/)
- [Migrations](/database/migrations)
