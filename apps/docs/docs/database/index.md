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

Point `url` at a file path, or at a `file:` URL such as `file:./storage/database.sqlite` (query parameters such as `?mode=ro` aren't supported). Holo opens the file the first time your app queries the connection, and never creates it: a query against a missing file fails with `Database file at path "<path>" does not exist. Run "holo migrate" to create it.` Only `npx holo migrate` and `npx holo migrate:fresh` create the file and its directory. `:memory:` gives you an in-memory database, which starts empty in every process and is gone when the process exits. Use it for tests. Don't use it as the default connection of an app you build: `holo build` and `holo dev` read the schema types from a new, empty in-memory database, so the generated schema has no tables.

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

SQLite has no date type. A `Date` you write or bind on SQLite, in a model, in `DB.table()`, in `where()` or in a raw query, is stored as UTC text in the format SQLite's `CURRENT_TIMESTAMP` uses, such as `2026-01-02 03:04:05`. Milliseconds are kept when they aren't zero, as in `2026-01-02 03:04:05.678`, so a value reads back as the same `Date`. Because `defaultNow()` and `CURRENT_TIMESTAMP` defaults store the same format, a `Date` compares and orders correctly against `date`, `datetime` and `timestamp` columns, and against `TEXT` date columns created before 0.6 once their ISO 8601 values are rewritten as the [upgrade guide](/getting-started/upgrading#model-types-come-from-the-database-and-casts) shows. Holo reads these values as UTC.

To reach a table in an [attached database](https://www.sqlite.org/lang_attach.html), or to name the main database explicitly, qualify the table with the schema name, as in `DB.table('archive.products')` or `DB.table('main.products')`. Holo quotes each part separately, as `"archive"."products"`, and each part must be a plain identifier: it starts with a letter or an underscore, followed by letters, digits and underscores. Migrations work on these tables too: indexes are created in the table's database, and `foreign()` and `constrained('archive.parents')` reference a table in the same database. SQLite can't reference or move a table across databases, so a foreign key to another database's table, or `renameTable('archive.items', 'main.items')`, raises a `SchemaError`. When the new name names a database, qualify the old name too, as in `renameTable('main.items', 'main.goods')`, since SQLite looks an unqualified table up in `temp` first. SQLite accepts `*` only after a bare table name, so `select('archive.products.*')` becomes `"products".*`, and it needs the query to name `archive.products` the same way. Otherwise Holo raises an error instead of guessing, since SQLite would look the bare name up in `temp` first. When the query has two tables with that name, such as `main.products` joined to `archive.products`, or the table has an alias, select `alias.*`.

On SQLite, the date predicates `whereDate()`, `whereYear()`, `whereMonth()`, `whereDay()`, `whereTime()`, `whereToday()` and the other `…Today()` methods read the stored UTC text in `app.timezone`, so they match the day your app sees, as on PostgreSQL and MySQL. A `date` column compares by calendar date in `app.timezone`, so `where()`, `whereIn()` and `whereBetween()` with a `Date` match rows stored as calendar text such as `2026-11-05` and rows a model wrote as UTC datetime text. `whereColumn()` comparing a `date` column with a `datetime` column reads both in `app.timezone`. To read the stored text in `app.timezone`, the SQLite adapter registers a `holo_wall_clock()` SQL function on each database it opens. If you pass your own `database` to `createSQLiteAdapter()` and `app.timezone` isn't `UTC`, it must support better-sqlite3's `function()` method. Without it, these queries raise a `CapabilityError` that names the requirement.

On SQLite, Holo binds `true` and `false` as the integers `1` and `0`, and binds whole numbers up to `Number.MAX_SAFE_INTEGER` as integers, as Laravel does through PDO. Other numbers are bound as reals. So a `TEXT` column stores `false` as `'0'` and `42` as `'42'`, not `'0.0'` or `'42.0'`. Because SQLite divides two integers as integers, a raw `? / ?` with whole-number bindings such as `5` and `2` returns `2`, not `2.5`. Bind a real such as `5.5` or write `CAST(? AS REAL) / ?` when you need a fractional result. A `'boolean'` cast reads `'0'`, `'0.0'`, `'false'`, and other text that means zero as `false`, including `'0.0'` values that releases before this fix stored for `false`.

### PostgreSQL and MySQL

Use either a connection URL or separate host settings. When you set both, the URL wins: its host, port, credentials and database are used, and `holo migrate` creates the URL's database when it's missing, not the one `database` names. You can also set `ssl` next to a URL. It adds TLS settings to the URL. The URL's own `ssl` parameter takes precedence over the setting, and `ssl: false` doesn't disable TLS that the URL requests.

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
      logging: env('DB_LOGGING', false),
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

### PostgreSQL schema

On PostgreSQL, `schema` sets the connection's `search_path`, as Laravel's `search_path` setting does. Every pooled connection starts with it, so migrations, the schema builder, queries, models and the CLI create and read unqualified tables in that schema, and the generated schema is read from it. With `schema: 'tenant'`, `holo migrate` creates its tables in `tenant`, and a `public` table with the same name is ignored. Leave `schema` out to keep the server's default `search_path`.

A `search_path` in the URL's `options` parameter, or in the `PGOPTIONS` environment variable when the URL has no or an empty `options`, wins over `schema`:

```ts
main: {
  driver: 'postgres',
  url: 'postgres://app@127.0.0.1/my_app?options=-c%20search_path%3Dtenant,public',
  schema: 'tenant',
},
```

The generated schema, the schema builder and `migrate:fresh` use the schema that unqualified statements use, which is the first schema of the `search_path` that exists. With the URL above and no `tenant` schema in the database, `holo migrate` creates its tables in `public`, the generated schema lists them from `public`, and `migrate:fresh` drops them from `public`.

### PostgreSQL dates and time zones

PostgreSQL reads and writes `date` and `timestamp` values in `app.timezone`, which comes from [`APP_TIMEZONE`](/reference/environment), not in the Node process's time zone. A `timestamp` column without a time zone holds the wall-clock time in `app.timezone`, and a `Date` you save is written as that wall-clock time. A `timestamptz` column holds the exact instant. A `date` reads back as a `Date` at midnight in `app.timezone`. On a day the zone skipped entirely, such as 2011-12-30 in `Pacific/Apia`, there is no midnight, so the `date` reads back as the next day, as in Laravel. Saving the loaded value stores that next day. To avoid this, set `APP_TIMEZONE=UTC` (the default).

In the hour that repeats when clocks fall back, a `timestamp` column can't tell the two instants apart, so a value written at the earlier instant reads back an hour later. With a non-UTC `app.timezone` that observes daylight saving time, an expiry in that hour can be honored up to one hour late. Holo recommends `APP_TIMEZONE=UTC` for PostgreSQL apps, which avoids this.

Holo sets each pooled connection's session `TimeZone` to `app.timezone` when it connects, as it does on MySQL, so `defaultNow()`, `timestamps()` and `CURRENT_TIMESTAMP` defaults on `timestamp` columns hold the wall-clock time in `app.timezone`, whatever the server's own time zone is. A `TimeZone` in the URL's `options` parameter, in the pg `options` you pass to `createPostgresAdapter()`, or in the `PGOPTIONS` environment variable when neither is set wins over `app.timezone`:

```ts
main: {
  driver: 'postgres',
  url: 'postgres://app@127.0.0.1/my_app?options=-c%20TimeZone%3DEurope/Paris',
},
```

Objects you pass to `createPostgresAdapter()` as `client`, `pool`, or `createPool` keep their own session time zone.

### MySQL dates and time zones

MySQL reads and writes `date`, `datetime`, and `timestamp` values in `app.timezone`, which comes from [`APP_TIMEZONE`](/reference/environment), as PostgreSQL does. Holo sets each connection's session time zone to `app.timezone`. MySQL needs its time zone tables loaded for any zone other than `UTC`:

```sh
mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql
```

Without the tables, queries fail, and the reason is reported through `exceptions.report`.

A `Date` value is written as wall-clock time in `app.timezone`, to the whole second as Laravel does, so `12:00:00.900` is stored as `12:00:00` and a `created_at` set now never lands in the future. This applies to bindings, inlined SQL, column defaults and ISO date strings a model writes, also in `text` columns. After a save or soft delete, the model holds the same whole-second values the row stores. A `date` reads back as a `Date` at midnight in that zone. On a day the zone skipped entirely, such as 2011-12-30 in `Pacific/Apia`, the `date` reads back as the next day, and saving the loaded value stores that day. To avoid this, set `APP_TIMEZONE=UTC` (the default). In the hour that repeats when clocks fall back, a `timestamp` stored at the later instant reads back an hour early, because MySQL shows both instants with the same wall-clock time. To receive the stored strings instead, set `dateStrings` or `typeCast: false` on the connection. The strings are already in `app.timezone`, and `Date` values are still written in it.

Objects you pass to `createMySQLAdapter()` as `client`, `pool`, or `createPool` are used as they are. Holo doesn't convert their dates or set their session time zone, so set their `time_zone` and date options yourself.

### Large integers

A MySQL `bigint` up to `Number.MAX_SAFE_INTEGER` comes back as a number. A larger one comes back as its exact text, such as `'9007199254740993'`, as PostgreSQL and SQLite return it, so raw queries and untyped models never lose digits. Models and table definitions that type the column as `number` throw a `HydrationError` for it instead. `DECIMAL` values come back as text, and JSON values are parsed with `JSON.parse()`, both as before, so a number inside JSON is read as on PostgreSQL and SQLite.

Holo turns on mysql2's `supportBigNumbers` and leaves `bigNumberStrings` off to do this. A `supportBigNumbers` or `bigNumberStrings` parameter in the connection URL replaces both settings, and a `jsonStrings=true` parameter returns JSON as text.

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

Simple raw `INSERT INTO`, `UPDATE … SET`, and `DELETE FROM` statements refresh [cached queries](/cache/query-caching) and [realtime subscriptions](/realtime/) for their target table after they succeed. This also applies to writes returning rows through `unsafeQuery()`. Inside a transaction, refreshes wait for commit; rolled-back or failed writes publish nothing.

Holo identifies the target from the SQL, including ordinary quoted and schema-qualified names. A table-scoped call or a `source` logging label does not override the SQL target. Detection is conservative: aliases, multi-table writes, vendor-specific modifiers, and unusual identifiers may have no recognized target. Do not rely on automatic refresh for these forms. For example, a CTE `WITH … UPDATE` leaves cached queries and subscriptions unchanged. Changes to other tables through triggers or stored routines are not discovered. Schema-changing SQL still clears caches and refreshes subscriptions separately.

For SQL Holo cannot identify, call `invalidateTables()` on the connection with every table you changed. It clears cached queries, including reads of individual rows, and refreshes subscriptions for those tables.

```ts [server/lib/archive-posts.ts]
import { DB } from '@holo-js/db'

await DB.transaction(async tx => {
  await tx.unsafeExecute(DB.raw(
    'WITH selected AS (SELECT id FROM posts WHERE status = ?) UPDATE posts SET status = ? WHERE id IN (SELECT id FROM selected)',
    ['draft', 'archived'],
  ))
  await tx.invalidateTables(['posts'])
})
```

`DatabaseContext.invalidateTables(tables: readonly string[]): Promise<void>` accepts bare or schema-qualified table names using the connection's usual table resolution rules. Equivalent names are deduplicated and published together. An empty list does nothing. The call needs no SQL write and does not check whether rows changed.

Inside a transaction, `await tx.invalidateTables(['posts'])` registers the refresh and returns before commit. Caches and subscriptions refresh only after a successful commit; rollback discards the refresh. For an autocommit write, use `await DB.connection().invalidateTables(['posts'])` after the write succeeds; that call publishes immediately. It does not wait for browsers to receive updates. List tables affected through triggers or stored routines yourself.

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
| `HydrationError`, `SerializationError`, `CompilerError` | | Building or reading a result failed, or a value can't be written to its column |

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
| `schema` | `string` | PostgreSQL schema, such as `public`. Sets the `search_path`. See [PostgreSQL schema](#postgresql-schema) |
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
| `DB_SSL` | `ssl` (MySQL projects). PostgreSQL TLS comes from `sslmode` in `DB_URL` or from `PGSSLMODE` |
| `DB_LOGGING` | `logging` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS` | PostgreSQL pool |
| `DB_MAX_CONCURRENT_QUERIES`, `DB_QUERY_QUEUE_LIMIT` | `concurrency` settings |

These names come from the generated `config/database.ts`. Rename them freely; only the config file reads them. The app and CLI commands such as `holo migrate` use the same resolved config, so a variable your config doesn't read, or a value it sets without `env()`, changes neither.

## Next steps

- [Migrations](/database/migrations)
- [Query builder](/database/query-builder/)
- [Defining models](/orm/)
- [Transactions](/database/transactions)
- [Multiple connections](/database/connections)
