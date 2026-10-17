# Upgrade Guide

Recent Holo-JS releases moved config helpers into the package for each feature, and split database, queue, cache, and storage drivers into their own packages. Your config objects and runtime code keep the same shape. Only imports and dependencies change.

Follow these steps in order.

## 1. Update all Holo packages together

Holo packages are released as one group. Update every `@holo-js/*` package in `package.json` to the same new version, then install:

```bash
npm install
```

Mixing versions of Holo packages is not supported.

## 2. Move config helper imports

Each `define...Config` helper now comes from the package for that feature. `env` stays in `@holo-js/config`.

| Helper | Old import | New import |
| --- | --- | --- |
| `defineAuthConfig` | `@holo-js/config` | `@holo-js/auth` |
| `defineBroadcastConfig` | `@holo-js/config` | `@holo-js/broadcast` |
| `defineCacheConfig` | `@holo-js/config` | `@holo-js/cache` |
| `defineDatabaseConfig` | `@holo-js/config` | `@holo-js/db` |
| `defineMailConfig` | `@holo-js/config` | `@holo-js/mail` |
| `defineMediaConfig` | `@holo-js/config` | `@holo-js/media/config` |
| `defineNotificationsConfig` | `@holo-js/config` | `@holo-js/notifications` |
| `defineQueueConfig` | `@holo-js/config` | `@holo-js/queue` |
| `defineRedisConfig` | `@holo-js/config` | `@holo-js/kernel` |
| `defineSecurityConfig` | `@holo-js/config` | `@holo-js/security` |
| `defineCorsConfig` | `@holo-js/config` | `@holo-js/security` |
| `defineSessionConfig` | `@holo-js/config` | `@holo-js/session` |
| `defineStorageConfig` | `@holo-js/config` | `@holo-js/storage` |

For example, `config/database.ts` changes like this:

```ts [config/database.ts]
import { defineDatabaseConfig, env } from '@holo-js/config' // [!code --]
import { env } from '@holo-js/config' // [!code ++]
import { defineDatabaseConfig } from '@holo-js/db' // [!code ++]

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: env('DB_URL', './storage/database.sqlite'),
    },
  },
})
```

The object you pass to each helper does not change.

## 3. Install the driver packages you use

Drivers are no longer bundled with the feature package. Install the package for each driver your config selects:

| If your config uses | Install |
| --- | --- |
| SQLite (`driver: 'sqlite'`) | `@holo-js/db-sqlite` |
| PostgreSQL (`driver: 'postgres'`) | `@holo-js/db-postgres` |
| MySQL (`driver: 'mysql'`) | `@holo-js/db-mysql` |
| Redis queue | `@holo-js/queue-redis` |
| Database queue or database failed-job storage | `@holo-js/queue-db` |
| Redis cache | `@holo-js/cache-redis` |
| Database cache | `@holo-js/cache-db` |
| S3 storage disk | `@holo-js/storage-s3` |

For example, an app on Postgres with a Redis queue and S3 files:

```bash
npm install @holo-js/db-postgres @holo-js/queue-redis @holo-js/storage-s3
```

Keep the feature packages too (`@holo-js/db`, `@holo-js/queue`, `@holo-js/storage`, and so on). Your app code still imports models, `dispatch`, `Storage`, and other APIs from them. Uninstall any driver package your config no longer uses.

If your code imports a driver directly, update the import:

| Old import | New import |
| --- | --- |
| SQLite adapter from `@holo-js/db` | `createSQLiteAdapter` from `@holo-js/db-sqlite` |
| Postgres adapter from `@holo-js/db` | `createPostgresAdapter` from `@holo-js/db-postgres` |
| MySQL adapter from `@holo-js/db` | `createMySQLAdapter` from `@holo-js/db-mysql` |
| Redis queue driver from `@holo-js/queue` | `redisQueueDriverFactory` from `@holo-js/queue-redis` |
| Database queue driver from `@holo-js/queue` | `databaseQueueDriverFactory` from `@holo-js/queue-db` |
| S3 driver from `@holo-js/storage/runtime/drivers/s3` | default export of `@holo-js/storage-s3` |

The `@holo-js/storage/runtime/drivers/s3` path no longer exists.

## 4. Move schema imports to `@holo-js/validation`

`@holo-js/forms` no longer exports schema builders, and the `@holo-js/forms/schema` entry has been removed. Import `schema` and `field` from `@holo-js/validation`:

```ts [shared/schemas/auth.ts]
import { field, schema } from '@holo-js/forms' // [!code --]
import { field, schema } from '@holo-js/validation' // [!code ++]

export const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})
```

Forms helpers such as `validate()` and `useForm()` accept these schemas directly.

## 5. Add the session revocations table (apps using auth)

Auth now records signed-out sessions in an `auth_session_revocations` table, which other-device logout depends on. New projects include this migration. Existing apps need to add it.

Create an empty migration:

```bash
npx holo make:migration create_auth_session_revocations
```

Replace its contents with the same migration new projects get:

```ts [server/db/migrations/2026_01_01_000000_create_auth_session_revocations.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ db }) {
    const stringType = db.getDialect().name === 'mysql'
      ? 'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'
      : 'VARCHAR(255)'
    await db.executeCompiled({
      sql: `CREATE TABLE auth_session_revocations (provider ${stringType} NOT NULL, user_id ${stringType} NOT NULL, generation INTEGER NOT NULL DEFAULT 0, retained_session_id ${stringType}, PRIMARY KEY (provider, user_id))`,
      source: 'schema',
    })
  },
  async down({ schema }) {
    await schema.dropTable('auth_session_revocations')
  },
})
```

Then run it:

```bash
npx holo migrate
```

The table is required whichever session store you use. On MySQL it requires MySQL 8.0.17 or later.

::: warning
After you deploy this change, users who are signed in through the browser must sign in again. Existing API tokens keep working.
:::

## 6. Plugin authors: depend on `@holo-js/kernel`

If you maintain a Holo plugin:

- Add `@holo-js/kernel` as a dependency.
- Import `defineHoloPlugin` and the plugin types from `@holo-js/kernel` instead of `@holo-js/cli`.
- Make sure plugin IDs and contribution names are unique. Holo rejects absolute paths and paths that point outside the plugin package.
- If your plugin adds a config file, register its normalizer with `registerConfigNormalizer` from `@holo-js/config`, and augment `HoloConfigRegistry` so `useConfig()` infers its type.

See [Writing Plugins](/advanced/plugins) for the full package layout.

## 7. Verify

Regenerate Holo's files and check that everything compiles and passes:

```bash
npx holo prepare
npm run typecheck
npm run build
```

Run your test suite as well. Fix any import errors the type checker reports; they point at the imports from steps 2 to 4. Then deploy as usual. Your deploy's build step runs `holo build`, which refreshes the generated files.

## Next steps

- [Configuration](/getting-started/configuration)
- [Packages](/reference/packages): what each `@holo-js/*` package is for
- [Deploying Holo Apps](/deployment/)
