# Configuration

Holo-JS keeps all backend settings in TypeScript files in the `config/` folder. Values that change between machines, like database passwords, come from `.env` files. Both are read on the server only.

```ts [config/app.ts]
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  name: env('APP_NAME', 'my-app'),
  key: env('APP_KEY'),
  url: env('APP_URL', 'http://localhost:3000'),
  timezone: env('APP_TIMEZONE', 'UTC'),
  debug: env('APP_DEBUG', true),
})
```

```ini [.env]
APP_NAME="My App"
APP_URL=http://localhost:3000
APP_DEBUG=true
```

## Config files

Each file in `config/` configures one feature. The file name is the config name: `config/queue.ts` is read with `useConfig('queue')`.

Every file default-exports its settings, wrapped in a `define...Config` helper that gives you autocomplete and type checking. Import each helper from the package for that feature:

| File | Helper | Import from |
| --- | --- | --- |
| `app.ts` | `defineAppConfig` | `@holo-js/config` |
| `database.ts` | `defineDatabaseConfig` | `@holo-js/db` |
| `redis.ts` | `defineRedisConfig` | `@holo-js/kernel` |
| `queue.ts` | `defineQueueConfig` | `@holo-js/queue` |
| `cache.ts` | `defineCacheConfig` | `@holo-js/cache` |
| `storage.ts` | `defineStorageConfig` | `@holo-js/storage` |
| `media.ts` | `defineMediaConfig` | `@holo-js/media/config` |
| `mail.ts` | `defineMailConfig` | `@holo-js/mail` |
| `notifications.ts` | `defineNotificationsConfig` | `@holo-js/notifications` |
| `broadcast.ts` | `defineBroadcastConfig` | `@holo-js/broadcast` |
| `auth.ts` | `defineAuthConfig` | `@holo-js/auth` |
| `session.ts` | `defineSessionConfig` | `@holo-js/session` |
| `security.ts` | `defineSecurityConfig` | `@holo-js/security` |
| `cors.ts` | `defineCorsConfig` | `@holo-js/security` |
| any other name | `defineConfig` | `@holo-js/config` |

The `env` helper always comes from `@holo-js/config`.

Config files can use `.ts`, `.mts`, `.js`, `.mjs`, `.cts`, or `.cjs`. If two files share a name, Holo uses the first in that order.

Each feature's page documents its own options. The [Configuration Files](/reference/config) reference lists them all.

## App settings

`config/app.ts` holds settings that apply to the whole app:

| Option | What it does | Default |
| --- | --- | --- |
| `name` | The app name | `'Holo'` |
| `key` | The secret key Holo uses for signing and encryption. See [Generate the app key](#generate-the-app-key) | `''` |
| `url` | The public URL of the app, used when Holo builds absolute URLs such as file links | `'http://localhost:3000'` |
| `timezone` | The server timezone, as an IANA name like `Europe/Berlin` | `'UTC'` |
| `debug` | Show detailed errors. Turn off in production | `true` |
| `env` | `'development'`, `'production'`, or `'test'` | `'development'` |
| `paths` | Where Holo looks for models, migrations, jobs, and so on. See [Project Structure](/getting-started/project-structure#changing-folder-locations) | the `server/` folders |
| `plugins` | Package names of Holo plugins to load. See [Writing Plugins](/advanced/plugins) | `[]` |

### Timezone

When the server starts, Holo sets the Node.js process timezone to `timezone`. That affects local `Date` methods, date strings without an offset, and `Intl.DateTimeFormat` without an explicit `timeZone`.

A few things don't change: `Date.toISOString()` and JSON dates stay in UTC, dates with an explicit offset keep it, and existing database values are not rewritten. Browsers keep using the visitor's timezone, so pass `config('app.timezone')` to the client if you need to format dates the same way there.

An invalid timezone name stops the app with an error at startup.

## Environment variables

Use `env()` in config files to read a value from your `.env` files or the process environment:

```ts [config/database.ts]
import { env } from '@holo-js/config'
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'postgres',
      host: env('DB_HOST', '127.0.0.1'),
      port: env('DB_PORT', 5432),
      username: env('DB_USERNAME', 'postgres'),
      password: env('DB_PASSWORD'),
      database: env('DB_DATABASE', 'my_app'),
    },
  },
})
```

`env()` works like this:

- `env('KEY')` returns the value as a string, or `''` if it isn't set.
- `env('KEY', fallback)` returns the fallback when the value is missing or empty.
- When the fallback is a number or boolean, the value is converted to that type. `env('DB_PORT', 5432)` returns a number. `env('APP_DEBUG', true)` accepts `true`, `false`, `1`, `0`, `yes`, `no`, `on`, and `off`.

Use `env()` in `config/` files, and read config values everywhere else. That keeps every setting in one place.

### Which `.env` files load

Holo picks an environment, then loads the files for it in order. Later files override earlier ones, and real environment variables override all files.

| Environment | Files, in load order |
| --- | --- |
| `development` | `.env`, `.env.development`, `.env.local` |
| `production` | `.env`, `.env.production`, `.env.prod`, `.env.local` |
| `test` | `.env`, `.env.test` |

If both `.env.production` and `.env.prod` exist, Holo uses `.env.production`, skips `.env.prod`, and prints a warning.

Holo picks the environment from the first of `HOLO_ENV`, `APP_ENV`, or `NODE_ENV` that is set in the process environment to `development`, `production`, or `test`. If none is set, it uses `development`.

::: warning
The environment is chosen before any `.env` file is read. Setting `APP_ENV=production` inside `.env` does not make Holo load `.env.production`. Set `NODE_ENV`, `APP_ENV`, or `HOLO_ENV` in the real environment instead, for example in your hosting provider's settings.
:::

### `.env.example`

New projects include a `.env.example` with every key the app reads and no secret values. Commit `.env.example`. Don't commit `.env` or the other env files; the generated `.gitignore` already excludes them.

## Reading config in your code

Import `useConfig` or `config` from `@holo-js/config` in any server code: route handlers, server actions, `load` functions, jobs, listeners, or commands.

```ts
import { config, useConfig } from '@holo-js/config'

const app = useConfig('app')
console.log(app.name, app.url)

const timezone = config('app.timezone')
```

- `useConfig('name')` returns a whole config file.
- `config('name.path.to.value')` returns one value by dot path. `useConfig` accepts dot paths too.

Both are fully typed. `config('app.')` autocompletes the keys of `config/app.ts`, and the return type matches the value.

## Custom config files

Add your own file to `config/` for app-specific settings, such as third-party API keys. Wrap it in `defineConfig`:

```ts [config/services.ts]
import { defineConfig, env } from '@holo-js/config'

export default defineConfig({
  mailgun: {
    domain: env('MAILGUN_DOMAIN'),
    secret: env('MAILGUN_SECRET'),
  },
  stripe: {
    secret: env('STRIPE_SECRET'),
    webhookTokenTtl: env('STRIPE_WEBHOOK_TTL', 300),
  },
})
```

Read it like any built-in config:

```ts
import { config, useConfig } from '@holo-js/config'

const services = useConfig('services')
const mailgunDomain = services.mailgun.domain

const stripeTtl = config('services.stripe.webhookTokenTtl')
```

Holo generates the types for your custom files, so `useConfig('services')` and `config('services.stripe.webhookTokenTtl')` autocomplete, and their return values are typed from your file. The types update while `holo dev` runs. If they look stale, run `npx holo prepare`.

## Keep config on the server

::: danger
Config files and `.env` values are for server code only. Never import `config/*.ts`, `useConfig`, or `config` in browser code, and never pass secret values to the client in page props or `load` results. If the client needs a setting, return only that one non-secret value from a server route.
:::

## Shared Redis connections

`config/redis.ts` defines named Redis connections. Queue, cache, session, rate-limit, and broadcast scaling settings refer to these connections by name, so you configure each Redis server once.

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

Each connection reaches Redis in one of these ways:

| To connect with | Set |
| --- | --- |
| A URL | `url`, such as `redis://user:pass@host:6379/0` |
| A Redis Cluster | `clusters`: an array of `{ host, port }` nodes. Cluster mode only supports `db: 0` |
| A Unix socket | `socketPath`, or a `host` that starts with `/` or `unix://` |
| Host and port | `host` and `port` (the default: `127.0.0.1:6379`) |

Set at most one of `url`, `clusters`, or a socket path on a connection. Holo stops with an error if you set more than one.

Redis is optional. The file exists in every project, but nothing connects to Redis until a feature is configured to use it.

## Generate the app key

`APP_KEY` is a random secret that Holo uses to:

- sign CSRF tokens
- sign temporary file URLs from [storage](/storage/)
- encrypt multi-factor auth secrets
- encrypt social login tokens, unless you set a separate key in `config/auth.ts`

New projects get a key automatically, because the `prepare` script runs `holo key:generate` when dependencies are installed. To create one yourself:

```bash
npx holo key:generate
```

The command writes a new 32-byte, base64-encoded key to `APP_KEY` in `.env` only if the key is missing or empty. It never replaces an existing key.

::: warning
Use a different `APP_KEY` in each environment and keep it out of git. In production, set it in your hosting provider's environment. If you change the key, existing CSRF tokens and temporary URLs stop working, and secrets encrypted with the old key, such as MFA secrets, can no longer be read.
:::

## Config cache

In production, Holo can load config from a cache file instead of evaluating every file in `config/` on each start.

```bash
npx holo config:cache
```

This writes `.holo-js/generated/config-cache.json`. To remove it:

```bash
npx holo config:clear
```

How the cache behaves:

- It is used only when the app runs in the `production` environment, and only if the cache was built for that same environment.
- It stores which env variable each value reads, not the value itself. Secrets are not written to the cache, and you can change env values without rebuilding it.
- It does not notice edits to `config/` files. Run `config:cache` again after changing config, or `config:clear` to go back to reading the files.

Build the cache as a deploy step, after `npm run build`. New projects include `config:cache` and `config:clear` package scripts for this.

## Available functions

**Defining config**

- [defineConfig()](#defineconfig)
- [defineAppConfig()](#defineappconfig)
- [defineSecurityConfig()](#definesecurityconfig)
- [defineCorsConfig()](#definecorsconfig)

**Reading config**

- [env()](#env)
- [config()](#config)
- [useConfig()](#useconfig)

**Plugins**

- [registerConfigNormalizer()](#registerconfignormalizer)

### defineConfig() {#defineconfig}

Wraps a custom file in `config/` so its values keep their types. Export the result as the default export.

```ts [config/services.ts]
import { defineConfig, env } from '@holo-js/config'

export default defineConfig({
  mailgun: { domain: env('MAILGUN_DOMAIN') },
})
```

### defineAppConfig() {#defineappconfig}

Wraps `config/app.ts`. It works like `defineConfig()` and adds the app settings type.

```ts [config/app.ts]
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  name: env('APP_NAME', 'Blog'),
})
```

See [app.ts](/reference/config).

### defineSecurityConfig() {#definesecurityconfig}

Wraps `config/security.ts`. Import it from `@holo-js/security`.

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: true,
})
```

See [Security](/basics/security/).

### defineCorsConfig() {#definecorsconfig}

Wraps `config/cors.ts`. Import it from `@holo-js/security`.

```ts [config/cors.ts]
import { defineCorsConfig } from '@holo-js/security'

export default defineCorsConfig({
  origins: ['https://app.example.com'],
})
```

See [CORS and proxies](/basics/security/cors-and-proxies).

### env() {#env}

Reads an environment variable. Without a fallback, a missing variable returns an empty string. With a fallback, the value is converted to the fallback's type: booleans accept `true`, `false`, `1`, `0`, `yes`, `no`, `on`, and `off`, and numbers use `Number()`. An empty or unrecognized value returns the fallback.

```ts
const port = env('REDIS_PORT', 6379)
const debug = env('APP_DEBUG', false)
```

### config() {#config}

Returns one config value by dot path, such as `config('app.name')`. It's typed from your config files.

```ts
const mailgunDomain = config('services.mailgun.domain')
```

### useConfig() {#useconfig}

Returns a whole config file (`useConfig('app')`) or one value by dot path (`useConfig('app.name')`). It's the same lookup as `config()`.

```ts
const app = useConfig('app')
```

### registerConfigNormalizer() {#registerconfignormalizer}

Adds a normalizer that fills in defaults for a config file, which is how plugins add their own typed config. It returns a function that removes the normalizer. Most apps don't need it; see [plugins](/advanced/plugins).

```ts
import { registerConfigNormalizer } from '@holo-js/config'

registerConfigNormalizer({
  name: 'audit',
  normalize: (value: { readonly table?: string } | undefined) => ({
    table: value?.table ?? 'audit_logs',
  }),
})
```

## Next steps

- [Configuration Files](/reference/config): every option for every config file
- [Environment Variables](/reference/environment): every env key Holo reads
- [Deploying Holo Apps](/deployment/)
