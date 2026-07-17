# Architecture Package Upgrade

This release changes package ownership and import locations while preserving configuration object shapes and runtime method syntax.

## Config helper imports

Move feature helpers to their owning packages. Keep `env` in `@holo-js/config`.

| Previous import | New import |
| --- | --- |
| `defineAuthConfig` from `@holo-js/config` | `defineAuthConfig` from `@holo-js/auth` |
| `defineBroadcastConfig` from `@holo-js/config` | `defineBroadcastConfig` from `@holo-js/broadcast` |
| `defineCacheConfig` from `@holo-js/config` | `defineCacheConfig` from `@holo-js/cache` |
| `defineDatabaseConfig` from `@holo-js/config` | `defineDatabaseConfig` from `@holo-js/db` |
| `defineMailConfig` from `@holo-js/config` | `defineMailConfig` from `@holo-js/mail` |
| `defineMediaConfig` from `@holo-js/config` | `defineMediaConfig` from `@holo-js/media/config` |
| `defineNotificationsConfig` from `@holo-js/config` | `defineNotificationsConfig` from `@holo-js/notifications` |
| `defineQueueConfig` from `@holo-js/config` | `defineQueueConfig` from `@holo-js/queue` |
| `defineRedisConfig` from `@holo-js/config` | `defineRedisConfig` from `@holo-js/kernel` |
| `defineSecurityConfig` from `@holo-js/config` | `defineSecurityConfig` from `@holo-js/security` |
| `defineCorsConfig` from `@holo-js/config` | `defineCorsConfig` from `@holo-js/security` |
| `defineSessionConfig` from `@holo-js/config` | `defineSessionConfig` from `@holo-js/session` |
| `defineStorageConfig` from `@holo-js/config` | `defineStorageConfig` from `@holo-js/storage` |
| `defineHoloPlugin` from `@holo-js/cli` | `defineHoloPlugin` from `@holo-js/kernel` |
| Plugin author types from `@holo-js/cli` | Plugin author types from `@holo-js/kernel` |

Example:

```ts
import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'

export default defineAuthConfig({
  defaults: {
    guard: 'web',
  },
  providers: {
    users: {
      driver: 'model',
      model: 'User',
    },
  },
  password: {
    pepper: env('AUTH_PASSWORD_PEPPER'),
  },
})
```

## Concrete drivers

Install the concrete package selected by configuration. Driver classes and factories are imported from that package rather than an abstraction facade.

| Previous import | New import | Required package |
| --- | --- | --- |
| SQLite adapter from `@holo-js/db` | SQLite adapter from `@holo-js/db-sqlite` | `@holo-js/db-sqlite` |
| Postgres adapter from `@holo-js/db` | Postgres adapter from `@holo-js/db-postgres` | `@holo-js/db-postgres` |
| MySQL adapter from `@holo-js/db` | MySQL adapter from `@holo-js/db-mysql` | `@holo-js/db-mysql` |
| Redis queue driver from `@holo-js/queue` | Redis queue driver from `@holo-js/queue-redis` | `@holo-js/queue-redis` |
| Database queue driver from `@holo-js/queue` | Database queue driver from `@holo-js/queue-db` | `@holo-js/queue-db` |
| Database cache driver from `@holo-js/cache` | Database cache driver from `@holo-js/cache-db` | `@holo-js/cache-db` |
| Redis cache driver from `@holo-js/cache` | Redis cache driver from `@holo-js/cache-redis` | `@holo-js/cache-redis` |
| S3 driver from `@holo-js/storage/runtime/drivers/s3` | S3 driver from `@holo-js/storage-s3` | `@holo-js/storage-s3` |

Install only the implementations selected by the application configuration:

```bash
bun add @holo-js/db-postgres @holo-js/queue-redis @holo-js/storage-s3
```

With npm, pnpm, or Yarn, use the equivalent `npm install`, `pnpm add`, or `yarn add` command. Keep the abstraction package as well when application code uses its models, query APIs, queue APIs, cache APIs, or storage facade.

```ts
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { redisQueueDriverFactory } from '@holo-js/queue-redis'
import S3Driver from '@holo-js/storage-s3'
```

The old `@holo-js/storage/runtime/drivers/s3` entry no longer exists. Import the S3 driver directly from `@holo-js/storage-s3`.

Remove concrete driver packages that are no longer selected. Abstraction packages no longer install or discover concrete implementations through peer dependencies; configured drivers are resolved from typed kernel contributions.

## Plugin authors

Add `@holo-js/kernel` as a dependency and import plugin contracts from it. Plugin IDs and contribution names must be unique. Absolute paths and paths escaping the plugin package are rejected.

Feature and plugin config modules register their own normalizers with `registerConfigNormalizer` from `@holo-js/config` and augment `HoloConfigRegistry` for inference. See [Plugin Authoring](/plugins) for the complete package shape.

## Verification

After updating imports and dependencies:

```bash
bun install
bun run typecheck
bun run build
bun test
```

Regenerate framework artifacts with `holo build` before deploying.
