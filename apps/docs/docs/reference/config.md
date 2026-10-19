# Configuration Files

Every Holo setting lives in a file in your project's `config/` folder. This page lists each first-party config file, its options, and the default used when you leave an option out.

For an introduction to how config works, see [Configuration](/getting-started/configuration).

## How config files work

Each file exports one object, usually wrapped in its package's `define...Config()` helper for autocomplete:

```ts [config/cache.ts]
import { defineCacheConfig } from '@holo-js/cache'
import { env } from '@holo-js/config'

export default defineCacheConfig({
  default: env('CACHE_DRIVER', 'file'),
})
```

- The file name is the config name: `config/cache.ts` is read with `useConfig('cache')`.
- `.ts`, `.mts`, `.js`, `.mjs`, `.cts`, and `.cjs` all work.
- Every option is optional. Holo fills in the defaults below.
- `env('KEY', fallback)` reads an [environment variable](/reference/environment). When the fallback is a number or boolean, the value is converted to that type (`'true'`, `'1'`, `'yes'`, `'on'` become `true`). An empty value uses the fallback. A value that doesn't convert throws an error that names the variable.

### Reading config in your code

```ts
import { config, useConfig } from '@holo-js/config'

const app = useConfig('app')
const mailFrom = config('mail.from.email')
```

`useConfig()` returns a whole file or a nested value; `config()` takes a dot path. Both are fully typed, including your own config files.

### Your own config files

Add any file to `config/` and wrap it in `defineConfig()`:

```ts [config/services.ts]
import { defineConfig, env } from '@holo-js/config'

export default defineConfig({
  stripe: {
    secret: env('STRIPE_SECRET'),
  },
})
```

```ts
const stripeSecret = config('services.stripe.secret')
```

## app.ts

General app settings. Created by every new project.

```ts [config/app.ts]
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  name: env('APP_NAME', 'Blog'),
  key: env('APP_KEY'),
  url: env('APP_URL', 'http://localhost:3000'),
  timezone: env('APP_TIMEZONE', 'UTC'),
  debug: env('APP_DEBUG', false),
})
```

| Option | Default | Description |
| --- | --- | --- |
| `name` | `'Holo'` | Your app's name. |
| `key` | `''` | Secret key used to sign CSRF tokens and storage URLs, and to encrypt social login tokens. Generate it with `npx holo key:generate`. |
| `url` | `'http://localhost:3000'` | Public base URL of your app. |
| `timezone` | `'UTC'` | IANA timezone such as `'Europe/Berlin'`. Holo sets the server process timezone to this value. Invalid names are rejected at startup. |
| `debug` | `false` | Show detailed errors, including the messages of unexpected errors in SvelteKit. Set `APP_DEBUG=true` in local `.env` files and leave it unset or `false` in production. |
| `env` | `'development'` | `'development'`, `'production'`, or `'test'`. |
| `plugins` | `[]` | Active [plugin](/advanced/plugins) package names. `holo plugin:add` and `plugin:remove` edit this list. |
| `exceptions` | `{}` | `report(error, { capability, operation })` receives errors Holo catches in background work and your `report()` calls. `dontReport` lists error classes to skip. See [Reporting errors](/basics/errors#reporting-errors). |
| `paths` | see below | Where Holo looks for your files. |

### paths

| Key | Default |
| --- | --- |
| `models` | `server/models` |
| `migrations` | `server/db/migrations` |
| `seeders` | `server/db/seeders` |
| `factories` | `server/db/factories` |
| `observers` | `server/db/observers` |
| `commands` | `server/commands` |
| `jobs` | `server/jobs` |
| `events` | `server/events` |
| `listeners` | `server/listeners` |
| `authorizationPolicies` | `server/policies` |
| `authorizationAbilities` | `server/abilities` |
| `generatedSchema` | `.holo-js/generated/schema.generated.ts` |

## database.ts

Database connections. See [Database: Getting Started](/database/) and [Multiple Connections](/database/connections).

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
      database: env('DB_DATABASE', 'blog'),
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `defaultConnection` | first connection | Name of the connection used when you don't pick one. |
| `connections` | one SQLite connection | Named connections. A value can be an options object or a connection URL string. |

Connection options:

| Option | Description |
| --- | --- |
| `driver` | `'sqlite'`, `'postgres'`, or `'mysql'`. |
| `url` | Connection URL, or the file path for SQLite (new projects use `./storage/database.sqlite`). |
| `host`, `port`, `username`, `password`, `database` | Server connection details. |
| `schema` | Postgres schema. |
| `ssl` | `true`, or an options object passed to the driver. |
| `max` | Maximum pool size. |
| `connectionTimeoutMillis` | How long to wait for a connection. |
| `idleTimeoutMillis` | How long an idle pooled connection stays open. |
| `concurrency.maxConcurrentQueries` | Maximum queries running at once. |
| `concurrency.queueLimit` | Maximum queries waiting for a slot. |
| `logging` | Log queries. |
| `security.allowUnsafeRawSql` | Allow raw SQL that Holo would otherwise reject. |
| `security.debugSqlInLogs` | Include SQL text in logs. |

## redis.ts

Shared Redis connections. Queue, cache, session, rate limiting, and broadcast scaling refer to these by name. Created when you install a Redis-backed driver.

```ts [config/redis.ts]
import { env } from '@holo-js/config'
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: env('REDIS_CONNECTION', 'default'),
  connections: {
    default: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      username: env('REDIS_USERNAME'),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_DB', 0),
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `default` | `'default'` | Connection used when a feature doesn't name one. |
| `connections` | one connection to `127.0.0.1:6379`, db `0` | Named connections. |

Connection options: `url` (`redis://` or `rediss://`), `clusters` (a list of `{ host, port }` or `{ url }` nodes), `socketPath`, `host`, `port`, `username`, `password`, `db`. When `url` is set it wins; otherwise `clusters` is used if present; otherwise `host` and `port`.

## queue.ts

Queue connections. See [Queues](/queue/) and [Drivers and Tables](/queue/drivers).

```ts [config/queue.ts]
import { defineQueueConfig } from '@holo-js/queue'
import { env } from '@holo-js/config'

export default defineQueueConfig({
  default: env('QUEUE_CONNECTION', 'redis'),
  failed: false,
  connections: {
    redis: {
      driver: 'redis',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `default` | `'sync'` | Default connection name. |
| `failed` | database store, `failed_jobs` table | Where failed jobs are stored, or `false` to not store them. Options: `driver: 'database'`, `connection` (default `'default'`), `table` (default `'failed_jobs'`). |
| `connections` | one `sync` connection | Named connections. |

Connection options by driver:

| Driver | Options |
| --- | --- |
| `sync` | `queue` (default `'default'`). Runs jobs immediately, no worker needed. |
| `redis` | `connection` (a `config/redis.ts` name), `queue` (default `'default'`), `retryAfter` (seconds, default `90`), `blockFor` (seconds, default `5`). |
| `database` | `connection` (database connection, default `'default'`), `table` (default `'jobs'`), `queue` (default `'default'`), `retryAfter` (seconds, default `90`), `sleep` (seconds, default `1`). |

## cache.ts

Cache stores. See [Cache](/cache/) and [Cache Drivers](/cache/drivers).

```ts [config/cache.ts]
import { defineCacheConfig } from '@holo-js/cache'
import { env } from '@holo-js/config'

export default defineCacheConfig({
  default: env('CACHE_DRIVER', 'file'),
  prefix: env('CACHE_PREFIX', ''),
  drivers: {
    file: {
      driver: 'file',
      path: './storage/framework/cache/data',
    },
    redis: {
      driver: 'redis',
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `default` | `'file'` | Default store name. |
| `prefix` | `''` | Prefix added to every key. Each store can override it. |
| `drivers` | `file` and `memory` stores | Named stores. |

Store options by driver:

| Driver | Options |
| --- | --- |
| `file` | `path` (default `./storage/framework/cache/data`), `prefix`. |
| `memory` | `maxEntries`, `prefix`. Lives in one process only. |
| `redis` | `connection` (default `'default'`), `prefix`. |
| `database` | `connection` (default `'default'`), `table` (default `'cache'`), `lockTable` (default `'cache_locks'`), `prefix`. Run `npx holo cache:table` to create the tables. |

## storage.ts

File storage disks. See [File Storage](/storage/) and [Amazon S3](/storage/s3).

```ts [config/storage.ts]
import { defineStorageConfig } from '@holo-js/storage'
import { env } from '@holo-js/config'

export default defineStorageConfig({
  defaultDisk: env('STORAGE_DEFAULT_DISK', 'local'),
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
    },
    public: {
      driver: 'public',
      root: './storage/app/public',
      visibility: 'public',
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `defaultDisk` | `'local'` | Disk used by `Storage` when you don't name one. Must exist in `disks`. |
| `routePrefix` | `'/storage'` | URL prefix that serves files from public disks. |
| `disks` | `local` and `public` | Named disks. Your disks are merged with the defaults. |

Disk options:

| Option | Drivers | Description |
| --- | --- | --- |
| `driver` | all | `'local'`, `'public'`, or `'s3'`. |
| `root` | all | Folder (local) or key prefix (S3). Local default `./storage/app`, public default `./storage/app/public`. |
| `visibility` | all | `'private'` or `'public'`. |
| `url` | all | Public base URL for files on this disk. |
| `bucket`, `region`, `endpoint` | `s3` | Bucket details. Set `endpoint` for S3-compatible services. |
| `accessKeyId`, `secretAccessKey`, `sessionToken` | `s3` | Credentials. |
| `forcePathStyleEndpoint` | `s3` | Use path-style URLs (needed by MinIO and some other services). |

## mail.ts

Mailers. See [Mail](/mail/) and [Mail Drivers](/mail/drivers).

```ts [config/mail.ts]
import { defineMailConfig } from '@holo-js/mail'
import { env } from '@holo-js/config'

export default defineMailConfig({
  default: env('MAIL_MAILER', 'preview'),
  from: {
    email: env('MAIL_FROM_ADDRESS', 'hello@example.com'),
    name: env('MAIL_FROM_NAME', 'Blog'),
  },
  mailers: {
    smtp: {
      driver: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: env('MAIL_PORT', 1025),
      secure: env('MAIL_SECURE', false),
      user: env('MAIL_USERNAME') || undefined,
      password: env('MAIL_PASSWORD') || undefined,
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `default` | `'preview'` | Default mailer name. |
| `from` | none | Default sender: `{ email, name? }`. |
| `replyTo` | none | Default reply-to address: `{ email, name? }`. |
| `queue.queued` | `false` | Queue every mail instead of sending immediately. |
| `queue.connection`, `queue.queue` | queue defaults | Where queued mail goes. |
| `queue.afterCommit` | `false` | Wait for the current database transaction to commit before queueing. |
| `preview.allowedEnvironments` | `['development']` | Environments where mail previews are available. |
| `markdown.wrapper` | none | Custom wrapper for Markdown mail. |
| `mailers` | `preview`, `log`, `fake`, `smtp` | Named mailers. Each can override `from`, `replyTo`, and `queue`. |

Mailer options by driver:

| Driver | Options |
| --- | --- |
| `preview` | `path` (default `.holo-js/runtime/mail-preview`). Saves mail for [previewing](/mail/previewing). |
| `log` | `logBodies` (default `false`). Logs mail instead of sending. |
| `fake` | none. Records mail for [tests](/mail/testing). |
| `smtp` | `host` (default `127.0.0.1`), `port` (default `1025`), `secure`, `user`, `password`. |

## notifications.ts

See [Notifications](/notifications/).

| Option | Default | Description |
| --- | --- | --- |
| `table` | `'notifications'` | Table for [database notifications](/notifications/database). |
| `queue.connection`, `queue.queue` | queue defaults | Where queued notifications go. |
| `queue.afterCommit` | `false` | Wait for the database transaction to commit before queueing. |

## session.ts

Session storage and cookie. Created by `holo install auth`. See [Sessions](/basics/session).

| Option | Default | Description |
| --- | --- | --- |
| `driver` | `'file'` | Store name to use. Must exist in `stores`. |
| `stores` | `file` and `database` | Named stores (see below). |
| `cookie.name` | `'holo_session'` | Cookie name. |
| `cookie.path` | `'/'` | Cookie path. |
| `cookie.domain` | none | Cookie domain. |
| `cookie.secure` | `false` | Send only over HTTPS. Set `true` in production. |
| `cookie.httpOnly` | `true` | Hide the cookie from JavaScript. |
| `cookie.sameSite` | `'lax'` | `'lax'`, `'strict'`, or `'none'` (`'none'` requires `secure: true`). |
| `cookie.partitioned` | `false` | Partitioned cookie (requires `secure: true`). |
| `cookie.maxAge` | `absoluteLifetime` | Cookie lifetime in minutes. |
| `idleTimeout` | `120` | Minutes of inactivity before a session expires. |
| `absoluteLifetime` | `120` | Maximum session age in minutes. |
| `rememberMeLifetime` | `43200` | "Remember me" lifetime in minutes (30 days). |

Store options:

| Driver | Options |
| --- | --- |
| `file` | `path` (default `./storage/framework/sessions`). |
| `database` | `connection` (default `'default'`), `table` (default `'sessions'`). |
| `redis` | `connection` (a `config/redis.ts` name; defaults to the Redis default), `prefix`. |

## auth.ts

Authentication. Created by `holo install auth`. See [Authentication](/auth/) and [Guards and Providers](/auth/guards-and-providers).

| Option | Default | Description |
| --- | --- | --- |
| `defaults.guard` | `'web'` | Default guard. |
| `defaults.passwords` | `'users'` | Default password reset broker. |
| `guards` | `web`: session guard using `users` | Named guards: `{ driver: 'session' \| 'token', provider }`. |
| `providers` | `users`: model `User`, identifiers `['email']` | Named user providers: `{ model, identifiers? }`. |
| `passwords` | `users` broker | [Password reset](/auth/password-reset) brokers (see below). |
| `emailVerification` | `{ required: false, route: '/verify-email' }` | [Email verification](/auth/email-verification). Pass `true` to require it. |
| `multiFactor` | disabled | [Multi-factor auth](/auth/multi-factor). Pass `true` or an options object. |
| `personalAccessTokens.defaultAbilities` | `['*']` | Abilities given to new [API tokens](/auth/api-tokens). |
| `socialEncryptionKey` | `app.key` | Key for encrypting stored social login tokens. |
| `social` | `{}` | [Social login](/auth/social-login) providers. |
| `workos` | `{}` | [WorkOS](/auth/workos) settings. |
| `clerk` | `{}` | [Clerk](/auth/clerk) settings. |

Password broker options: `provider` (default `'users'`), `table` (default `'password_reset_tokens'`), `expire` (minutes, default `60`), `throttle` (minutes between reset emails, default `60`), `route` (default `'/reset-password'`).

Multi-factor options: `issuer` (default `'Holo'`), `challengeRoute` (default `'/mfa-challenge'`), `enrollmentTtl` (seconds, default `600`), `challengeTtl` (seconds, default `300`), `recoveryCodes` (default `8`), `allowedDriftSteps` (default `1`).

Social provider options: `clientId`, `clientSecret`, `redirectUri`, `scopes`, `guard`, `mapToProvider`, `encryptTokens`.

## security.ts

CSRF protection, rate limiting, and trusted proxies. Created by `holo install security` or `holo install auth`. See [Security Overview](/basics/security/).

```ts [config/security.ts]
import { defineSecurityConfig, limit } from '@holo-js/security'
import { env } from '@holo-js/config'

export default defineSecurityConfig({
  csrf: true,
  rateLimit: {
    driver: env('RATE_LIMIT_DRIVER', 'file'),
    limiters: {
      login: limit.perMinute(5).define(),
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `csrf` | disabled | `true` to enable with defaults, or an options object (below). |
| `csrf.enabled` | `false` | Turn on [CSRF protection](/basics/security/csrf). |
| `csrf.field` | `'_token'` | Form field name. |
| `csrf.header` | `'X-CSRF-TOKEN'` | Header name. |
| `csrf.cookie` | `'XSRF-TOKEN'` | Cookie name. |
| `csrf.except` | `[]` | Paths that skip CSRF checks. |
| `rateLimit.driver` | `'memory'` | `'memory'`, `'file'`, or `'redis'`. New projects use `'file'`. |
| `rateLimit.file.path` | `./storage/framework/rate-limits` | Folder for the file driver. |
| `rateLimit.redis.connection` | `'default'` | Redis connection name. |
| `rateLimit.redis.prefix` | `'holo:rate-limit:'` | Key prefix. |
| `rateLimit.limiters` | `{}` | Named [rate limiters](/basics/security/rate-limiting). |
| `trustedProxies` | `[]` | IP addresses or CIDR ranges of proxies whose `X-Forwarded-*` headers Holo trusts, or `'*'` to trust the proxy that connects. See [Trusted proxies](/basics/security/cors-and-proxies#trusted-proxies). |

## cors.ts

CORS headers. Created by `holo install security` or `holo install auth`. See [CORS and Proxies](/basics/security/cors-and-proxies).

| Option | Default | Description |
| --- | --- | --- |
| `paths` | `['/api/*']` | Paths that get CORS headers. |
| `origins` | `[]` | Allowed origins. |
| `methods` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` | Allowed methods. |
| `headers` | `Content-Type`, `Authorization`, `X-CSRF-TOKEN`, `X-XSRF-TOKEN`, `X-Requested-With` | Allowed request headers. |
| `credentials` | `false` | Allow cookies on cross-origin requests. |
| `maxAge` | `7200` | Seconds browsers may cache the preflight response. |
| `statefulDomains` | `[]` | Frontend domains (`host:port`) that use session cookies. |

## broadcast.ts

Broadcasting connections and the self-hosted worker. Created by `holo install broadcast`. See [Broadcast Drivers and Config](/broadcasting/drivers).

| Option | Default | Description |
| --- | --- | --- |
| `default` | `'null'` | Default connection name. New projects use `'holo'`. |
| `connections` | `log` and `null` | Named connections. |
| `worker` | see below | Settings for `holo broadcast:work`. |

Connection drivers: `holo` (the self-hosted worker), `pusher`, `log`, and `null`. `holo` and `pusher` take `appId`, `key`, `secret`, `options` (`host`, `port`, `scheme`, `useTLS`, `cluster`), and `clientOptions` (passed to the browser client, such as `authEndpoint`).

Worker options:

| Option | Default | Description |
| --- | --- | --- |
| `host` | `'0.0.0.0'` | Address the worker listens on. |
| `port` | `8080` | Port the worker listens on. |
| `path` | `'/app'` | WebSocket path. |
| `publicHost`, `publicPort` | none | Host and port clients connect to, when different (for example behind a proxy). |
| `publicScheme` | `'https'` | Scheme clients use. |
| `healthPath` | `'/health'` | Health check path. |
| `statsPath` | `'/stats'` | Stats path. |
| `statsEnabled` | `false` | Turn on the stats endpoint. |
| `allowedOrigins` | `['https://127.0.0.1']` | Origins allowed to connect. New projects use `APP_URL`. |
| `maxRequestBytes` | `1048576` | Maximum HTTP request size. |
| `maxMessageBytes` | `65536` | Maximum WebSocket message size. |
| `scaling` | `false` | `{ driver: 'redis', connection? }` to run several workers. See [Scaling in Production](/broadcasting/production). |

## media.ts

Created by `holo install media`. It has no built-in options yet; collections and conversions are set on each model. See [Media Library](/media/).

## Next steps

- [Environment Variables](/reference/environment)
- [Configuration](/getting-started/configuration)
- [CLI Commands](/reference/cli) — `config:cache` and `config:clear`
