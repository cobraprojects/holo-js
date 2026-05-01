# Migrations

## Introduction

Migrations are version control for your database schema. They let your team create, update, rename, and
remove tables in a way that can be reviewed, deployed, and rolled back.

Use a migration when a schema change must be applied to a real database:

- creating a table for a new feature
- adding or changing a column
- introducing or removing indexes
- wiring foreign keys
- renaming or dropping tables

Migration files are server-side files. Put them under:

```text
server/db/migrations/
```

Do not put migrations in client code. They belong to deployment, local setup, CI, and test database
bootstrap flows.

In Holo-JS, migrations are the operational source of truth. They change the real database, and after a
successful `npx holo migrate` run the CLI refreshes `server/db/schema.generated.ts`. Model files consume
that generated schema metadata instead of redefining columns inline.

Columns are not nullable by default. Write `.nullable()` only when a column should allow nulls. Use
`.notNull()` only when you need to make that intent explicit during a later mutation such as `change()`.

## Generating Migrations

Generate migrations with the CLI:

```bash
npx holo make:migration create_users_table
npx holo make:migration create_users_table --create users
npx holo make:migration add_status_to_users_table --table users
```

This creates a timestamped file in `server/db/migrations`:

```text
server/db/migrations/2026_03_29_120000_create_users_table.ts
```

The filename is the migration identity. You do not write a separate `name` inside the migration.

The generator follows a predictable naming convention:

- `create_users_table` generates a create-table stub
- `add_status_to_users_table` generates a table-mutation stub
- `drop_users_table` generates a drop-table stub
- any other name generates a blank migration

Use the flags when you want the scaffold to be explicit instead of inferred from the file name:

- `--create users`
  - generates `await schema.createTable('users', ...)`
- `--table users`
  - generates `await schema.table('users', ...)`

Use the generator when you want the file to start in the correct shape. Create the file manually only
if you already know exactly what should go in it.

For the broader command workflow, see [Database Commands](/database/commands).

## Migration Structure

Every migration uses the same shape:

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema, db }) {
    void schema
    void db
  },

  async down({ schema, db }) {
    void schema
    void db
  },
})
```

The two methods have one job each:

- `up`: apply the schema change
- `down`: reverse the schema change

The migration filename determines ordering and identity. The runtime validates that the filename follows
the timestamped migration format, then runs migrations in that order.

Inside the migration context:

- `schema` is the public schema builder you use for tables, columns, indexes, and foreign keys
- `db` is the active database context when you need explicit SQL or transaction-level work alongside the migration

### A complete migration example

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name')
      table.string('email').unique()
      table.timestamps()
    })
  },

  async down({ schema }) {
    await schema.dropTable('users')
  },
})
```

### Create-table vs alter-table generation

Use `--create` when the table does not exist yet:

```bash
npx holo make:migration create_users_table --create users
```

Use `--table` when the table already exists and the migration is adding, changing, renaming, indexing,
or dropping parts of it:

```bash
npx holo make:migration add_profile_photo_to_users_table --table users
```

That keeps create-table and alter-table scaffolds explicit and easy to review.

### When to include `down`

In normal application work, always write `down`.

That is what makes the migration reversible during local development, CI, and rollback operations. Only
omit `down` when the migration is intentionally irreversible and your team is treating it that way.

## Running Migrations

Run all pending migrations:

```bash
npx holo migrate
```

Run only the next `N` migrations:

```bash
npx holo migrate --step 1
```

Reset the database and rerun everything:

```bash
npx holo migrate:fresh
npx holo migrate:fresh --seed
```

`migrate:fresh` drops every table in the active connection, reruns the full migration chain, and then
refreshes `server/db/schema.generated.ts`. Add `--seed` to run registered seeders immediately after
the fresh migration pass.

Holo-JS does not silently run migrations just because the app starts. You run them explicitly from:

- local setup scripts
- deployment jobs
- CI database bootstrap steps
- development commands

That keeps schema work explicit even when teams wrap it in deployment automation.

## Rolling Back Migrations

Roll back the latest batch:

```bash
npx holo migrate:rollback
```

Roll back a specific number of migrations:

```bash
npx holo migrate:rollback --step 1
```

Roll back a specific batch:

```bash
npx holo migrate:rollback --batch 3
```

Use rollback when you need to reverse recent schema changes in development, tests, or controlled
deployment recovery.

## Tables

### Creating Tables

Create new tables with `schema.createTable(name, callback)`:

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('flights', (table) => {
      table.id()
      table.string('name')
      table.string('airline')
      table.timestamps()
    })
  },

  async down({ schema }) {
    await schema.dropTable('flights')
  },
})
```

Use this when the table does not exist yet.

### Updating Tables

Change an existing table with `schema.table(name, callback)`:

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.table('users', (table) => {
      table.string('nickname').nullable()
      table.string('display_name').default('guest').change()
      table.index(['nickname'], 'users_nickname_index')
    })
  },

  async down({ schema }) {
    await schema.table('users', (table) => {
      table.dropIndex('users_nickname_index')
      table.dropColumn('nickname')
    })
  },
})
```

Use this when the table already exists and you need to add, change, rename, or remove parts of it.

### Renaming / Dropping Tables

Rename a table:

```ts
export default defineMigration({
  async up({ schema }) {
    await schema.renameTable('users', 'accounts')
  },

  async down({ schema }) {
    await schema.renameTable('accounts', 'users')
  },
})
```

Drop a table:

```ts
export default defineMigration({
  async up({ schema }) {
    await schema.dropTable('users')
  },

  async down({ schema }) {
    await schema.createTable('users', (table) => {
      table.id()
      table.timestamps()
    })
  },
})
```

## Columns

### Creating Columns

Add columns inside `schema.createTable(...)` or `schema.table(...)`. The name you write is the one
public name for that column everywhere: migrations, schema definitions, models, queries, relations,
serialization, and autocomplete.

Example:

```ts
await schema.createTable('users', (table) => {
  table.id()
  table.string('display_name')
  table.timestamp('created_at').defaultNow()
})
```

If your app uses snake_case, keep snake_case everywhere. If your app uses camelCase, keep camelCase
everywhere. Holo-JS no longer translates between two public names.

This:

```ts
table.string('name')
```

already means `NOT NULL`. Use `.nullable()` only when null should be allowed.

### Available Column Types

The table builder supports the common schema types directly:

- `table.id()`
- `table.autoIncrementId()`
- `table.foreignId(...)`
- `table.foreignUuid(...)`
- `table.foreignUlid(...)`
- `table.foreignSnowflake(...)`
- `table.morphs(...)`
- `table.nullableMorphs(...)`
- `table.uuidMorphs(...)`
- `table.nullableUuidMorphs(...)`
- `table.ulidMorphs(...)`
- `table.nullableUlidMorphs(...)`
- `table.snowflakeMorphs(...)`
- `table.nullableSnowflakeMorphs(...)`
- `table.integer(...)`
- `table.bigInteger(...)`
- `table.string(...)`
- `table.text(...)`
- `table.boolean(...)`
- `table.real(...)`
- `table.decimal(...)`
- `table.date(...)`
- `table.datetime(...)`
- `table.timestamp(...)`
- `table.json(...)`
- `table.blob(...)`
- `table.uuid(...)`
- `table.ulid(...)`
- `table.snowflake(...)`
- `table.vector(..., { dimensions })`
- `table.enum(..., [...values])`
- `table.timestamps()`
- `table.softDeletes()`

### Enum Columns

`enum` is the main special case in the API shape because the builder needs both the column name and the
allowed values:

```ts
await schema.createTable('posts', (table) => {
  table.enum('post_status', ['draft', 'published'])
})
```

That means the column is named `post_status` and the allowed values are `draft` and `published`.

Use enum columns when a field should only accept a closed set of string values.

### Column Modifiers

Column modifiers are chained onto the column builder:

- `.nullable()`
- `.default(value)`
- `.defaultNow()`
- `.generated()`
- `.primaryKey()`
- `.unique()`
- `.change()`

Example:

```ts
await schema.createTable('users', (table) => {
  table.string('email').unique()
  table.timestamp('published_at').nullable()
  table.foreignId('team_id').constrained('teams')
})
```

Use modifiers to describe the actual storage rule, not just the logical type.

### Modifying Columns

Use `.change()` when you want to change the type, nullability, or default value of an existing column:

```ts
export default defineMigration({
  async up({ schema }) {
    await schema.table('users', (table) => {
      table.string('display_name').nullable().default('guest').change()
    })
  },

  async down({ schema }) {
    await schema.table('users', (table) => {
      table.string('display_name').notNull().change()
    })
  },
})
```

Use `change()` for:

- type changes
- nullable vs not-null changes
- default value changes

Do not use `change()` for:

- primary keys
- indexes
- foreign keys

Those use dedicated table operations instead.

Holo-JS-specific backend rule:

- Postgres and MySQL support column mutation
- SQLite fails closed for these mutations instead of attempting an implicit table rebuild

### UUID, ULID, and Snowflake Keys

Use the dedicated key type, model trait, and foreign-key helper together.

#### 1. Create the key columns with the matching type

```ts
await schema.createTable('api_users', (table) => {
  table.uuid('id').primaryKey()
})

await schema.createTable('sessions', (table) => {
  table.ulid('id').primaryKey()
})

await schema.createTable('audit_actors', (table) => {
  table.snowflake('snowflake_id').primaryKey()
})

await schema.createTable('api_tokens', (table) => {
  table.id()
  table.foreignUuid('user_id').constrained('api_users')
})

await schema.createTable('session_events', (table) => {
  table.id()
  table.foreignUlid('session_id').constrained('sessions')
})

await schema.createTable('actor_events', (table) => {
  table.id()
  table.foreignSnowflake('actor_id').constrained('audit_actors', 'snowflake_id')
})
```

Use:

- `foreignId(...)` for bigint integer keys
- `foreignUuid(...)` for UUID keys
- `foreignUlid(...)` for ULID keys
- `foreignSnowflake(...)` for Snowflake string keys

#### 2. Use the matching model trait when IDs should be generated automatically

```ts
import { HasSnowflakes, HasUlids, HasUuids, defineModel } from '@holo-js/db'

export const ApiUser = defineModel('api_users', {
  traits: [HasUuids()],
})

export const Session = defineModel('sessions', {
  traits: [HasUlids()],
})

export const AuditActor = defineModel('audit_actors', {
  primaryKey: 'snowflake_id',
  traits: [HasSnowflakes()],
})

export const ApiToken = defineModel('api_tokens', {
  timestamps: true,
})
```

Important constraints:

- vector columns are currently a Postgres-only schema feature
- SQLite and MySQL fail closed instead of silently storing vectors in a weaker type
- the dimensions are part of the schema contract and should match the embedding model you store

### Renaming Columns

Rename a column with `table.renameColumn(from, to)`:

```ts
await schema.table('users', (table) => {
  table.renameColumn('nickname', 'display_name')
})
```

Use this when the column name itself should change.

### Dropping Columns

Drop a column with `table.dropColumn(name)`:

```ts
await schema.table('users', (table) => {
  table.dropColumn('legacy_name')
})
```

Use this when the field should be removed from the database entirely.

## Indexes

### Creating Indexes

Create normal indexes:

```ts
await schema.table('users', (table) => {
  table.index(['email'], 'users_email_index')
})
```

Create unique indexes:

```ts
await schema.table('users', (table) => {
  table.unique(['email'], 'users_email_unique')
})
```

Use table-level indexes when the index spans one or more columns as a schema concern. Use the column
builder’s `.unique()` when the uniqueness rule clearly belongs to a single column definition.

### Renaming Indexes

Rename an index with:

```ts
await schema.table('users', (table) => {
  table.renameIndex('users_email_index', 'users_email_lookup')
})
```

Holo-JS-specific backend rule:

- Postgres and MySQL support index renaming
- SQLite fails closed for index renames

### Dropping Indexes

Drop an index with:

```ts
await schema.table('users', (table) => {
  table.dropIndex('users_email_index')
})
```

## Foreign Key Constraints

Create a foreign key:

```ts
await schema.table('users', (table) => {
  table.foreignId('team_id')
    .constrained('teams')
    .cascadeOnDelete()
    .restrictOnUpdate()
})
```

Drop a foreign key:

```ts
await schema.table('users', (table) => {
  table.dropForeign('users_team_id_foreign')
})
```

Temporarily disable foreign key checks:

```ts
await schema.disableForeignKeyConstraints()
await schema.enableForeignKeyConstraints()

await schema.withoutForeignKeyConstraints(async () => {
  // perform work with constraints disabled
})
```

Use this sparingly. It is usually only needed during destructive cleanup, import workflows, or carefully
controlled schema rewrites.

Holo-JS-specific backend rule:

- unsupported foreign-key operations fail closed instead of being guessed

## Migrations vs Models

This is the part that usually confuses people when they first use Holo-JS.

Use migrations to change the real database:

- `schema.createTable(...)`
- `schema.table(...)`
- `schema.renameTable(...)`
- `schema.dropTable(...)`

Use model files to type the application:

- models
- query builder
- insert/update/select inference
- relation metadata

Typical layout:

```text
server/models/User.ts
server/db/migrations/2026_03_29_120000_create_users_table.ts
```

The migration creates or changes the physical table. The model file gives the app its reusable typed
record definition.

## Practical Workflow

For a new feature, the normal order is:

1. Generate a migration with one of:
   - `holo make:migration create_users_table --create users`
   - `holo make:migration add_status_to_users_table --table users`
2. Write the `schema.createTable('users', ...)` or `schema.table('users', ...)` change.
3. Run `holo migrate`.
4. Update or create the matching `defineModel('users', { ... })` model file and import `../db/schema.generated`.
5. Build routes, factories, and seeders on top of that typed model definition.

That is the cleanest way to keep the operational database layer and the app-facing typed model in sync.
