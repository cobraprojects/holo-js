# Environment Variables

Holo reads secrets and per-machine settings from environment variables. Most of them are used inside `config/*.ts` files through `env()`, so you can rename or remove them by editing the config file. This page lists every variable Holo itself or its generated config files read.

## Env files and loading order

Holo loads `.env` files from your project root, then applies real environment variables on top. Later files override earlier ones, and real environment variables always win.

| Environment | Files, in order |
| --- | --- |
| `development` | `.env`, `.env.development`, `.env.local` |
| `production` | `.env`, `.env.production`, `.env.prod`, `.env.local` |
| `test` | `.env`, `.env.test` |

If both `.env.production` and `.env.prod` exist, `.env.production` is used and `.env.prod` is ignored with a warning.

The environment comes from `APP_ENV`. The `--env` option wins over a real environment variable, which wins over `APP_ENV` in `.env`. If none of them sets it, the environment is `production`. It must be `development`, `production`, or `test`; any other value stops Holo with an error.

```bash
APP_ENV=production npx holo start
npx holo migrate --env=test
```

::: warning
Commit `.env.example`, never `.env`. New projects generate both: `.env` with local values and `.env.example` with empty keys for teammates to copy.
:::

### Values and types

```ini
APP_NAME="My Blog"
APP_DEBUG=false
MAIL_PORT=587
```

- Quotes around values are removed. `\n`, `\r`, and `\t` are turned into real characters.
- On Windows, `%NAME%` is replaced with the value of the real environment variable `NAME`, and `%%` becomes a single `%`. A `%NAME%` whose variable isn't set stays as written. Variables from other `.env` files aren't used. macOS and Linux leave values unchanged.
- Lines starting with `#` are comments. A leading `export ` is allowed.
- When `env('KEY', fallback)` has a boolean fallback, `true`, `1`, `yes`, and `on` mean `true`, and `false`, `0`, `no`, and `off` mean `false`. A number fallback converts the value to a number. An empty value uses the fallback. A value that doesn't convert throws an error that names the variable, so a typo like `APP_DEBUG=ture` fails at startup instead of silently using the fallback.

## Runtime

These are read by Holo directly, not through config files.

| Variable | Default | Description |
| --- | --- | --- |
| `APP_ENV` | `production` | Picks the environment and which `.env` files load. See [Env files and loading order](#env-files-and-loading-order). |
| `NODE_ENV` | none | Not used to pick the environment. `holo start` sets it to `production` for the framework server. The running app reads the [config cache](/reference/cli#config-cache) when the resolved `APP_ENV` is `production` and a cache exists. |
| `PORT` | framework default | Port for `holo dev` and `holo start` when you don't pass `--port`. Must be a whole number up to 65535. |

## App

Used in `config/app.ts`. See [app.ts](/reference/config#app-ts).

| Variable | Default | Description |
| --- | --- | --- |
| `APP_NAME` | project name | App name. |
| `APP_KEY` | empty | Secret key for signing CSRF tokens and storage URLs and encrypting social tokens. Create it with `npx holo key:generate`. |
| `APP_URL` | `http://localhost:3000` (`5173` for SvelteKit) | Public URL of the app. Also used for the broadcast worker's allowed origins and auth endpoint. |
| `APP_TIMEZONE` | `UTC` | App timezone. |
| `APP_ENV` | `production` | `development`, `production`, or `test`. Sets `app.env` and decides whether `migrate:fresh`, `migrate:rollback`, and `seed` ask for confirmation. New projects set it to `development` in `.env`. |
| `APP_DEBUG` | `false` | Shows the messages of unexpected errors in SvelteKit responses. Nuxt's `useHoloDebug()` returns it. Next.js doesn't read it. Set `APP_DEBUG=true` in local `.env` files. |

## Database

Used in `config/database.ts`. See [database.ts](/reference/config#database-ts).

| Variable | Default | Description |
| --- | --- | --- |
| `DB_CONNECTION` | `main` | Default connection name. |
| `DB_DRIVER` | chosen at `holo new` | `sqlite`, `postgres`, or `mysql`. |
| `DB_URL` | `./storage/database.sqlite` (SQLite) | Connection URL or SQLite file path. |
| `DB_HOST` | `127.0.0.1` | Database host. |
| `DB_PORT` | `5432` (Postgres), `3306` (MySQL) | Database port. |
| `DB_USERNAME` | `postgres` / `root` | Database user. |
| `DB_PASSWORD` | empty | Database password. |
| `DB_DATABASE` | project name | Database name. |
| `DB_SCHEMA` | `public` | Postgres schema. |
| `DB_POOL_MAX` | `4` | Postgres: maximum pool size. |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Postgres: connection timeout. |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Postgres: idle connection timeout. |
| `DB_MAX_CONCURRENT_QUERIES` | `4` | Postgres: queries running at once. |
| `DB_QUERY_QUEUE_LIMIT` | `32` | Postgres: queries allowed to wait. |
| `DB_SSL` | none | `true` or `false`. Applied to the default connection when you run database commands from the CLI. |
| `DB_LOGGING` | none | `true` or `false`. Applied to the default connection when you run database commands from the CLI. |

## Redis

Used in `config/redis.ts`. See [redis.ts](/reference/config#redis-ts).

| Variable | Default | Description |
| --- | --- | --- |
| `REDIS_CONNECTION` | `default` | Default Redis connection name. |
| `REDIS_URL` | none | Full `redis://` or `rediss://` URL. Wins over host and port. |
| `REDIS_HOST` | `127.0.0.1` | Host. |
| `REDIS_PORT` | `6379` | Port. |
| `REDIS_USERNAME` | none | Username. |
| `REDIS_PASSWORD` | none | Password. |
| `REDIS_DB` | `0` | Database number. |

## Queue and cache

| Variable | Default | Description |
| --- | --- | --- |
| `QUEUE_CONNECTION` | driver chosen at install (`sync`) | Default [queue](/queue/) connection. |
| `CACHE_DRIVER` | driver chosen at install (`file`) | Default [cache](/cache/) store. |
| `CACHE_PREFIX` | empty | Prefix for every cache key. |

## Storage

Used in `config/storage.ts`. See [File Storage](/storage/).

| Variable | Default | Description |
| --- | --- | --- |
| `STORAGE_DEFAULT_DISK` | `local` | Default disk. |
| `STORAGE_ROUTE_PREFIX` | `/storage` | URL prefix for public files. |
| `STORAGE_DISKS_PUBLIC_ROOT` | `./storage/app/public` | Folder for the `public` disk. |
| `STORAGE_DISKS_S3_ACCESS_KEY_ID` | none | S3 access key. |
| `STORAGE_DISKS_S3_SECRET_ACCESS_KEY` | none | S3 secret key. |
| `STORAGE_DISKS_S3_REGION` | `us-east-1` | S3 region. |
| `STORAGE_DISKS_S3_BUCKET` | none | S3 bucket. |
| `STORAGE_DISKS_S3_URL` | none | Public base URL for S3 files. |
| `STORAGE_DISKS_S3_ENDPOINT` | none | Endpoint for S3-compatible services. |
| `STORAGE_DISKS_S3_FORCE_PATH_STYLE_ENDPOINT` | `false` | Use path-style S3 URLs. |

### Override any disk from the environment

Holo also checks `STORAGE_DISKS_<DISK>_<OPTION>` for **every** disk, even if your config file doesn't use `env()` for it. `<DISK>` is the disk name in upper case.

| Suffix | Disk option |
| --- | --- |
| `_DRIVER` | `driver` |
| `_ROOT` | `root` |
| `_URL` | `url` |
| `_VISIBILITY` | `visibility` |
| `_BUCKET` | `bucket` |
| `_REGION` | `region` |
| `_ENDPOINT` | `endpoint` |
| `_ACCESS_KEY_ID` | `accessKeyId` |
| `_SECRET_ACCESS_KEY` | `secretAccessKey` |
| `_SESSION_TOKEN` | `sessionToken` |
| `_FORCE_PATH_STYLE_ENDPOINT` | `forcePathStyleEndpoint` |

For example, `STORAGE_DISKS_MEDIA_BUCKET=blog-uploads` sets the bucket of a disk named `media`.

These overrides are read from the process environment when storage starts. Values that only exist in a `.env` file may not reach them, so for settings you want in `.env`, use `env()` in `config/storage.ts` instead.

## Media

Used in `config/media.ts`. See [Media Library](/media/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEDIA_DISK` | `public` | Disk for media in collections that don't set `disk()`. |

## Mail

Used in `config/mail.ts`. See [Mail Drivers](/mail/drivers).

| Variable | Default | Description |
| --- | --- | --- |
| `MAIL_MAILER` | `preview` | Default mailer. |
| `MAIL_FROM_ADDRESS` | `hello@app.test` | Default sender address. |
| `MAIL_FROM_NAME` | `Holo App` | Default sender name. |
| `MAIL_LOG_BODIES` | `false` | Include message bodies when using the `log` mailer. |
| `MAIL_HOST` | `127.0.0.1` | SMTP host. |
| `MAIL_PORT` | `1025` | SMTP port. |
| `MAIL_SECURE` | `false` | Use TLS for SMTP. |
| `MAIL_USERNAME` | none | SMTP user. |
| `MAIL_PASSWORD` | none | SMTP password. |

## Sessions

Used in `config/session.ts`. See [Sessions](/basics/session).

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_DRIVER` | `file` | Session store. |
| `SESSION_CONNECTION` | default database connection | Database connection for the `database` store. |
| `SESSION_COOKIE` | `holo_session` | Cookie name. |
| `SESSION_PATH` | `/` | Cookie path. |
| `SESSION_DOMAIN` | none | Cookie domain. |
| `SESSION_SECURE` | `false` | HTTPS-only cookie. Set `true` in production. |
| `SESSION_SAME_SITE` | `lax` | `lax`, `strict`, or `none`. |
| `SESSION_IDLE_TIMEOUT` | `120` | Minutes of inactivity before expiry. |
| `SESSION_LIFETIME` | `120` | Maximum session age in minutes. |
| `SESSION_REMEMBER_ME_LIFETIME` | `43200` | "Remember me" lifetime in minutes. |

## Auth

Used in `config/auth.ts`. See [Authentication](/auth/).

| Variable | Default | Description |
| --- | --- | --- |
| `AUTH_GUARD` | `web` | Default guard. |
| `AUTH_PASSWORD_BROKER` | `users` | Default password reset broker. |
| `AUTH_<PROVIDER>_CLIENT_ID` | none | [Social login](/auth/social-login) client ID. `<PROVIDER>` is `GOOGLE`, `GITHUB`, `DISCORD`, `FACEBOOK`, `APPLE`, or `LINKEDIN`. |
| `AUTH_<PROVIDER>_CLIENT_SECRET` | none | Social login client secret. |
| `AUTH_<PROVIDER>_REDIRECT_URI` | none | Social login callback URL. |
| `AUTH_WORKOS_PROVIDER` | `dashboard` | [WorkOS](/auth/workos) provider name. |
| `WORKOS_CLIENT_ID` | none | WorkOS client ID. |
| `WORKOS_API_KEY` | none | WorkOS API key. |
| `WORKOS_REDIRECT_URI` | none | WorkOS callback URL. |
| `AUTH_CLERK_PROVIDER` | `app` | [Clerk](/auth/clerk) provider name. |
| `CLERK_PUBLISHABLE_KEY` | none | Clerk publishable key. |
| `CLERK_SECRET_KEY` | none | Clerk secret key. |
| `CLERK_API_URL` | none | Clerk API URL. |
| `CLERK_FRONTEND_API` | none | Clerk frontend API. |
| `CLERK_REDIRECT_URI` | none | Clerk callback URL. |
| `CLERK_SESSION_COOKIE` | `__session` | Clerk session cookie name. |

`holo install auth` also writes `AUTH_EMAIL_VERIFICATION_ROUTE` and `AUTH_PASSWORD_RESET_ROUTE` to `.env`. The generated `config/auth.ts` doesn't read them; change the routes in `config/auth.ts` instead.

## Security and CORS

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_LIMIT_DRIVER` | `file` | [Rate limit](/basics/security/rate-limiting) store: `memory`, `file`, or `redis`. |
| `FRONTEND_URL` | `http://localhost:3000` | Origin allowed by `config/cors.ts`. |
| `FRONTEND_DOMAIN` | `localhost:3000` | Stateful domain in `config/cors.ts`. |

## Broadcasting

Used in `config/broadcast.ts`. See [Broadcast Drivers and Config](/broadcasting/drivers).

| Variable | Default | Description |
| --- | --- | --- |
| `BROADCAST_CONNECTION` | `holo` | Default broadcast connection. |
| `BROADCAST_APP_ID` | none | App ID shared by the app and the worker. |
| `BROADCAST_APP_KEY` | none | Public app key. |
| `BROADCAST_APP_SECRET` | none | Secret used to sign channel auth. |
| `BROADCAST_HOST` | `127.0.0.1` | Host the app and clients use to reach the worker. |
| `BROADCAST_PORT` | `8080` | Worker port. |
| `BROADCAST_SCHEME` | `http` | `https` turns on TLS. |

::: danger
Holo has no default for the broadcast app ID, key, or secret. `holo new` writes generated values into `.env`, and `holo install broadcast` does the same for an existing app. Set your own values in production.
:::

## Next steps

- [Configuration Files](/reference/config)
- [Production Checklist](/deployment/checklist)
