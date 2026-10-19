# File Storage

Holo stores files on named **disks**. A disk is a folder on your server or a bucket in object storage. You write and read files the same way whichever disk you use, so you can move from local files to [Amazon S3](/storage/s3) by changing config, not code.

## Quick example

```ts [server/lib/reports.ts]
import { Storage } from '@holo-js/storage/runtime'

export async function saveDailyReport(contents: string) {
  await Storage.put('reports/daily.txt', contents)
  return Storage.get('reports/daily.txt')
}
```

This writes `storage/app/reports/daily.txt` on the default `local` disk, then reads it back as a string.

## Install

Pick `storage` when you create the project:

```bash
npm create holo-js@latest my-app -- --package storage
```

This installs `@holo-js/storage` and `@holo-js/storage-s3`, writes `config/storage.ts`, and sets up the route that serves public files. See [Installation](/getting-started/installation) for every option.

To add storage to an existing project, install `@holo-js/storage` with your package manager and create `config/storage.ts` as shown below.

## Configure disks

Disks live in `config/storage.ts`:

```ts [config/storage.ts]
import { defineStorageConfig } from '@holo-js/storage'
import { env } from '@holo-js/config'

export default defineStorageConfig({
  defaultDisk: env('STORAGE_DEFAULT_DISK', 'local'),
  routePrefix: env('STORAGE_ROUTE_PREFIX', '/storage'),
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

Holo ships three drivers:

| Driver | Use it for | Visibility |
| --- | --- | --- |
| `local` | Private files on the server: imports, exports, invoices | Always private |
| `public` | Files your app serves to browsers: avatars, post images | Always public |
| `s3` | Amazon S3 and S3-compatible services. See [S3 and compatible](/storage/s3) | Private unless you set `visibility: 'public'` |

If you leave out `disks`, Holo uses the `local` and `public` disks shown above. If you leave out `defaultDisk`, Holo uses `local` when it exists, otherwise the first disk you define. Setting `defaultDisk` to a name you didn't define fails at startup.

You can add as many disks as you like, with any name:

```ts [config/storage.ts]
disks: {
  local: { driver: 'local', root: './storage/app' },
  exports: { driver: 'local', root: './storage/exports' },
  public: { driver: 'public', root: './storage/app/public' },
},
```

::: warning
A `local` disk can't be public. Setting `visibility: 'public'` on a `local` disk throws an error. Use the `public` driver for files that browsers should load.
:::

## Write files

```ts
import { Storage } from '@holo-js/storage/runtime'

await Storage.put('invoices/1001.pdf', pdfBytes)
await Storage.putJson('exports/orders.json', { total: 42 })
```

`put()` accepts a `string`, `Uint8Array`, `ArrayBuffer`, `Buffer`, or `Blob`. A browser `File` from a form upload is a `Blob`, so you can pass it straight in. Writing to an existing path replaces the file.

## Read files

```ts
const text = await Storage.get('reports/daily.txt')
const bytes = await Storage.getBytes('invoices/1001.pdf')
const orders = await Storage.json<{ total: number }>('exports/orders.json')
```

All three return `null` when the file doesn't exist.

## Check, copy, move, and delete

```ts
if (await Storage.exists('reports/daily.txt')) {
  await Storage.copy('reports/daily.txt', 'reports/archive/daily.txt')
}

await Storage.move('uploads/tmp.csv', 'imports/orders.csv')
await Storage.delete('reports/daily.txt')
await Storage.delete(['tmp/a.txt', 'tmp/b.txt'])
```

`missing()` is the opposite of `exists()`. `copy()` and `move()` return `false` when the source file doesn't exist.

## Use a specific disk

Every method on `Storage` uses the default disk. Call `Storage.disk(name)` to pick another one:

```ts
const avatars = Storage.disk('public')

await avatars.put(`avatars/${user.id}.jpg`, file)
const avatarUrl = avatars.url(`avatars/${user.id}.jpg`)
```

`useStorage(name)` returns the same disk methods, plus the low-level key methods listed under [Low-level key methods](#low-level-key-methods). Both are exported from `@holo-js/storage/runtime`.

## Public URLs

`url()` returns the address a browser can load:

```ts
const url = Storage.disk('public').url('avatars/42.jpg')
// http://localhost:3000/storage/avatars/42.jpg
```

Holo serves files on the `public` disk under `routePrefix` (`/storage` by default), prefixed with your app's `APP_URL`. Other disks that use the `public` driver are served under `/storage/__holo/<disk-name>/`. Set a disk's `url` option to point at a CDN instead:

```ts [config/storage.ts]
public: {
  driver: 'public',
  root: './storage/app/public',
  url: 'https://cdn.example.com',
},
```

Calling `url()` on a private disk throws. Use `get()` to read the file on the server, or a temporary URL to share it.

When Holo serves a public file, it shows images, audio, video, fonts, PDFs, and plain text formats (`.txt`, `.csv`, `.json`, `.md`, `.css`) in the browser. Everything else is sent as a download, including HTML, JavaScript, SVG, XML, and any file whose contents don't match its extension. This stops an uploaded file, even one renamed to `avatar.png`, from running scripts on your domain.

## Temporary URLs

A temporary URL gives someone access to a private file for a limited time:

```ts
const url = Storage.disk('local').temporaryUrl('invoices/1001.pdf', {
  expiresIn: 600,
})
```

Set either option:

| Option | Type | Meaning |
| --- | --- | --- |
| `expiresIn` | `number` | Seconds from now |
| `expiresAt` | `Date \| number \| string` | A point in time |

With no options the link lasts 5 minutes. Holo keeps the lifetime between 1 second and 7 days.

On `local` and `public` disks, Holo signs the link with your `APP_KEY` and serves it from your app's storage route. Anyone who changes the path, disk, or expiry gets a 404, and responses are sent with `Cache-Control: private, no-store`. Both `APP_KEY` and `APP_URL` must be set (see [Configuration](/getting-started/configuration)). On S3 disks, the link is a pre-signed S3 URL.

::: tip
Create a fresh temporary URL each time you render a page. Don't store them in the database, because they expire.
:::

## File size and type

`stat()` reads a file's size and type without downloading the whole file:

```ts
const info = await Storage.disk('public').stat('uploads/report.pdf')

if (info) {
  console.log(info.size, info.mimeType)
}
```

It returns `{ size, mimeType }`, where `size` is in bytes and `mimeType` is a string or `null` when the type isn't known. `stat()` returns `null` for missing files and for folders.

Holo detects the type from the file's contents. For text formats like CSV, JSON, Markdown, and SVG, which have no recognizable contents, it uses the file extension. A file whose extension doesn't match its contents, such as text saved as `photo.png`, gets `null`. Local and S3 disks give the same answer for the same file.

## List files

`listFiles()` returns one page of file paths in a folder, including files in subfolders:

```ts
let cursor: string | null = null

do {
  const page = await Storage.listFiles('exports', { cursor, limit: 200 })

  for (const path of page.paths) {
    console.log(path)
  }

  cursor = page.nextCursor
} while (cursor)
```

`limit` defaults to 100 and can be up to 1,000. Pass `nextCursor` back to get the next page. It is `null` on the last page.

## Stream large files

Use streams when a file is too large to hold in memory:

```ts
const stream = await Storage.disk('s3').readStream('backups/db.sql')

if (stream) {
  for await (const chunk of stream) {
    await processChunk(chunk)
  }
}
```

`readStream()` returns an `AsyncIterable<Uint8Array>`, or `null` when the file is missing. Set `chunkBytes` (from 4 KB to 1 MB, default 64 KB) to control the chunk size.

`writeStream()` takes any `AsyncIterable<Uint8Array>`:

```ts
const written = await Storage.disk('s3').writeStream('backups/db.sql', source, {
  overwrite: false,
})
```

With `overwrite: false`, it returns `false` instead of replacing a file that already exists.

## Unsupported operations

`stat()`, `listFiles()`, `readStream()`, and `writeStream()` need support from the disk's backend. Local and S3 disks support all four in Next.js, Nuxt, SvelteKit, and plain Node. When a custom backend doesn't support them, they throw one of these errors, all exported from `@holo-js/storage/runtime`:

| Method | Error |
| --- | --- |
| `stat()` | `StorageMetadataUnsupportedError` |
| `readStream()`, `writeStream()` | `StorageStreamingUnsupportedError` |
| `listFiles()` | `StoragePaginationError` |

`listFiles()` also throws `StoragePaginationError` for an invalid `limit` or a cursor from another folder or disk.

## Safe paths

Paths are always relative to the disk root. Holo rejects paths that contain `..` segments, so user input can't reach files outside the disk. Leading slashes are removed, so `/reports/a.txt` and `reports/a.txt` are the same file.

On local disks, symlinks can't lead outside the disk root either. Reads, writes, `delete()`, `removeItem()`, and `clear()` throw an error when the path goes through a symlink that points outside the disk. Deleting a symlink that points to another file on the same disk removes only the link.

Like Laravel, local disks create files with mode `0600` and folders with `0700` on private disks, and `0644` and `0755` on public disks. Your process umask can restrict them further.

## Override config with environment variables

Each disk option can be set from the environment, so you can change disks per environment without editing config. The variable name is `STORAGE_DISKS_<DISK NAME>_<OPTION>`:

```bash [.env]
STORAGE_DEFAULT_DISK=public
STORAGE_ROUTE_PREFIX=/files
STORAGE_DISKS_PUBLIC_ROOT=./storage/app/public
STORAGE_DISKS_PUBLIC_URL=https://cdn.example.com
```

| Suffix | Option |
| --- | --- |
| `DRIVER` | `driver` |
| `ROOT` | `root` |
| `URL` | `url` |
| `VISIBILITY` | `visibility` |
| `BUCKET` | `bucket` |
| `REGION` | `region` |
| `ENDPOINT` | `endpoint` |
| `ACCESS_KEY_ID` | `accessKeyId` |
| `SECRET_ACCESS_KEY` | `secretAccessKey` |
| `SESSION_TOKEN` | `sessionToken` |
| `FORCE_PATH_STYLE_ENDPOINT` | `forcePathStyleEndpoint` (`true`, `1`, `yes`, or `on`) |

These variables override the matching value in `config/storage.ts`.

## Method reference

All methods exist on `Storage` (default disk) and on `Storage.disk(name)`.

| Method | Returns | Description |
| --- | --- | --- |
| `put(path, contents)` | `Promise<boolean>` | Write a file |
| `putJson(path, value)` | `Promise<boolean>` | Write a value as JSON |
| `get(path)` | `Promise<string \| null>` | Read a file as text |
| `getBytes(path)` | `Promise<Uint8Array \| null>` | Read a file as bytes |
| `json<T>(path)` | `Promise<T \| null>` | Read and parse a JSON file |
| `exists(path)` | `Promise<boolean>` | Whether the file exists |
| `missing(path)` | `Promise<boolean>` | Whether the file doesn't exist |
| `delete(path \| paths)` | `Promise<boolean>` | Delete one or more files |
| `copy(from, to)` | `Promise<boolean>` | Copy a file |
| `move(from, to)` | `Promise<boolean>` | Move a file |
| `stat(path)` | `Promise<{ size, mimeType } \| null>` | File size and type |
| `listFiles(folder?, { cursor?, limit? })` | `Promise<{ paths, nextCursor }>` | One page of file paths |
| `readStream(path, { chunkBytes? })` | `Promise<AsyncIterable<Uint8Array> \| null>` | Read in chunks |
| `writeStream(path, source, { overwrite? })` | `Promise<boolean>` | Write from chunks |
| `path(path)` | `string` | Location on the backend: a file path under the disk root, or `s3://bucket/key` |
| `url(path)` | `string` | Public URL (public disks only) |
| `temporaryUrl(path, { expiresIn?, expiresAt? })` | `string` | Signed, expiring URL |

A disk object also has `name`, `driver`, and `visibility` properties.

## Available methods

Everything an app calls is listed here. Methods work the same on `Storage`, on `Storage.disk(name)`, and on `useStorage(name)`, unless a section says otherwise.

**Facade and config**
- [Storage](#storage) and [Storage.disk()](#storage-disk)
- [useStorage()](#usestorage)
- [defineStorageConfig()](#definestorageconfig)

**Writing**
- [put()](#put)
- [putJson()](#putjson)
- [writeStream()](#writestream)

**Reading**
- [get()](#get)
- [getBytes()](#getbytes)
- [json()](#json)
- [readStream()](#readstream)
- [stat()](#stat)

**Checking**
- [exists()](#exists)
- [missing()](#missing)

**Changing files**
- [copy()](#copy)
- [move()](#move)
- [delete()](#delete)

**Listing**
- [listFiles()](#listfiles)

**Locations**
- [path()](#path)
- [url()](#url)
- [temporaryUrl()](#temporaryurl)

**Disk properties**
- [name](#name), [driver](#driver), and [visibility](#visibility)

**Low-level key methods (useStorage only)**
- [getItem()](#low-level-key-methods), [getItemRaw()](#low-level-key-methods), [setItem()](#low-level-key-methods), [setItemRaw()](#low-level-key-methods)
- [hasItem()](#low-level-key-methods), [removeItem()](#low-level-key-methods), [getKeys()](#low-level-key-methods), [clear()](#low-level-key-methods)
- [getMeta()](#low-level-key-methods), [setMeta()](#low-level-key-methods), [removeMeta()](#low-level-key-methods)

**Errors**
- [StorageMetadataUnsupportedError](#storagemetadataunsupportederror), [StorageStreamingUnsupportedError](#storagestreamingunsupportederror), [StoragePaginationError](#storagepaginationerror)

### Storage

`Storage` runs each file method on the default disk.

```ts
import { Storage } from '@holo-js/storage/runtime'

await Storage.put('notes/today.txt', 'Shipped the export job')
```

### Storage.disk()

Returns a disk object for a named disk. It throws if the name isn't configured.

```ts
await Storage.disk('exports').put('orders.csv', csvText)
```

### useStorage()

`useStorage(name)` returns the named disk with its file methods and the [low-level key methods](#low-level-key-methods). Use it when you need raw backend access.

```ts
import { useStorage } from '@holo-js/storage/runtime'

const local = useStorage('local')
await local.setItem('cache:status', { ok: true })
```

### defineStorageConfig()

Wraps your disk config in `config/storage.ts` and returns it frozen, so TypeScript checks the shape.

```ts [config/storage.ts]
import { defineStorageConfig } from '@holo-js/storage'

export default defineStorageConfig({
  defaultDisk: 'local',
  disks: {
    local: { driver: 'local', root: './storage/app' },
  },
})
```

### put()

Writes a file, replacing any existing file at that path. Returns `true` once the write finishes.

```ts
await Storage.put('invoices/1001.pdf', pdfBytes)
```

### putJson()

Writes any value as JSON text. Returns `true` once the write finishes.

```ts
await Storage.putJson('exports/orders.json', { total: 42 })
```

### writeStream()

Writes an `AsyncIterable<Uint8Array>` in chunks. With `overwrite: false` it returns `false` if the file already exists, and with the default `overwrite: true` it replaces the file.

```ts
const written = await Storage.writeStream('backups/db.sql', source, { overwrite: false })
```

### get()

Reads a file as text, or returns `null` when it doesn't exist.

```ts
const report = await Storage.get('reports/daily.txt')
```

### getBytes()

Reads a file as a `Uint8Array`, or returns `null` when it doesn't exist.

```ts
const pdf = await Storage.getBytes('invoices/1001.pdf')
```

### json()

Reads a file and parses it as JSON. Returns `null` when the file is missing or empty.

```ts
const orders = await Storage.json<{ total: number }>('exports/orders.json')
```

### readStream()

Reads a file in chunks. Returns `null` when the file is missing. Pass `chunkBytes` (4 KB to 1 MB, default 64 KB) to change the chunk size.

```ts
const stream = await Storage.readStream('backups/db.sql', { chunkBytes: 65536 })
```

### stat()

Returns `{ size, mimeType }` for a file, or `null` for a missing file or a folder. `mimeType` comes from the file's contents and is `null` when the type isn't known. See [File size and type](#file-size-and-type).

```ts
const info = await Storage.stat('uploads/report.pdf')
```

### exists()

Returns `true` when a file exists at the path. It returns `false` for a folder.

```ts
if (await Storage.exists('reports/daily.txt')) {
  console.log('Report is ready')
}
```

### missing()

Returns `true` when no file exists at the path. It's the opposite of `exists()`.

```ts
if (await Storage.missing('reports/daily.txt')) {
  await Storage.put('reports/daily.txt', '')
}
```

### copy()

Copies a file to a new path. Returns `false` and writes nothing when the source doesn't exist.

```ts
await Storage.copy('reports/daily.txt', 'reports/archive/daily.txt')
```

### move()

Copies a file to a new path, then deletes the source. Returns `false` when the source doesn't exist.

```ts
await Storage.move('uploads/tmp.csv', 'imports/orders.csv')
```

### delete()

Deletes one path or an array of paths. It returns `true` even if a file was already missing.

```ts
await Storage.delete(['tmp/a.txt', 'tmp/b.txt'])
```

### listFiles()

Returns one page of file paths under a folder, including subfolders. `limit` defaults to 100 and must be 1 to 1,000. Pass `nextCursor` back as `cursor` to get the next page.

```ts
const page = await Storage.listFiles('exports', { limit: 200 })
```

### path()

Returns where the file lives on the backend: a filesystem path under the disk root for local disks, or `s3://bucket/key` for S3 disks.

Local disks store files under their exact names, so `path('exports/May report.csv')` returns `<root>/exports/May report.csv`. You can pass it straight to other tools. On Windows, local file and folder names must follow Windows naming rules: colons (including alternate data streams), reserved device names, invalid characters, and trailing dots or spaces are rejected by `path()` and file operations, and public and temporary URLs for such names return 404. POSIX disks keep supporting literal names such as `report:2026.txt`; S3 object names follow S3 rules.

On local disks, file names ending in `$` are reserved for [metadata](#low-level-key-methods), so writing or reading `prices.json$`, or asking for its `path()`, `url()`, or `temporaryUrl()`, throws an error.

```ts
const location = Storage.disk('s3').path('backups/db.sql')
```

### url()

Returns a public URL for a file. It throws on a private disk, so use [temporaryUrl()](#temporaryurl) there.

```ts
const avatar = Storage.disk('public').url('avatars/42.jpg')
```

### temporaryUrl()

Returns a signed URL that expires. Pass `expiresIn` (seconds) or `expiresAt` (a `Date`, timestamp, or date string). The default is 5 minutes, and the maximum is 7 days.

```ts
const link = Storage.disk('local').temporaryUrl('invoices/1001.pdf', { expiresIn: 600 })
```

### name

The disk's configured name, such as `'local'` or `'s3'`.

```ts
console.log(Storage.disk('exports').name) // 'exports'
```

### driver

The disk's driver: `'local'`, `'public'`, or `'s3'`.

```ts
if (Storage.disk('uploads').driver === 's3') {
  console.log('Stored in object storage')
}
```

### visibility

The disk's visibility: `'private'` or `'public'`. The `local` driver is always private, and the `public` driver is always public.

```ts
const isPublic = Storage.disk('public').visibility === 'public'
```

### Low-level key methods

These methods work on raw keys, where folders are separated by `:` and not `/`. Inside each folder or file name, only `%`, `:`, and `$` are escaped, as `%25`, `%3A`, and `%24`, so `exports/Q1: 100% done.csv` is the key `exports:Q1%3A 100%25 done.csv`. The file methods above convert `/` paths to keys for you, so prefer them for app code.

- **getItem(key)** returns a value parsed from JSON, or `null`. Use it with values written by `setItem()`.
- **getItemRaw(key)** returns the stored bytes or text, or `null`.
- **setItem(key, value)** stores a value as JSON.
- **setItemRaw(key, value)** stores a string or bytes as they are.
- **hasItem(key)** returns `true` when a key exists.
- **removeItem(key)** deletes a key.
- **getKeys(base?)** returns every key under a base key, or every key when `base` is omitted.
- **clear(base?)** deletes every key under a base key, or everything when `base` is omitted. On local disks, clearing everything empties the disk root folder and keeps the folder itself.
- **getMeta(key)**, **setMeta(key, value)**, and **removeMeta(key)** store a sidecar value for a key.

```ts
const local = useStorage('local')
await local.setItem('cache:status', { ok: true })
const keys = await local.getKeys('cache')
await local.clear('cache')
```

### StorageMetadataUnsupportedError

Thrown by `stat()` when the disk's backend can't report metadata.

### StorageStreamingUnsupportedError

Thrown by `readStream()` and `writeStream()` when the disk's backend can't stream.

### StoragePaginationError

Thrown by `listFiles()` for an invalid `limit`, an invalid or foreign `cursor`, or a folder the backend can't page.

```ts
import { StoragePaginationError } from '@holo-js/storage/runtime'

try {
  await Storage.listFiles('exports', { limit: 5000 })
} catch (error) {
  if (error instanceof StoragePaginationError) {
    console.log('Use a smaller page size')
  }
}
```

## Borrowing native files in package integrations

`withStorageFiles()` from `@holo-js/storage/runtime` lends an ordered `File[]` to a callback. Each source contains `path`, an optional configured `disk` name (the default disk when omitted), and an optional display `name` (the path basename when omitted). The callback's return type is preserved.

```ts
import { withStorageFiles } from '@holo-js/storage/runtime'
import { field, schema, validate } from '@holo-js/validation'

const gallery = schema({
  images: field.array(field.file().image().imageAspectRatio(['1:1', '16:9'])),
})

await withStorageFiles([
  { disk: 'uploads', path: 'pending/avatar.png', name: 'Avatar.png' },
  { disk: 'media', path: 'retained/banner.png' },
], async files => {
  await validate({ images: files }, gallery)
})
```

Files are genuine native Files with `slice()`, `stream()`, `bytes()`, `text()`, and `arrayBuffer()`. Local backends with native Blob support read from the original filesystem path; other backends stream into an OS temporary directory with private permissions. Assembly reads at most Holo's content inspection sample per file into memory, without loading the collection's contents. Backends without native Blob support must implement bounded streaming; otherwise borrowing throws `StorageStreamingUnsupportedError`.

MIME types come from Holo's existing content inspection using the stored path, independently of the supplied display name or remote Content-Type. Unrecognized types use `application/octet-stream`. Files have `lastModified: 0` because storage does not guarantee original modification timestamps. Content inspection does not replace schema image decoding or upload policy validation.

Await every read and validation inside the callback, and do not retain the files, their slices, or unfinished streams afterwards. Temporary files are removed when the callback settles, including failures and cancellation; original stored files are never removed. Native local Blobs require the original file to remain unchanged while being read. This borrowing contract does not revoke native local Files after return.

An optional `AbortSignal` is checked during acquisition and before and after the callback, and forwarded to supported storage streams, including S3 requests. A running callback must cooperate with cancellation; borrowing waits for it to settle before cleanup. A callback failure is rethrown unchanged unless cleanup also fails, in which case both errors are included in an `AggregateError`. Disk/path authorization, tenant checks, upload limits, and validation stay with the calling integration.

## Next steps

- [Amazon S3 and compatible](/storage/s3): store files in S3, Cloudflare R2, or MinIO
- [Media Library](/media/): attach uploads to models with image conversions
- [Forms](/basics/forms/): accept file uploads
