# Database: Getting Started

Holo-JS gives your app a database layer that works the same on SQLite, PostgreSQL, and MySQL. You configure connections once in `config/database.ts`, then query through the `DB` facade, the [query builder](/database/query-builder/), or [models](/orm/).

## Quick example

```ts [config/database.ts]
import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'

export default defineDatabaseConfig({
  defaultConnection: env('DB_CONNECTION', 'main'),
  connections: {
    main: {
      driver: env('DB_DRIVER', 'sqlite'),
      url: env('DB_URL', './storage/database.sqlite'),
    },
  },
})
```

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'

export async function latestPosts() {
  return DB.table('posts')
    .where('status', 'published')
    .latest('published_at')
    .limit(10)
    .get()
}
```

Holo connects when your app boots. You don't open or close connections yourself.

## Install a driver

Each database has its own driver package. Install the one your connections use:

| Database | Package |
| --- | --- |
| SQLite | `@holo-js/db-sqlite` |
| PostgreSQL | `@holo-js/db-postgres` |
| MySQL | `@holo-js/db-mysql` |

```bash
npm install @holo-js/db-postgres
```

New projects created with `create holo-js` already include the driver you picked. If you add a connection for a second database, install that driver too.

## Configure a connection

Connections live under `connections`, keyed by a name you choose. `defaultConnection` picks the one used when you don't name one. If you leave it out, Holo uses the first connection in the list.

### SQLite

Point `url` at a file path. `:memory:` gives you an in-memory database.

```ts [config/database.ts]
import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'

export default defineDatabaseConfig({
  connections: {
    main: {
      driver: 'sqlite',
      url: env('DB_URL', './storage/database.sqlite'),
    },
  },
})
```

### PostgreSQL and MySQL

Use either a connection URL or separate host settings. You can also set `ssl` next to a URL. It adds TLS settings to the URL. The URL's own `ssl` parameter takes precedence over the setting, and `ssl: false` doesn't disable TLS that the URL requests.

```ts [config/database.ts]
import { defineDatabaseConfig } from '@holo-js/db'
import { env } from '@holo-js/config'

export default defineDatabaseConfig({
  defaultConnection: env('DB_CONNECTION', 'main'),
  connections: {
    main: {
      driver: env('DB_DRIVER', 'postgres'),
      host: env('DB_HOST', '127.0.0.1'),
      port: env('DB_PORT', '5432'),
      username: env('DB_USERNAME', 'postgres'),
      password: env('DB_PASSWORD'),
      database: env('DB_DATABASE', 'my_app'),
      schema: env('DB_SCHEMA', 'public'),
    },
  },
})
```

With a URL instead:

```ts
main: {
  driver: 'mysql',
  url: env('DATABASE_URL'),
},
```

### MySQL dates and time zones

MySQL reads and writes `date`, `datetime`, and `timestamp` values in `app.timezone`, as PostgreSQL does. Holo sets each connection's session time zone to `app.timezone`. MySQL needs its time zone tables loaded for any zone other than `UTC`:

```sh
mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql
```

Without the tables, queries fail, and the reason is reported through `exceptions.report`.

A `Date` value is written as wall-clock time in `app.timezone`, and a `date` reads back as a `Date` at midnight in that zone. In the hour that repeats when clocks fall back, a `timestamp` stored at the later instant reads back an hour early, because MySQL shows both instants with the same wall-clock time. To receive the stored strings instead, set `dateStrings` or `typeCast: false` on the connection. The strings are already in `app.timezone`, and `Date` values are still written in it.

Objects you pass to `createMySQLAdapter()` as `client`, `pool`, or `createPool` are used as they are. Holo doesn't convert their dates or set their session time zone, so set their `time_zone` and date options yourself.

### Driver detection

If you leave out `driver`, Holo guesses it from `url`:

- `postgres://` or `postgresql://` → PostgreSQL
- `mysql://` or `mysql2://` → MySQL
- `:memory:`, `file:`, a path starting with `/`, `./`, or `../`, or a file ending in `.db`, `.sqlite`, or `.sqlite3` → SQLite

You can also write a connection as just a URL string:

```ts
connections: {
  main: './storage/database.sqlite',
  analytics: 'postgres://app@127.0.0.1:5432/analytics',
},
```

When you use `host`, `port`, `username`, `password`, or `ssl` without a `url`, you must set `driver`.

## PostgreSQL pool settings

PostgreSQL connections use a connection pool. New PostgreSQL projects get these settings in `config/database.ts`:

```ts [config/database.ts]
main: {
  driver: 'postgres',
  url: env('DATABASE_URL'),
  max: env('DB_POOL_MAX', 4),
  connectionTimeoutMillis: env('DB_CONNECTION_TIMEOUT_MS', 5000),
  idleTimeoutMillis: env('DB_IDLE_TIMEOUT_MS', 30000),
  application_name: 'my-app',
  concurrency: {
    maxConcurrentQueries: env('DB_MAX_CONCURRENT_QUERIES', 4),
    queueLimit: env('DB_QUERY_QUEUE_LIMIT', 32),
  },
},
```

- `max` is the pool size. It must be at least `1`.
- `connectionTimeoutMillis` is how long to wait for a free pool connection. It is not a query timeout. `0` disables it.
- `idleTimeoutMillis` closes idle pool connections after this long. `0` disables it.
- `concurrency.maxConcurrentQueries` caps how many queries Holo runs at once on this connection.
- `concurrency.queueLimit` caps how many queries wait for a slot. Extra queries are rejected. `0` means no waiting.

::: warning
These limits apply per connection, per process. If you run four app processes with `max: 4`, the database sees up to 16 connections. Size the pool against your database's connection limit.
:::

## Logging queries

Set `logging: true` to log every query and transaction to the console. Logs include the connection name, duration, and row counts. SQL text and bindings are left out by default.

```ts
main: {
  driver: 'postgres',
  url: env('DATABASE_URL'),
  logging: true,
},
```

To include the SQL text while debugging, add `security.debugSqlInLogs`:

```ts
main: {
  driver: 'postgres',
  url: env('DATABASE_URL'),
  logging: true,
  security: { debugSqlInLogs: true },
},
```

Bindings are never logged. SQL text can still contain sensitive literals, so turn this off in production.

### Custom logger

Pass a `logger` object to send query events somewhere else. It replaces the built-in console logger.

```ts [config/database.ts]
import { defineDatabaseConfig, type DatabaseLogger } from '@holo-js/db'
import { env } from '@holo-js/config'

const logger: DatabaseLogger = {
  onQuerySuccess({ connectionName, kind, durationMs, rowCount }) {
    console.info({ connectionName, kind, durationMs, rowCount })
  },
  onQueryError({ connectionName, durationMs }) {
    console.error({ connectionName, durationMs })
  },
}

export default defineDatabaseConfig({
  connections: {
    main: { driver: 'postgres', url: env('DATABASE_URL'), logger },
  },
})
```

Available hooks: `onQueryStart`, `onQuerySuccess`, `onQueryError`, `onTransactionStart`, `onTransactionCommit`, `onTransactionRollback`, `onMigrationStart`, `onMigrationSuccess`, `onMigrationError`, `onSeederStart`, `onSeederSuccess`, and `onSeederError`. The `sql` field is redacted unless `security.debugSqlInLogs` is on. A hook can run its own queries on the same connection. Queries a hook runs don't trigger the query hooks again. A slow `onQueryStart` still delays the query it observes.

Inside a transaction, a query logger hook must not await queries started outside that transaction. The transaction holds its connection until the hook returns, so a hook that waits for an outside query waits forever. Keep hooks inside a transaction to logging, or to queries issued through the transaction itself.

## The DB facade

Import `DB` from `@holo-js/db` anywhere on the server. It is the entry point for every query that isn't a model.

```ts
import { DB } from '@holo-js/db'

const users = await DB.table('users').where('active', true).get()
const count = await DB.table('posts').count()
await DB.table('posts').where('id', 42).update({ status: 'archived' })
```

The [query builder](/database/query-builder/) pages cover every table method. For queries tied to one record type, use [models](/orm/) instead.

### connection()

Returns the `DatabaseContext` for a named connection, or the default connection when you pass no name. Inside a transaction, it returns the transaction's connection when the name matches (or no name is given).

```ts
const analytics = DB.connection('analytics')
const views = await analytics.table('page_views').count()
```

An unknown name throws a `ConfigurationError`. See [multiple connections](/database/connections).

### table()

Starts a [query builder](/database/query-builder/) for a table. Pass a table name, or a generated table definition for typed columns. The optional second argument picks the connection.

```ts
const posts = await DB.table('posts', 'main').where('status', 'published').get()
```

### raw()

Builds a raw SQL statement without running it. Pass the SQL, an array of bindings, and an optional `source` label used in logs. Run the result with `unsafeQuery()` or `unsafeExecute()`. See [raw SQL](#raw-sql).

```ts
const statement = DB.raw('select count(*) as total from users where active = ?', [true])
```

### transaction()

Runs a callback in a transaction and commits when it resolves, or rolls back when it throws. Nested calls create savepoints. See [transactions](/database/transactions).

```ts
const order = await DB.transaction(async () => {
  return Order.create({ user_id: userId, total: 40 })
})
```

### writeTransaction()

Same as `transaction()`, but on SQLite it takes the write lock as soon as the transaction starts. Use it for read-then-write work. See [write transactions on SQLite](/database/transactions#write-transactions-on-sqlite).

```ts
await DB.writeTransaction(async (tx) => {
  await tx.table('products').where('id', productId).update({ stock: 9 })
})
```

### afterCommit()

Registers a callback that runs after the current outermost transaction commits. It throws a `TransactionError` when called outside a transaction. See [run code after commit](/database/transactions#run-code-after-commit).

```ts
await DB.transaction(async () => {
  const user = await User.create({ name: 'Ava', email: 'ava@example.com' })
  DB.afterCommit(() => sendWelcomeEmail(user.email))
})
```

### afterRollback()

Registers a callback that runs if the current transaction rolls back. It throws a `TransactionError` when called outside a transaction.

```ts
await DB.transaction(async () => {
  DB.afterRollback(() => deleteUploadedFile(uploadedPath))
  throw new Error('Payment failed')
}).catch(() => undefined)
```

### unsafeQuery()

Runs a raw statement built with `DB.raw()` and returns `rows` and `rowCount`. It needs `security.allowUnsafeRawSql` on the connection. Pass a connection name and options as the second and third arguments.

```ts
const result = await DB.unsafeQuery<{ id: number }>(
  DB.raw('select id from posts where views > ?', [1000]),
)
```

### unsafeExecute()

Runs a raw statement that doesn't return rows, such as an update. It returns `affectedRows` and, where the driver reports it, `lastInsertId`. It needs `security.allowUnsafeRawSql` on the connection.

```ts
const { affectedRows } = await DB.unsafeExecute(
  DB.raw('update posts set views = views + 1 where id = ?', [postId]),
)
```

## Generate IDs

Holo exports three ID generators from `@holo-js/db`. Use them when you need an ID before you insert a row, such as for a file name or a public token.

### generateUuidV7()

Returns a time-ordered UUID v7 string.

```ts
import { generateUuidV7 } from '@holo-js/db'

const token = generateUuidV7()
```

### generateUlid()

Returns a ULID string. Values generated in the same process sort in creation order.

```ts
import { generateUlid } from '@holo-js/db'

const orderRef = generateUlid()
```

### generateSnowflake()

Returns a Snowflake ID as a string. It combines the current time, a fixed node ID, and a sequence counter, so IDs created in one process are unique and increasing.

```ts
import { generateSnowflake } from '@holo-js/db'

const eventId = generateSnowflake()
```

## Raw SQL

Most apps never need raw SQL. When you do, it is disabled by default and you have to opt in per connection:

```ts [config/database.ts]
main: {
  driver: 'postgres',
  url: env('DATABASE_URL'),
  security: { allowUnsafeRawSql: true },
},
```

Then build a statement with `DB.raw()` and run it:

```ts
import { DB } from '@holo-js/db'

const result = await DB.unsafeQuery<{ id: number, email: string }>(
  DB.raw('select id, email from users where created_at > ?', [since]),
)

result.rows
result.rowCount
```

Use `DB.unsafeExecute()` for statements that don't return rows. It returns `affectedRows` and, where the driver reports it, `lastInsertId`.

```ts
const { affectedRows } = await DB.unsafeExecute(
  DB.raw('update posts set views = views + 1 where id = ?', [postId]),
)
```

`unsafeSql()` builds the same statement and is handy where you don't need the facade:

```ts
import { unsafeSql } from '@holo-js/db'

const statement = unsafeSql('select count(*) as total from users')
```

::: danger
Always pass user input as bindings (the `?` placeholders), never by building the SQL string yourself. Without `allowUnsafeRawSql: true`, raw calls throw a `SecurityError`.
:::

Both methods accept a connection name and an options object:

```ts
await DB.unsafeQuery(DB.raw('select 1'), 'analytics', { timeoutMs: 2000 })
```

## Timeouts and cancellation

Raw queries accept `timeoutMs` (a positive integer in milliseconds) and an `AbortSignal`. [Transactions](/database/transactions) accept the same options to limit how long they take to start, but never interrupt a commit or rollback:

```ts
const controller = new AbortController()

await DB.unsafeQuery(
  DB.raw('select * from reports'),
  undefined,
  { signal: controller.signal, timeoutMs: 5000 },
)
```

A timeout or abort throws a `DatabaseError` with the code `DRIVER_OPERATION_TIMEOUT` or `DRIVER_OPERATION_ABORTED`.

## Checking the driver

Get the active connection and its dialect when code has to branch per database:

```ts
import { DB } from '@holo-js/db'

if (DB.connection().getDialect().name === 'postgres') {
  // PostgreSQL-only statement
}
```

## Errors

All database errors extend `DatabaseError` and carry a `code` string. Import the classes from `@holo-js/db` to catch specific cases.

| Error | `code` | Thrown when |
| --- | --- | --- |
| `ConfigurationError` | `CONFIGURATION_ERROR` | A connection name is unknown or a setting is invalid |
| `SecurityError` | `SECURITY_ERROR` | Raw SQL is used without `allowUnsafeRawSql` |
| `CapabilityError` | `CAPABILITY_ERROR` | The driver doesn't support a feature, such as SQLite transaction modes on PostgreSQL |
| `TransactionError` | `TRANSACTION_ERROR` | A transaction can't start before its timeout or abort, a rollback callback fails, or a callback is registered outside a transaction |
| `SchemaError` | `SCHEMA_ERROR` | A schema or migration operation is invalid |
| `RelationError` | `RELATION_ERROR` | A relationship is misconfigured |
| `ModelNotFoundException` | `MODEL_NOT_FOUND` | `findOrFail()` and similar methods find nothing. Has `statusCode: 404` |
| `HydrationError`, `SerializationError`, `CompilerError` | | Building or reading a result failed |

```ts
import { ModelNotFoundException } from '@holo-js/db'
import Post from '../models/Post'

try {
  return await Post.findOrFail(id)
} catch (error) {
  if (error instanceof ModelNotFoundException) {
    return null
  }
  throw error
}
```

## Connection options reference

| Option | Type | Notes |
| --- | --- | --- |
| `driver` | `'sqlite' \| 'postgres' \| 'mysql'` | Inferred from `url` when left out |
| `url` | `string` | Connection URL, or a file path for SQLite |
| `host` | `string` | PostgreSQL and MySQL |
| `port` | `number \| string` | PostgreSQL and MySQL |
| `username` | `string` | PostgreSQL and MySQL |
| `password` | `string` | PostgreSQL and MySQL |
| `database` | `string` | Database name (or SQLite file) |
| `filename` | `string` | Same as `database` |
| `schema` | `string` | PostgreSQL schema, such as `public` |
| `ssl` | `boolean \| object` | PostgreSQL and MySQL |
| `max` | `number` | PostgreSQL pool size, at least `1` |
| `connectionTimeoutMillis` | `number` | PostgreSQL pool wait, `0` or more |
| `idleTimeoutMillis` | `number` | PostgreSQL idle close, `0` or more |
| `application_name` | `string` | PostgreSQL |
| `concurrency.maxConcurrentQueries` | `number` | At least `1` |
| `concurrency.queueLimit` | `number` | `0` or more |
| `logging` | `boolean` | Built-in console logging. Default `false` |
| `logger` | `DatabaseLogger` | Custom log hooks |
| `security.allowUnsafeRawSql` | `boolean` | Enables `unsafeQuery()` and `unsafeExecute()`. Default `false` |
| `security.debugSqlInLogs` | `boolean` | Adds SQL text to logs. Default `false` |

### Environment variables

New projects read these from `.env`:

| Variable | Used for |
| --- | --- |
| `DB_CONNECTION` | `defaultConnection` |
| `DB_DRIVER` | `driver` |
| `DB_URL` | `url` (SQLite projects) |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | PostgreSQL and MySQL credentials |
| `DB_SCHEMA` | PostgreSQL `schema` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS` | PostgreSQL pool |
| `DB_MAX_CONCURRENT_QUERIES`, `DB_QUERY_QUEUE_LIMIT` | `concurrency` settings |

These names come from the generated `config/database.ts`. Rename them freely; only the config file reads them.

## Next steps

- [Migrations](/database/migrations)
- [Query builder](/database/query-builder/)
- [Defining models](/orm/)
- [Transactions](/database/transactions)
- [Multiple connections](/database/connections)
