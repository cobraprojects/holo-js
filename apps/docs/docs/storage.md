# Storage

Holo-JS storage follows a configurable named-disk pattern: configure disks once, then read and write files
through a facade or an explicit disk instance.

## Configuration

Configure storage in `config/storage.ts`.

```ts
import { defineStorageConfig, env } from '@holo-js/config'

export default defineStorageConfig({
  defaultDisk: 'local',
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
    s3: {
      driver: 's3',
      bucket: env('AWS_BUCKET'),
      region: env('AWS_REGION'),
      endpoint: env('AWS_ENDPOINT'),
      accessKeyId: env('AWS_ACCESS_KEY_ID'),
      secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    },
  },
})
```

## Disk types

Use `local` for private server files, `public` for files served from your app, and `s3` for AWS S3 or
compatible object storage.

Typical uses:

- `local`: imports, exports, private documents, generated artifacts
- `public`: files served by the app
- `s3`: object storage and CDN-backed media

## Using storage

Facade usage:

```ts
await Storage.put('reports/daily.txt', 'ready')
const contents = await Storage.get('reports/daily.txt')
```

Named disk:

```ts
const publicDisk = Storage.disk('public')
await publicDisk.put('avatars/user-1.jpg', file)
```

Composable-style helper:

```ts
const exportsDisk = useStorage('local')
```

## Public URLs and temporary URLs

Use `url()` for public files:

```ts
const avatarUrl = Storage.disk('public').url('avatars/user-1.jpg')
```

Use `temporaryUrl()` for short-lived S3-compatible access:

```ts
const url = await Storage.disk('s3').temporaryUrl('exports/report.pdf', {
  expiresIn: 300,
})
```

## Environment overrides

Storage defaults and per-disk options can be overridden through env values without moving secrets into
source control.

```txt
STORAGE_DEFAULT_DISK=public
STORAGE_ROUTE_PREFIX=/storage
STORAGE_DISKS_PUBLIC_ROOT=./storage/app/public
STORAGE_DISKS_S3_BUCKET=media-bucket
STORAGE_DISKS_S3_REGION=us-east-1
STORAGE_DISKS_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
```

Keep real credentials in env or provider secrets, not in docs or committed config files.

Storage stays independent from the database layer, so you can combine any supported storage driver with
any supported database driver without changing application logic.
