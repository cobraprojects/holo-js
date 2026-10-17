# Storage

Holo-JS storage follows a configurable named-disk pattern: configure disks once, then read and write files
through a facade or an explicit disk instance.

## Configuration

Configure storage in `config/storage.ts`.

```ts
import { defineStorageConfig } from '@holo-js/storage'
import { env } from '@holo-js/config'
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

## File metadata

Read file properties without downloading the whole file:

```ts
import { Storage, type StorageFileMetadata } from '@holo-js/storage/runtime'

const metadata: StorageFileMetadata | null = await Storage.disk('public').stat('uploads/report.txt')
```

`Storage.stat(path)` uses the default disk. `Storage.disk(name).stat(path)` and
`useStorage(name).stat(path)` use the selected disk. The exported `StorageFileMetadata`
type contains `readonly size: number` (bytes) and `readonly mimeType: string | null`.

The MIME type is detected from the first 64 KiB of the file's contents on every disk, so
local, public, and S3 disks report the same type for the same bytes. Upload declarations and
stored S3 content types do not affect it. Text formats without recognizable contents, such as
CSV, JSON, Markdown, and SVG, use the file extension. `mimeType` is `null` when the extension
names a binary format the contents do not match, such as text saved as `photo.png`, or when
neither the contents nor the extension are recognized. S3 disks read the
size and leading bytes with one signed ranged GET request. Custom sidecar data and S3 user
metadata do not affect the result.

Missing files return `null`, while empty files return a size of zero. Local directories
also return `null`. Paths resolve the same way as every other disk operation: separators
are normalized, a leading slash refers to the disk root, and `..` segments and local
symlinks escaping the disk root are rejected. Other filesystem and S3 failures throw;
invalid S3 object sizes are rejected.

Backends without the optional `StorageBackend.getItemStat(key, { sampleBytes })`
capability throw `StorageMetadataUnsupportedError`, exported from `@holo-js/storage/runtime`.
A backend implementing it returns the file `size` and up to `sampleBytes` leading bytes as
`sample`, or `null` when the file does not exist.

## Public URLs and temporary URLs

Use `url()` for public files:

```ts
const avatarUrl = Storage.disk('public').url('avatars/user-1.jpg')
```

Use `temporaryUrl()` for short-lived local or S3-compatible access:

```ts
const url = await Storage.disk('s3').temporaryUrl('exports/report.pdf', {
  expiresIn: 300,
})
```

Public and temporary local responses show images, audio, video, fonts, PDFs, and plain text
formats (`.txt`, `.csv`, `.json`, `.md`, `.css`) in the browser, based on the file's detected
type. Everything else is sent with `Content-Disposition: attachment`, including HTML,
JavaScript, SVG, XML, and files whose contents do not match their extension.

For a private local disk, use the same method with its disk name. Holo signs the URL with the
discovered application key and serves it through the host framework's existing storage route.
The signature binds the application origin, file path, disk and expiration; unsigned or expired requests cannot read
the file. Local responses use `Cache-Control: private, no-store`. Generate a fresh URL when displaying
the file rather than saving an expiring URL in the database.

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
