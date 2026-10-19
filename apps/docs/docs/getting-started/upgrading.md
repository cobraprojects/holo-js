# Upgrade Guide

## Upgrading from 0.3.x to 0.4.0

0.4.0 is in preparation. This section collects upgrade steps as the release changes land.

[Realtime](/realtime/) and [Broadcast](/broadcasting/) are **Experimental** in 0.4.0. Review their [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates. This label does not change runtime behavior.

### Apple callbacks and signing-key rotation

Serve your [Apple callback](/auth/social-login#apple) over HTTPS. Holo now sends its state cookie with `SameSite=None; Secure`, allowing Apple's cross-site form POST while keeping state validation. Keep the callback as a POST handler and exclude it from CSRF protection. No social-provider configuration changes are required.

Apple, Clerk, and WorkOS signing keys now expire after ten minutes. An unknown key ID can refresh them at most once per minute, and concurrent requests share the fetch. A newly rotated key may therefore take up to a minute to be accepted. Tokens with invalid signatures under a known key ID no longer trigger a fetch.

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

### Broadcast subscription errors and channel authorization

A refused channel subscription no longer closes the WebSocket. The worker sends `pusher:subscription_error` for that channel and keeps the connection open, so Flux keeps the browser's other channels and tries the refused channel again the next time you subscribe to it. If your own client waited for close code `4001` after a refused subscription, listen for `pusher:subscription_error` instead.

`holo broadcast:work` now checks unsigned private and presence subscriptions with the user from the connection's session cookie or `Authorization` header, and refuses them when nobody is signed in. Before, those rules received `null`. Subscriptions signed by `/broadcasting/auth` are unchanged.

The worker also stops sending internal error messages. Unexpected realtime errors reach clients as `Realtime request failed.`, failed publishes return `Broadcast publish failed.`, and the original errors go to your [error reporter](/basics/errors#reporting-errors). See [Errors](/broadcasting/production#errors).

### Queue jobs interrupted by a stopped worker

Queue workers now recover jobs left behind by a worker that crashed or was killed. With the `redis` driver, another worker picks the job up once at least the connection's `retryAfter` seconds have passed; before, it could stay stuck until you cleared it. A running Redis worker now renews its hold on the job, so jobs longer than `retryAfter` are no longer handed to a second worker.

An interrupted run counts as an attempt on both the `redis` and `database` drivers. When a recovered job has no `tries` left, the worker fails it into the [failed jobs table](/queue/failed-jobs) and calls its `onFailed` hook, instead of running it again. Raise `tries` on jobs that should survive a worker crash on their last attempt.

A `redis` or `database` connection's `retryAfter` must now be at least `1`. Before, `0` was accepted; now the config fails to load with `retryAfter must be greater than or equal to 1.` If you set it to `0`, remove it to use the default `90`, or set another whole number of seconds.

A job whose name isn't registered now fails into the failed jobs table and the worker keeps going. Before, the worker stopped with an error and left the job reserved. If you rename or delete jobs, drain their queued jobs first or retry them later with `npx holo queue:retry`. See [When a worker stops unexpectedly](/queue/workers#when-a-worker-stops-unexpectedly).

### Sensitive input in validation failures

Passwords and fields marked [`sensitive()`](/basics/validation/rules#sensitive) are now left out of every validation failure, including inside nested objects and arrays. This covers the 422 response in Next.js, Nuxt, and SvelteKit, `ValidationException` `values` and `toJSON()`, and `submission.fail()` and `submission.serialize()`. If your code reads a password back from a caught `ValidationException`, read it from the request instead.

In Nuxt, the cookie that flashes errors after a native form post no longer contains the submitted values, and it is marked `Secure` on HTTPS requests. `useValidationErrors()` works as before.

### Validation input limits

Form bodies and query strings are now limited to 1,000 non-file fields, with a separate limit of 1,000 uploaded-file entries per form, and a list index must be lower than the number of different indexes sent for that list. Requests that break these limits, or that use `__proto__`, `constructor`, `prototype`, or the same name used with two shapes (an object and a list, or numbered indexes and `[]`) in any order, fail validation with a 422 instead of throwing. Split forms that exceed either limit into smaller submissions; JSON can be used for larger non-file payloads. See [Input limits](/basics/validation/#input-limits).

A JSON or form body that can't be parsed is now validated as `{}` instead of throwing.

Errors thrown inside `custom()` and `customAsync()` are no longer turned into a validation message on `_root`. They reach your framework's error handling and respond with a 500. If a custom rule calls code that can throw for invalid input, catch the error in the rule and return a message string instead.

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

### Application environment from `APP_ENV`

The environment now comes only from `APP_ENV`. The `--env` option wins over `APP_ENV` from your shell, which wins over `APP_ENV` in `.env`. When none of them sets it, the environment is `production` instead of `development`. Holo uses that environment to pick which `.env` files load. `HOLO_ENV` is no longer read, and `NODE_ENV` no longer picks the environment. A value other than `development`, `production`, or `test` now stops Holo with an error instead of counting as `development`.

Before installing 0.4.0:

1. Add `APP_ENV=development` to your local `.env`. Without it, local commands and `holo dev` run as `production`.
2. Replace `HOLO_ENV` with `APP_ENV`, or with `--env`, in scripts, CI, and hosting settings.
3. Set `APP_ENV` anywhere you relied on `NODE_ENV` to pick the environment. For example, Vitest sets `NODE_ENV=test`, so set `APP_ENV: 'test'` in your test config as shown in [Testing](/testing/).
4. In `config/app.ts`, set the environment the way new projects do:

```ts [config/app.ts]
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  env: env('APP_ENV', 'production'),
})
```

If you use the config cache, run `npx holo config:cache` again on every server after upgrading. Holo ignores caches written by 0.3.x and loads `config/*.ts` until you rebuild the cache, because an old cache can hold the wrong environment. Mail previews check the environment from `APP_ENV` (or `--env`) rather than a cached `app.env`.

`holo start` now runs your framework server with `NODE_ENV=production`, even when your shell sets another value. Nuxt servers now pick their `.env` files from `APP_ENV` when they start, not from the environment the app was built in. In Nuxt, `useHoloEnv()`, `useHoloDebug()` and `useHoloDb()` now return the running app's values, and throw if called before Holo starts, so call them inside server routes or handlers. If you call `configureMailRuntime()` yourself without Holo, pass `environment`, or previews treat the app as `production`. See [Which `.env` files load](/getting-started/configuration#which-env-files-load).

### Encrypted session, remember-me, and CSRF cookies

Holo now encrypts the cookies it sets: the session cookie, the remember-me cookie, and `XSRF-TOKEN`. It uses AES-256-GCM with a key derived from `APP_KEY`, and rejects any cookie that was changed. Your own cookies, including ones written with `cookie()` or `cookies.make()`, are not encrypted.

Cookies set by 0.3.x can't be read after the upgrade. Every user is signed out once, remember-me cookies stop working, and the first form each browser submits with an old `XSRF-TOKEN` gets a `419` response. The next page load issues new cookies.

`APP_KEY` must be set wherever Holo sets these cookies. Without it, signing in and issuing the CSRF cookie throw an error. Run `npx holo key:generate` if your `.env` has no key. Changing `APP_KEY` later signs everyone out again.

If you call `sessionCookie()` or `rememberMeCookie()` from `@holo-js/session` directly, they now encrypt the value. Don't read the session ID or remember-me token back from the cookie yourself. Use [Auth](/auth/session-and-cookies) to resolve the current session. CSRF tokens from `csrf.token()` and `csrf.input()` are now random values with no signature, and are no longer the same string as the `XSRF-TOKEN` cookie value. Both are still accepted in the `_token` field and the `X-CSRF-TOKEN` header.

### CSRF tokens stored in the session

The CSRF token now lives in the visitor's [session](/basics/session), as in Laravel. The `XSRF-TOKEN` cookie carries that session token encrypted, and a token copied from another browser or planted by a subdomain no longer matches.

- **Tokens reissue after upgrading.** The first unsafe request each browser sends after the upgrade gets `419`, because its session has no token yet. The next page load stores a token in the session and issues a new `XSRF-TOKEN` cookie.
- **Install `@holo-js/session`.** CSRF protection needs it, so `holo install security` now adds it. If your app enables `csrf` without Auth, add `@holo-js/session` to your dependencies. Without a `config/session.ts`, Holo uses the default file session store.
- **Send the session cookie.** Visitors without a session get one on their first page load. Scripts and tests that post with only the `XSRF-TOKEN` cookie must also send the `holo_session` cookie (or your `session.cookie.name`).
- **`X-XSRF-TOKEN` is also accepted.** `_token` and `X-CSRF-TOKEN` still accept the plain token or the cookie value, so existing `fetch` calls keep working. The new `X-XSRF-TOKEN` header accepts the cookie value, as in Laravel.
- **Custom session stores need `setDataIfAbsent`.** The token is written with one atomic store call, so a rotation or logout that runs at the same moment can't bring back the old session. Built-in file, database and Redis stores support it. A custom store must add `setDataIfAbsent(sessionId, key, value)` before CSRF-protected pages load. Return `{ found: false }` for a missing or expired session without recreating it. Otherwise, preserve an existing key or insert the value if absent, then return `{ found: true, value: storedValue }`. For the reserved `_token` key, treat a non-string or empty value as absent and replace it atomically; preserve a valid token initialized by another request. Keep the session's other data and expiry unchanged.
- **`useForm` keeps server-rendered tokens.** A `_token` field already in the form, such as one from `csrf.input()`, is no longer replaced by the cookie value. With `csrf.endpoint`, the fetched token is sent in the `csrf.header` header from `config/security.ts` instead of always `X-CSRF-TOKEN`, and the cookie value is no longer added as `_token`. If the configured header is `X-XSRF-TOKEN`, the fetched token goes in `csrf.field` instead; that header accepts only encrypted cookie values.

### CSRF endpoints for separate frontends

For a separate frontend using `useForm({ csrf: { endpoint } })`, your token endpoint can now return `{ token, field }`. Use `const { name: field, value: token } = await csrf.field(request)`. The client sends the token in that field, so custom API CSRF names work without reading API cookies. Existing `{ token }` responses keep their current behavior.

### CORS wildcard origins with credentials

`config/cors.ts` can no longer combine `origins: ['*']` with `credentials: true`. Holo throws at startup instead of echoing every origin with credentials. List your frontend origins in `origins`, or set `credentials: false`. A wildcard origin now always answers `Access-Control-Allow-Origin: *`.

### Social sign-in links only verified accounts

Social sign-in no longer signs in as an existing user whose email isn't verified. When a provider's verified email matches such a user, `callback()` from `@holo-js/auth-social` throws `SocialAuthConflictError`. Catch it in your callback routes and ask the user to sign in with their password and verify their email; their next social sign-in links the accounts. See [Link an existing account](/auth/social-login#link-an-existing-account).

Email verification links now only verify the address they were sent to. If a user changes their email, links sent to the old address fail with `email_verification_token_expired`.

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
