# Configuration

Holo-JS uses server-side config files under `config/` plus layered env files. Framework config files are
not the source of truth for Holo-JS.

## Where configuration lives

```text
my-app/
├── config/
│   ├── app.ts
│   ├── database.ts
│   ├── queue.ts
│   ├── storage.ts
│   └── services.ts
├── .env
├── .env.example
└── server/
```

First-party packages use first-party config files. App-specific settings can live in custom files such as
`config/services.ts`.

## First-party config files

Typical built-in files:

- `config/app.ts`
- `config/database.ts`
- `config/queue.ts`
- `config/storage.ts`
- `config/media.ts` when media is installed

Example database config:

```ts
import { defineDatabaseConfig, env } from '@holo-js/config'

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: './storage/database.sqlite',
    },
    analytics: {
      driver: 'postgres',
      url: env('ANALYTICS_DATABASE_URL'),
    },
  },
})
```

Example storage config:

```ts
import { defineStorageConfig, env } from '@holo-js/config'

export default defineStorageConfig({
  defaultDisk: 'public',
  routePrefix: '/storage',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
    },
    public: {
      driver: 'public',
      root: './storage/app/public',
    },
    media: {
      driver: 's3',
      bucket: env('MEDIA_BUCKET'),
      region: env('MEDIA_REGION'),
      endpoint: env('MEDIA_ENDPOINT'),
      accessKeyId: env('MEDIA_ACCESS_KEY_ID'),
      secretAccessKey: env('MEDIA_SECRET_ACCESS_KEY'),
    },
  },
})
```

Example queue config:

```ts
import { defineQueueConfig, env } from '@holo-js/config'

export default defineQueueConfig({
  default: 'redis',
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'failed_jobs',
  },
  connections: {
    redis: {
      driver: 'redis',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: env('REDIS_HOST', '127.0.0.1'),
        port: env('REDIS_PORT', 6379),
        username: env('REDIS_USERNAME'),
        password: env('REDIS_PASSWORD'),
        db: env('REDIS_DB', 0),
      },
    },
  },
})
```

## Custom config files

App-owned config files live in the same directory.

```ts
// config/services.ts
import { defineConfig, env } from '@holo-js/config'

export default defineConfig({
  mailgun: {
    domain: env('MAILGUN_DOMAIN'),
    secret: env('MAILGUN_SECRET'),
  },
})
```

## Env file loading

Holo-JS loads env files by environment and then lets real process env values win.

Development:

- `.env`
- `.env.development`
- `.env.local`

Production:

- `.env`
- `.env.production`
- `.env.prod`
- `.env.local`

Test:

- `.env`
- `.env.test`

If both `.env.production` and `.env.prod` exist, `.env.production` wins and `.env.prod` is ignored with a
warning.

## Accessing config in code

Use typed file-level access when you want a whole section:

```ts
const services = useConfig('services')
const secret = services.mailgun.secret
```

Use dot-path access when you only need one value:

```ts
const secret = config('services.mailgun.secret')
```

Both access styles preserve autocomplete and value inference.

## Server-only rule

Secret-bearing config belongs in:

- env files
- server-only config files
- runtime code

Secret-bearing config does not belong in:

- client bundles
- browser-visible runtime config
- generated public assets
- docs examples with real credentials

## Config cache

Holo-JS supports explicit config caching for production-oriented runtime setups.

Generate a cache artifact:

```bash
holo config:cache
```

Clear it:

```bash
holo config:clear
```

Runtime resolution is simple:

- if a valid cache exists, Holo-JS reads the cache
- otherwise Holo-JS resolves `config/*.ts` plus layered env files

Development and test usually stay on live config. Production can use the cache when present.

## Continue

- [Directory Structure](/directory-structure)
- [Storage](/storage)
- [Queue](/queue/)
- [Runtime Services](/runtime-services)
