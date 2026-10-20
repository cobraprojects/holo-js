# Migrations

Migrations are version control for your database schema. Each migration is a small TypeScript file that creates or changes tables, and Holo runs them in order so every developer and every server ends up with the same schema.

```bash
npx holo make:migration create_posts_table
```

```ts [server/db/migrations/2026_04_26_000120_create_posts_table.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('posts', (table) => {
      table.id()
      table.foreignId('user_id').constrained().cascadeOnDelete()
      table.string('title')
      table.string('slug').unique()
      table.enum('status', ['draft', 'published']).default('draft')
      table.text('body')
      table.timestamp('published_at').nullable()
      table.timestamps()
    })
  },
  async down({ schema }) {
    await schema.dropTable('posts')
  },
})
```

```bash
npx holo migrate
```

## Migrations and model types

After each `migrate`, `migrate:rollback`, or `migrate:fresh`, Holo regenerates the schema file at `.holo-js/generated/schema.generated.ts`. Holo writes this file for you; don't edit it.

Your [models](/orm/) read their column types from that file. You never repeat column definitions in the model:

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  fillable: ['title', 'slug', 'body', 'status', 'user_id'],
})
```

With the migration above, `post.status` is typed as `'draft' | 'published'`, `post.published_at` as `Date | null`, and `Post.where('...')` autocompletes every column name. Columns with a default (or generated columns like `id`) are optional when you create a record.

## Generating migrations

```bash
npx holo make:migration create_posts_table
```

This writes a timestamped file to `server/db/migrations`, for example `2026_04_26_120000_create_posts_table.ts`. The file name is the migration's identity, and migrations run in file-name order.

Holo picks a starting template from the name:

| Name pattern | Template |
| --- | --- |
| `create_posts` or `create_posts_table` | `schema.createTable('posts', ...)` with `id()` and `timestamps()` |
| `add_..._to_posts`, `remove_..._from_posts`, `rename_..._on_posts`, `alter_posts` | `schema.table('posts', ...)` |
| `drop_posts` or `drop_posts_table` | `schema.dropTable('posts')` |
| anything else | an empty `up` and `down` |

Pass a flag to choose the template yourself:

```bash
npx holo make:migration create_post_archive --create posts_archive
npx holo make:migration add_reading_time --table posts
```

| Flag | Effect |
| --- | --- |
| `--create <table>` | Create-table template for `<table>` |
| `--table <table>` | Alter-table template for `<table>` |

You can't use `--create` and `--table` together.

::: tip
`npx holo make:model Post --migration` creates the model and its create-table migration in one step. See [Defining Models](/orm/).
:::

## Migration structure

A migration exports `defineMigration()` with an `up` function and, usually, a `down` function that reverses it:

```ts [server/db/migrations/2026_05_01_090000_add_views_to_posts.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.table('posts', (table) => {
      table.integer('views').default(0)
    })
  },
  async down({ schema }) {
    await schema.table('posts', (table) => {
      table.dropColumn('views')
    })
  },
})
```

Both functions receive:

- `schema` — the schema builder for tables, columns, indexes, and foreign keys.
- `db` — the database connection, for moving or seeding data inside the migration.

Each migration runs inside its own transaction. If `up` throws, its changes roll back and the migration stays pending, so you can fix it and run `migrate` again.

### Changing data in a migration

Use `db.table()` to read or write rows as part of a schema change. It runs in the same transaction as the migration:

```ts [server/db/migrations/2026_05_02_100000_create_categories.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema, db }) {
    await schema.createTable('categories', (table) => {
      table.id()
      table.string('name')
      table.string('slug').unique()
    })

    await db.table('categories').insert({ name: 'General', slug: 'general' })
  },
  async down({ schema }) {
    await schema.dropTable('categories')
  },
})
```

## Running migrations

Run every pending migration:

```bash
npx holo migrate
```

Holo records each migration in a `_holo_migrations` table. All migrations from one `migrate` run share a **batch** number, which is what rollback uses.

For PostgreSQL and MySQL, if the database itself doesn't exist yet, `migrate` creates it before running.

Run only the next few migrations:

```bash
npx holo migrate --step 1
```

Holo never runs migrations when your app starts. Run `migrate` yourself, in your deploy script or CI.

### Isolating migration runs

When several replicas run `migrate` at the same time, add `--isolated`:

```bash
npx holo migrate --isolated
```

The first run takes a database lock and applies the pending migrations. A run that starts while the lock is held skips the migrations, prints a message, and exits successfully, so a deploy step on every replica still passes. The lock is held in a `_holo_migration_locks` table and expires an hour after it was last renewed, so a runner that stops without releasing it doesn't block later deploys for longer than that. The run renews the lock before each migration. A single migration that runs longer than an hour can let another runner in, which can apply that migration again. Split very long data backfills into shorter runs, and don't start a second `migrate --isolated` while one is still working on a long migration.

### Rolling back

Undo the latest batch:

```bash
npx holo migrate:rollback
```

| Flag | Effect |
| --- | --- |
| `--step <n>` | Roll back only the last `n` migrations of the batch |
| `--batch <n>` | Roll back batch `n` instead of the latest one |
| `--force` | Skip the production confirmation |

Migrations roll back newest first. A migration without `down` is still marked as not run, but nothing in the database changes.

When `APP_ENV` is `production`, `migrate:rollback` asks you to confirm first.

### Starting fresh

Drop every table and run all migrations from scratch:

```bash
npx holo migrate:fresh
```

Add `--seed` to run your [seeders](/database/seeding) afterwards. The seeding flags `--only`, `--quietly`, and `--force` work here too:

```bash
npx holo migrate:fresh --seed --only database
```

When `APP_ENV` is `production`, `migrate:fresh` asks you to confirm first.

::: warning
`migrate:fresh` drops **every** table on the connection, including tables Holo didn't create. Never run it against a production database.
:::

## Migration API

### defineMigration()

Wraps a migration object and returns it unchanged, so TypeScript checks its shape. Set `name` only when you need to override the file-name identity; if you do, it must follow the `YYYY_MM_DD_HHMMSS_description` format.

```ts [server/db/migrations/2026_05_03_080000_add_slug_to_posts.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.table('posts', (table) => {
      table.string('slug').nullable()
    })
  },
})
```

### MigrationContext

The object passed to `up()` and `down()`. It has two properties:

- `db`: the `DatabaseContext` for the connection the migration runs on. Use `db.table()` to read or write rows.
- `schema`: the `SchemaService` described in the next sections.

## Schema operations

These methods live on `schema` (the `SchemaService`) and run immediately inside the migration's transaction.

### createTable()

Creates a table. Pass a callback that declares its columns, indexes, and foreign keys.

```ts
await schema.createTable('tags', (table) => {
  table.id()
  table.string('name').unique()
  table.timestamps()
})
```

### table()

Changes an existing table. The callback receives a builder for adding, changing, renaming, and dropping columns, indexes, and foreign keys.

```ts
await schema.table('users', (table) => {
  table.string('nickname').nullable()
  table.index(['nickname'])
})
```

### dropTable()

Drops a table and removes it from the schema registry.

```ts
await schema.dropTable('articles')
```

### renameTable()

Renames a table from one name to another.

```ts
await schema.renameTable('posts', 'articles')
```

### hasTable()

Returns `true` when the table exists on the connection.

```ts
if (!(await schema.hasTable('settings'))) {
  await schema.createTable('settings', (table) => {
    table.id()
    table.string('key').unique()
    table.json('value')
  })
}
```

To check for a column, call `getColumns()` and search the result.

### getTables()

Returns the names of every table on the connection, as a `string[]`.

```ts
const tables = await schema.getTables()
```

### getColumns()

Returns the columns of a table. Each entry has `name`, `type` (the database's native type), `logicalType`, `notNull`, `defaultValue`, and `primaryKey`.

```ts
const columns = await schema.getColumns('posts')
const hasSlug = columns.some(column => column.name === 'slug')
```

### getIndexes()

Returns the indexes of a table. Each entry has `name`, `unique`, and `columns`.

```ts
const indexes = await schema.getIndexes('comments')
```

### getForeignKeys()

Returns the foreign keys of a table. Each entry has `table`, `from`, `to`, `onUpdate`, and `onDelete`.

```ts
const foreignKeys = await schema.getForeignKeys('posts')
```

### enableForeignKeyConstraints()

Turns foreign key checks on for the connection.

```ts
await schema.enableForeignKeyConstraints()
```

### disableForeignKeyConstraints()

Turns foreign key checks off for the connection. Call `enableForeignKeyConstraints()` afterward, or use `withoutForeignKeyConstraints()`.

::: warning
On a connection pool, PostgreSQL and MySQL run each statement on whichever pooled connection is free. These two methods change only the connection that runs them, so the other connections keep their checks. Use `withoutForeignKeyConstraints()` on a pool.
:::

```ts
await schema.disableForeignKeyConstraints()
```

### withoutForeignKeyConstraints()

Runs a callback with foreign key checks turned off, then turns them back on, even when the callback throws. Every query in the callback runs on one connection.

```ts
await schema.withoutForeignKeyConstraints(async () => {
  await schema.dropTable('users')
  await schema.dropTable('teams')
})
```

### previewSync()

Returns what `sync()` would do: the tables it would create, the tables that already exist, and `destructiveChanges: false`. It never changes the database.

```ts
const plan = await schema.previewSync()
// plan.tablesToCreate: ['comments']
```

### sync()

Creates every registered table that doesn't exist yet. It never alters or drops existing tables.

```ts
await schema.sync()
```

### getDialectName()

Returns the name of the active database dialect, such as `'sqlite'`, `'postgres'`, or `'mysql'`.

```ts
if (schema.getDialectName() === 'sqlite') {
  return
}
```

## Available column types

Use these methods inside `createTable()` callbacks. Inside `table()` callbacks, the same types add a new column to an existing table. Column names are required unless noted. For UUID, ULID, and Snowflake primary keys, replace `id()` with a key column and `.primaryKey()`, for example `table.uuid('id').primaryKey()`. Holo can generate these IDs for you when you add the matching trait to the model. See [Defining Models](/orm/).

- Numbers: [`id()`](#id), [`autoIncrementId()`](#autoincrementid), [`integer()`](#integer), [`bigInteger()`](#biginteger), [`real()`](#real), [`decimal()`](#decimal)
- Text: [`string()`](#string), [`text()`](#text), [`enum()`](#enum)
- Booleans and dates: [`boolean()`](#boolean), [`date()`](#date), [`datetime()`](#datetime), [`timestamp()`](#timestamp)
- Structured data: [`json()`](#json), [`blob()`](#blob), [`vector()`](#vector)
- Identifiers: [`uuid()`](#uuid), [`ulid()`](#ulid), [`snowflake()`](#snowflake)
- Foreign keys: [`foreignId()`](#foreignid), [`foreignUuid()`](#foreignuuid), [`foreignUlid()`](#foreignulid), [`foreignSnowflake()`](#foreignsnowflake)

### id()

Adds an auto-incrementing primary key. It defaults to the name `id`; pass a name to use another column.

```ts
await schema.createTable('posts', (table) => {
  table.id()
})
```

### autoIncrementId()

Same as `id()`. Use it when you want the intent to be explicit.

```ts
table.autoIncrementId('post_id')
```

### integer()

Adds an integer column.

```ts
table.integer('views').default(0)
```

### bigInteger()

Adds a big integer column.

```ts
table.bigInteger('view_count').default(0)
```

### real()

Adds a floating-point column.

```ts
table.real('rating').nullable()
```

### decimal()

Adds an exact decimal column. It becomes `DECIMAL(10, 2)` on MySQL and `NUMERIC` on PostgreSQL and SQLite. The TypeScript type is `string`.

```ts
table.decimal('total')
```

### string()

Adds a short text column. It becomes `VARCHAR(255)` on PostgreSQL and MySQL and `TEXT` on SQLite.

```ts
table.string('title')
```

### text()

Adds a long text column with no length limit.

```ts
table.text('body')
```

### enum()

Adds a string column that accepts one of a fixed list of values. The TypeScript type is the union of those values.

```ts
table.enum('status', ['draft', 'published']).default('draft')
```

### boolean()

Adds a true or false column.

```ts
table.boolean('is_gift').default(false)
```

### date()

Adds a date column without a time part.

```ts
table.date('published_on').nullable()
```

On PostgreSQL, a `date` column reads back as a `Date` at midnight UTC on the stored day, so the day doesn't change when you save the value again.

### datetime()

Adds a date and time column that is not tied to a time zone.

```ts
table.datetime('starts_at')
```

### timestamp()

Adds a timestamp column. Use it for values such as `published_at`.

```ts
table.timestamp('published_at').nullable()
```

### json()

Adds a JSON column. It becomes `JSONB` on PostgreSQL and `JSON` on MySQL. Reads return the parsed value.

```ts
table.json('shipping_address').nullable()
```

### blob()

Adds a binary column. Reads return a `Uint8Array`.

```ts
table.blob('thumbnail').nullable()
```

### vector()

Adds an embedding column with a fixed number of dimensions. It needs the [pgvector](https://github.com/pgvector/pgvector) extension and works only on PostgreSQL. SQLite and MySQL throw a `CapabilityError`.

```ts
await schema.createTable('documents', (table) => {
  table.id()
  table.text('content')
  table.vector('embedding', { dimensions: 1536 })
})
```

### uuid()

Adds a UUID column. It becomes `UUID` on PostgreSQL and `CHAR(36)` on MySQL.

```ts
table.uuid('id').primaryKey()
```

### ulid()

Adds a ULID column. It becomes `VARCHAR(26)` on PostgreSQL and `CHAR(26)` on MySQL.

```ts
table.ulid('public_id').unique()
```

### snowflake()

Adds a Snowflake ID column stored as a string.

```ts
table.snowflake('external_id').unique()
```

### foreignId()

Adds a big-integer column meant to reference another table's `id`. Chain `constrained()` to create the foreign key.

```ts
table.foreignId('user_id').constrained()
```

### foreignUuid()

Adds a UUID column for a foreign key to a UUID primary key.

```ts
table.foreignUuid('account_uuid').constrained('accounts', 'uuid')
```

### foreignUlid()

Adds a ULID column for a foreign key to a ULID primary key.

```ts
table.foreignUlid('ticket_ulid').constrained('tickets', 'ulid')
```

### foreignSnowflake()

Adds a Snowflake column for a foreign key to a Snowflake primary key.

```ts
table.foreignSnowflake('device_snowflake').constrained('devices', 'snowflake')
```

## Column modifiers

Chain these after a column type, for example `table.string('email').unique()`.

- Nullability and defaults: [`notNull()`](#notnull), [`nullable()`](#nullable), [`default()`](#default), [`defaultNow()`](#defaultnow), [`generated()`](#generated), [`primaryKey()`](#primarykey)
- Indexes: [`unique()`](#unique), [`index()`](#index)
- Foreign keys: [`references()`](#references), [`on()`](#on), [`constrained()`](#constrained), [`onDelete()`](#ondelete), [`onUpdate()`](#onupdate)
- Foreign key shortcuts: [`cascadeOnDelete()`](#cascadeondelete), [`restrictOnDelete()`](#restrictondelete), [`nullOnDelete()`](#nullondelete), [`noActionOnDelete()`](#noactionondelete), [`cascadeOnUpdate()`](#cascadeonupdate), [`restrictOnUpdate()`](#restrictonupdate), [`nullOnUpdate()`](#nullonupdate), [`noActionOnUpdate()`](#noactiononupdate)
- Changing columns: [`change()`](#change)

### notNull()

Disallows `NULL`. Columns are already `NOT NULL` by default, so you need this mainly to make a change explicit or to reverse `nullable()`.

```ts
table.text('bio').notNull()
```

### nullable()

Allows `NULL`. In TypeScript, the value type becomes `T | null`.

```ts
table.timestamp('last_seen_at').nullable()
```

### default()

Sets a default value. It accepts a string, number, boolean, `null`, `Date`, or a plain object or array, which is stored as JSON.

```ts
table.string('role').default('member')
table.json('preferences').default({ theme: 'light' })
```

### defaultNow()

Sets the default to the current time. Use it for timestamp columns that record when a row was created or changed.

```ts
table.timestamp('joined_at').defaultNow()
```

### generated()

Marks the column as filled in by the database. The column becomes optional when you create a record.

```ts
table.uuid('reference').generated()
```

### primaryKey()

Makes the column the table's primary key.

```ts
table.uuid('id').primaryKey()
```

### unique()

Adds a unique constraint on this column. Inside `createTable()`, you can also pass a list of columns and a name to create a composite unique index. See [unique(columns)](#unique-columns).

```ts
table.string('email').unique()
```

### index()

Adds an index on this column. Pass a name to use your own index name; otherwise Holo builds one from the table and column.

```ts
table.integer('post_id').index()
table.string('status').index('posts_status_lookup')
```

### references()

Sets the column the foreign key points to. The default is `id`. Use it with `on()` when the parent key has another name.

```ts
table.foreignId('author_id').references('id').on('users')
```

### on()

Sets the table the foreign key points to.

```ts
table.foreignId('author_id').references('id').on('users')
```

### constrained()

Adds a foreign key. With no arguments, Holo infers the table from the column name, so `user_id` points to `users`, and uses the `id` column. Pass a table and column to override both.

```ts
table.foreignId('user_id').constrained()
table.foreignId('owner_ref').constrained('accounts', 'account_number')
```

### onDelete()

Sets the action when the referenced row is deleted. Use `'cascade'`, `'restrict'`, `'set null'`, or `'no action'`. Any other value throws a `SchemaError`. The shortcuts below do the same thing.

```ts
table.foreignId('user_id').constrained().onDelete('cascade')
```

### onUpdate()

Sets the action when the referenced key changes. Accepts the same values as `onDelete()`.

```ts
table.foreignId('user_id').constrained().onUpdate('cascade')
```

### cascadeOnDelete()

Deletes child rows when the parent row is deleted. Same as `onDelete('cascade')`.

```ts
table.foreignId('user_id').constrained().cascadeOnDelete()
```

### restrictOnDelete()

Blocks deleting a parent row while child rows point to it. Same as `onDelete('restrict')`.

```ts
table.foreignId('user_id').constrained().restrictOnDelete()
```

### nullOnDelete()

Sets the foreign key to `NULL` when the parent row is deleted. The column must be nullable. Same as `onDelete('set null')`.

```ts
table.foreignId('category_id').nullable().constrained().nullOnDelete()
```

### noActionOnDelete()

Rejects the delete without a special action. Same as `onDelete('no action')`.

```ts
table.foreignId('user_id').constrained().noActionOnDelete()
```

### cascadeOnUpdate()

Updates child rows when the parent key changes. Same as `onUpdate('cascade')`.

```ts
table.foreignId('user_id').constrained().cascadeOnUpdate()
```

### restrictOnUpdate()

Blocks changing a parent key while child rows point to it. Same as `onUpdate('restrict')`.

```ts
table.foreignId('user_id').constrained().restrictOnUpdate()
```

### nullOnUpdate()

Sets the foreign key to `NULL` when the parent key changes. The column must be nullable. Same as `onUpdate('set null')`.

```ts
table.foreignId('category_id').nullable().constrained().nullOnUpdate()
```

### noActionOnUpdate()

Rejects the update without a special action. Same as `onUpdate('no action')`.

```ts
table.foreignId('user_id').constrained().noActionOnUpdate()
```

### change()

Changes an existing column instead of adding one. Call it inside `table()` after redeclaring the column. On SQLite, Holo rebuilds the table, and the table must already be in the schema registry; otherwise it throws a `SchemaError`.

```ts
await schema.table('users', (table) => {
  table.text('bio').nullable().change()
})
```

## Shortcut columns

### timestamps()

Adds `created_at` and `updated_at`, both defaulting to the current time. Available in `createTable()` only.

```ts
await schema.createTable('posts', (table) => {
  table.id()
  table.timestamps()
})
```

### softDeletes()

Adds a nullable `deleted_at` timestamp, or the column name you pass. Available in `createTable()` only.

```ts
await schema.createTable('posts', (table) => {
  table.id()
  table.softDeletes()
})
```

To add these to an existing table, add the columns yourself:

```ts
await schema.table('posts', (table) => {
  table.timestamp('deleted_at').nullable()
})
```

### morphs()

Adds a `{name}_type` string column and a `{name}_id` big-integer column, with an index on both. Morph columns back [polymorphic relationships](/orm/relationships/through-and-polymorphic).

```ts
await schema.createTable('comments', (table) => {
  table.id()
  table.morphs('commentable')
  table.text('body')
  table.timestamps()
})
```

### nullableMorphs()

Same as `morphs()`, with both columns nullable.

```ts
table.nullableMorphs('owner')
```

### uuidMorphs()

Adds the morph columns with a UUID `{name}_id` column.

```ts
table.uuidMorphs('attachable')
```

### nullableUuidMorphs()

Same as `uuidMorphs()`, with both columns nullable.

```ts
table.nullableUuidMorphs('attachable')
```

### ulidMorphs()

Adds the morph columns with a ULID `{name}_id` column.

```ts
table.ulidMorphs('ticketable')
```

### nullableUlidMorphs()

Same as `ulidMorphs()`, with both columns nullable.

```ts
table.nullableUlidMorphs('ticketable')
```

### snowflakeMorphs()

Adds the morph columns with a Snowflake `{name}_id` column.

```ts
table.snowflakeMorphs('reactable')
```

### nullableSnowflakeMorphs()

Same as `snowflakeMorphs()`, with both columns nullable.

```ts
table.nullableSnowflakeMorphs('reactable')
```

Every morph helper accepts an index name as its second argument, for example `table.morphs('commentable', 'comments_commentable_lookup')`.

## Indexes

Index one column with the `index()` or `unique()` modifier, or several columns with the table methods below.

### index(columns)

Creates an index on one or more columns. Pass a name as the second argument, or let Holo build one.

```ts
await schema.createTable('comments', (table) => {
  table.id()
  table.integer('post_id')
  table.string('status')
  table.index(['post_id', 'status'])
})
```

### unique(columns)

Creates a unique index on one or more columns. Pass a name as the second argument.

```ts
table.unique(['post_id', 'created_at'], 'comments_post_created_unique')
```

When you don't pass a name, Holo builds one from the table and columns: `comments_post_id_index`, `comments_post_id_status_index`, or `..._unique` for unique indexes.

### dropIndex()

Drops an index by name. Available inside `table()`.

```ts
await schema.table('comments', (table) => {
  table.dropIndex('comments_post_id_status_index')
})
```

### renameIndex()

Renames an index. Available inside `table()`. Not supported on SQLite.

```ts
await schema.table('comments', (table) => {
  table.renameIndex('comments_post_id_index', 'comments_post_lookup')
})
```

Index names must be 63 bytes or shorter. Holo rejects longer names so your migrations stay portable to PostgreSQL. If a generated name is too long, pass a shorter one.

## Foreign keys

`foreignId()` adds a big-integer column, and `constrained()` points it at another table. Use the matching type helper when the parent key isn't an integer:

```ts
await schema.createTable('posts', (table) => {
  table.id()
  table.foreignId('user_id').constrained()
  table.foreignId('category_id').nullable().constrained().nullOnDelete()
  table.foreignUuid('account_uuid').constrained('accounts', 'uuid')
})
```

### foreign(column)

Adds a foreign key to an existing column. Chain `references()`, `on()`, or `constrained()` and an action shortcut. Inside `table()`, you can pass a constraint name as the second argument.

```ts
await schema.createTable('post_tags', (table) => {
  table.integer('post_id')
  table.integer('tag_id')
  table.foreign('post_id').references('id').on('posts').cascadeOnDelete()
  table.foreign('tag_id').references('id').on('tags').cascadeOnDelete()
})
```

Holo names foreign keys `{table}_{column}_foreign` by default.

### dropForeign()

Drops a foreign key by its constraint name. Available inside `table()`. Not supported on SQLite.

```ts
await schema.table('posts', (table) => {
  table.dropForeign('posts_user_id_foreign')
})
```

## Column changes and renames

### dropColumn()

Drops a column. Available inside `table()`. Not supported on SQLite.

```ts
await schema.table('users', (table) => {
  table.dropColumn('legacy_flags')
})
```

### renameColumn()

Renames a column. Available inside `table()`. Not supported on SQLite.

```ts
await schema.table('users', (table) => {
  table.renameColumn('nickname', 'display_name')
})
```

::: warning SQLite limits
On SQLite, `schema.table()` can add columns, change columns with `.change()`, and add or drop indexes. It **can't** rename or drop columns, rename indexes, or add or drop foreign keys on an existing table. Holo throws a `CapabilityError` instead of guessing. Put foreign keys in `createTable()` so they work on every database.
:::

## Command reference

| Command | Flags |
| --- | --- |
| `npx holo make:migration <name>` | `--create <table>`, `--table <table>` |
| `npx holo migrate` | `--step <n>`, `--isolated` |
| `npx holo migrate:rollback` | `--step <n>`, `--batch <n>`, `--force` |
| `npx holo migrate:fresh` | `--seed`, `--only <names>`, `--quietly`, `--force` |

## Next steps

- [Seeding](/database/seeding)
- [Defining Models](/orm/)
- [Factories](/orm/factories)
- [CLI Commands](/reference/cli)
