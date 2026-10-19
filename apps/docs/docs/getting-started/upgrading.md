# Upgrade Guide

## Upgrading from 0.3.x to 0.4.0

0.4.0 is in preparation. This section collects upgrade steps as the release changes land.

[Realtime](/realtime/) and [Broadcast](/broadcasting/) are **Experimental** in 0.4.0. Review their [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates. This label does not change runtime behavior.

### Forwarded headers follow Laravel's TrustProxies

Holo now reads forwarded headers exactly as Laravel's `TrustProxies` middleware does:

- Only `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Port`, `X-Forwarded-Proto`, and `X-Forwarded-Prefix` are honored. The `Forwarded` header is ignored. If your proxy sends only `Forwarded`, configure it to send `X-Forwarded-*` headers.
- When a header lists several values, Holo takes the first, not the last.
- `X-Forwarded-Proto` values other than `https`, `on`, `ssl`, and `1` mean HTTP instead of answering `400`.
- `X-Forwarded-Port` and `X-Forwarded-Prefix` now change the port and path of `resolveRequestUrl()`.
- `X-Forwarded-For` entries that aren't IP addresses are skipped instead of becoming the client IP.
- WorkOS sign-in sends WorkOS the client IP that Holo resolves through `trustedProxies`, instead of the first `X-Forwarded-For` entry or `X-Real-IP`.
- Nuxt requests that arrive over a Unix socket, including in `nuxt dev`, come from `127.0.0.1`. List `'127.0.0.1'` in `trustedProxies` to read forwarded headers from that proxy.
- When the framework doesn't expose the connection address, as in Next.js, forwarded headers are trusted only with `trustedProxies: '*'`. A Next.js app with a list of proxies now ignores them, and `ip(request)` throws. Use `'*'` and make sure the app is reachable only through your proxy. See [Next.js](/basics/security/cors-and-proxies#next-js).

### Realtime subscription isolation

Server subscriptions now authorize and execute independently, including subscriptions to the same query and arguments. No query definition or subscribe call changes are required. Check that each definition's `access` and handler restrict results to its caller; anonymous callers are rejected by authenticated definitions. Refreshes retain the caller’s authentication credentials and database without retaining a completed transaction. Mutation patches and backfill batches stay within the originating database. Size database capacity for one initial execution and independent refreshes per server subscription. Browser client store sharing is unchanged.

### Model scope grouping

Review model queries and relation constraints that use `orWhere()`. Caller conditions, each global scope, and the soft-delete filter now form separate groups joined with `AND`. Queries can no longer use `OR` to reach foreign-tenant or deleted rows, and instance writes remain limited to their target row. Existing method signatures are unchanged.

Use the existing `withoutGlobalScope()` / `withoutGlobalScopes()` and `withTrashed()` / `onlyTrashed()` controls when deliberately querying outside those filters; apply scope-removal methods before caller conditions as described in [Scopes](/orm/scopes).

### Mass assignment is closed by default

A model without `fillable` or `guarded` now rejects every column in `create()`, `update()`, `make()`, `fill()`, `set()`, property assignment, and query `update()`, `upsert()`, `increment()`, and `decrement()` extra values. Before, it allowed every column. Add a `fillable` list to each such model, or `guarded: []` to allow every column except the primary key and timestamps:

```ts [server/models/Post.ts]
export default defineModel('posts', {
  fillable: ['title', 'body', 'status'],
})
```

The primary key and the `created_at` and `updated_at` columns are now guarded unless you name them in `fillable`. `fillable: ['*']` and `guarded` lists no longer let request data write them. Holo still generates IDs and timestamps itself. Query `upsert()` rows that include `created_at` or `updated_at` now need those columns in `fillable`.

Mass assignment rules are now checked when you assign attributes, not when you save. `fill()`, `set()`, and property assignment throw the `SecurityError` immediately, and `save()` writes every changed column. A JSON path such as `settings->role` follows its column's rules. `forceFill()` assigns without checking, so the next `save()` writes the columns you pass it, even when they're guarded. Code that relied on `forceFill()` failing for guarded columns should use `fill()` instead.

Saving or deleting a loaded model now targets the row it was loaded from, even after its primary key changes. See [mass assignment](/orm/#mass-assignment).

### Error reporting

Errors Holo catches in background work, such as failing queue hooks, background cache refreshes, auth cleanup, and broadcast worker messages, now go through one reporter. Without configuration they are still written to the console, now with `console.error` and a `[holo:<capability>] <operation>` prefix instead of the previous per-package messages. To send them to your error tracker, add `exceptions.report` and, optionally, `exceptions.dontReport` to `config/app.ts`, and use `report(error)` from `@holo-js/core` for errors you handle yourself. See [Reporting errors](/basics/errors#reporting-errors).

### Queue jobs interrupted by a stopped worker

Queue workers now recover jobs left behind by a worker that crashed or was killed. With the `redis` driver, another worker picks the job up once at least the connection's `retryAfter` seconds have passed; before, it could stay stuck until you cleared it. A running Redis worker now renews its hold on the job, so jobs longer than `retryAfter` are no longer handed to a second worker.

An interrupted run counts as an attempt on both the `redis` and `database` drivers. When a recovered job has no `tries` left, the worker fails it into the [failed jobs table](/queue/failed-jobs) and calls its `onFailed` hook, instead of running it again. Raise `tries` on jobs that should survive a worker crash on their last attempt.

A `redis` or `database` connection's `retryAfter` must now be at least `1`. Before, `0` was accepted; now the config fails to load with `retryAfter must be greater than or equal to 1.` If you set it to `0`, remove it to use the default `90`, or set another whole number of seconds.

A job whose name isn't registered now fails into the failed jobs table and the worker keeps going. Before, the worker stopped with an error and left the job reserved. If you rename or delete jobs, drain their queued jobs first or retry them later with `npx holo queue:retry`. See [When a worker stops unexpectedly](/queue/workers#when-a-worker-stops-unexpectedly).

### Sensitive input in validation failures

Passwords and fields marked [`sensitive()`](/basics/validation/rules#sensitive) are now left out of every validation failure, including inside nested objects and arrays. This covers the 422 response in Next.js, Nuxt, and SvelteKit, `ValidationException` `values` and `toJSON()`, and `submission.fail()` and `submission.serialize()`. If your code reads a password back from a caught `ValidationException`, read it from the request instead.

In Nuxt, the cookie that flashes errors after a native form post no longer contains the submitted values, and it is marked `Secure` on HTTPS requests. `useValidationErrors()` works as before.

### S3 file names with special characters

S3 disks now store files under their exact names. Before 0.4.0, a name with characters other than letters, digits, and `-_.!~*'()` was stored under its URL-encoded form: `reports/Q1 café.pdf` became the object `reports/Q1%20caf%C3%A9.pdf`, and its `url()` returned access denied or not found. After upgrading, Holo looks for `reports/Q1 café.pdf`, so rename those objects before you deploy. With the AWS CLI:

```bash
bucket=my-app-assets
aws s3api list-objects-v2 --bucket "$bucket" --query "Contents[?contains(Key, '%')].Key" --output text \
  | tr '\t' '\n' \
  | while IFS= read -r key; do
      [ -n "$key" ] && [ "$key" != None ] || continue
      aws s3 mv "s3://$bucket/$key" "s3://$bucket/$(node -p 'decodeURIComponent(process.argv[1])' "$key")"
    done
```

Files on local disks keep their names. For those, `path()` now returns the file Holo actually wrote, such as `<root>/reports/Q1%20caf%C3%A9.pdf`. If you call the low-level `getKeys()` on an S3 disk, it now returns `:`-separated keys with URL-encoded names, the same as local disks.

S3 requests now time out, and `writeStream()` uploads parts of at most 64 MiB, so one stream can upload up to about 620 GiB. See [S3 timeouts](/storage/s3#timeouts).

### Database queue workers on MySQL

The `database` queue driver now needs MySQL 8.0.17 or later. Workers on MySQL and PostgreSQL skip jobs another worker is taking instead of waiting for them, so a MySQL worker no longer keeps retrying a job another worker already took. No config or code changes are required. See [Run several workers](/queue/drivers#run-several-workers).

### Node.js 22.14 or newer

Holo now requires Node.js 22.14 or newer on the 22 line, or Node.js 24 or 26. On Node.js 22.12 and 22.13 the SQLite driver crashes with a segmentation fault when it opens a database. Check `node --version` in development, CI and production, and upgrade Node.js 22 installations to 22.14 or newer before installing 0.4.0.

### Framework peer dependencies

Holo adapters now use your app's framework packages as peer dependencies instead of installing their own copies. Before you install 0.4.0, upgrade your framework to a release that fixes its published security advisories:

| Adapter | Required in your app's `package.json` |
| --- | --- |
| `@holo-js/adapter-next` | `next` 16.3.8 or newer on the 16 line, and `react` 19.2.6 or newer on the 19 line |
| `@holo-js/adapter-nuxt` | `nuxt` 4.5.1 or newer on the 4 line, and `vue` 3.5.13 or newer on the 3 line |
| `@holo-js/adapter-sveltekit` | `@sveltejs/kit` 2.70.2 or newer on the 2 line, and `svelte` 5.56.8 or newer on the 5 line |

`@holo-js/adapter-nuxt` no longer installs `h3` or `nitropack`. Its server routes and plugins use the h3 and Nitro that come with your Nuxt version. `@holo-js/adapter-sveltekit` no longer installs Svelte. It accepts any Svelte 5 release from 5.56.8 instead of one exact version.

Holo's own dependencies now require patched releases too: `ws` 8.21.0, `sharp` 0.35.5, and `mysql2` 3.22.0 or newer. Your package manager installs these for you. If your lockfile pins older versions, refresh it after upgrading.

### Encrypted session, remember-me, and CSRF cookies

Holo now encrypts the cookies it sets: the session cookie, the remember-me cookie, and `XSRF-TOKEN`. It uses AES-256-GCM with a key derived from `APP_KEY`, and rejects any cookie that was changed. Your own cookies, including ones written with `cookie()` or `cookies.make()`, are not encrypted.

Cookies set by 0.3.x can't be read after the upgrade. Every user is signed out once, remember-me cookies stop working, and the first form each browser submits with an old `XSRF-TOKEN` gets a `419` response. The next page load issues new cookies.

`APP_KEY` must be set wherever Holo sets these cookies. Without it, signing in and issuing the CSRF cookie throw an error. Run `npx holo key:generate` if your `.env` has no key. Changing `APP_KEY` later signs everyone out again.

If you call `sessionCookie()` or `rememberMeCookie()` from `@holo-js/session` directly, they now encrypt the value. Don't read the session ID or remember-me token back from the cookie yourself. Use [Auth](/auth/session-and-cookies) to resolve the current session. CSRF tokens from `csrf.token()` and `csrf.input()` are now random values with no signature, and are no longer the same string as the `XSRF-TOKEN` cookie value. Both are still accepted in the `_token` field and the `X-CSRF-TOKEN` header.

## Earlier 0.3.x releases

Recent Holo-JS releases moved config helpers into the package for each feature, and split database, queue, cache, and storage drivers into their own packages. Your config objects and runtime code keep the same shape. Only imports and dependencies change.

Follow these steps in order.

### 1. Update all Holo packages together

Holo packages are released as one group. Update every `@holo-js/*` package in `package.json` to the same new version, then install:

```bash
npm install
```

Mixing versions of Holo packages is not supported.

### 2. Move config helper imports

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

### 3. Install the driver packages you use

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

### 4. Move schema imports to `@holo-js/validation`

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

#### Read validation errors across framework boundaries

If you use `isValidationException(error)` to recognize a serialized response or framework-wrapped error, switch to `serializeValidationException(error)` from `@holo-js/validation`. It returns the failure payload, or `undefined` for unrelated errors:

```ts
import { serializeValidationException } from '@holo-js/validation'

const payload = serializeValidationException(error)
if (payload) {
  return payload
}
throw error
```

Read field messages from `payload.errors`. Keep `isValidationException()` when you need to narrow a live exception and call its error bag methods. Holo's adapters and `useForm()` handle transported failures automatically. See [Error Messages](/basics/validation/errors#add-errors-from-your-own-logic).

### 5. Add the session revocations table (apps using auth)

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

### 6. Plugin authors: depend on `@holo-js/kernel`

If you maintain a Holo plugin:

- Add `@holo-js/kernel` as a dependency.
- Import `defineHoloPlugin` and the plugin types from `@holo-js/kernel` instead of `@holo-js/cli`.
- Make sure plugin IDs and contribution names are unique. Holo rejects absolute paths and paths that point outside the plugin package.
- If your plugin adds a config file, register its normalizer with `registerConfigNormalizer` from `@holo-js/config`, and augment `HoloConfigRegistry` so `useConfig()` infers its type.

See [Writing Plugins](/advanced/plugins) for the full package layout.

### 7. Declare your trusted proxies

`HOLO_SECURITY_TRUST_PROXY` is gone. Holo now identifies visitors by their connection address, and reads forwarded headers only from proxies you list in `config/security.ts`:

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  trustedProxies: ['127.0.0.1', '::1'],
})
```

- Remove `HOLO_SECURITY_TRUST_PROXY` from your `.env` files.
- If you set it, list your proxies' addresses or ranges instead. Use `'*'` for a hosting platform whose proxy address you don't know. See [Trusted proxies](/basics/security/cors-and-proxies#trusted-proxies).
- Next.js apps need `trustedProxies`, because Next.js doesn't expose the connection address.
- Call `ip(request)` without the second argument. It now follows `trustedProxies`.

### 8. Verify

Regenerate Holo's files and check that everything compiles and passes:

```bash
npx holo prepare
npm run typecheck
npm run build
```

Run your test suite as well. Fix any import errors the type checker reports; they point at the imports from steps 2 to 4 and `ip()` calls from step 7. Then deploy as usual. Your deploy's build step runs `holo build`, which refreshes the generated files.

## Next steps

- [Configuration](/getting-started/configuration)
- [Packages](/reference/packages): what each `@holo-js/*` package is for
- [Deploying Holo Apps](/deployment/)
