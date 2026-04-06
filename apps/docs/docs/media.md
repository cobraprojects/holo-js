# Media

Holo-JS media is a model-first media library inspired by Spatie Media Library. You define media
collections and conversions on a model, then attach files and retrieve URLs directly from that model.

The storage layer underneath is still Holo-JS storage, so media can live on `local`, `public`, or `s3`
disks.

Queued conversions are now backed by the queue subsystem instead of a dormant flag. See
[Queue And Media](/queue/media) for the queue-specific flow.

## Installation

Install the media package alongside DB and storage:

```bash
bun add @holo-js/media
```

`@holo-js/media` is not a framework adapter. It builds on top of `@holo-js/db` and `@holo-js/storage`.

## Create the media table

Create a `media` table before attaching files to models.

```ts
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up(schema) {
    await schema.createTable('media', (table) => {
      table.id()
      table.uuid('uuid').unique()
      table.string('model_type')
      table.string('model_id')
      table.string('collection_name').default('default')
      table.string('name')
      table.string('file_name')
      table.string('disk')
      table.string('conversions_disk').nullable()
      table.string('mime_type').nullable()
      table.string('extension').nullable()
      table.bigInteger('size')
      table.string('path')
      table.json('generated_conversions').default({})
      table.integer('order_column').default(1)
      table.timestamps()
      table.index(['model_type', 'model_id'])
      table.index(['model_type', 'model_id', 'collection_name'])
    })
  },
})
```

## Preparing a model

Wrap a normal Holo-JS model with `defineMediaModel`.

```ts
import { defineModel } from '@holo-js/db'
import { collection, conversion, defineMediaModel } from '@holo-js/media'

const BasePost = defineModel('posts', {
  fillable: ['title'],
})

export const Post = defineMediaModel(BasePost, {
  collections: [
    collection('images').disk('public'),
    collection('downloads').disk('s3'),
  ],
  conversions: [
    conversion('thumb')
      .performOnCollections('images')
      .width(368)
      .height(232)
      .fit('cover')
      .format('webp')
      .quality(80),
  ],
})
```

This adds a `media` relation and typed media methods to the model.

## Media collections

Collections define where files are stored and what rules apply to them.

```ts
collection('avatars')
  .disk('public')
  .singleFile()
  .acceptsMimeTypes(['image/jpeg', 'image/png', 'image/webp'])
  .acceptsExtensions(['jpg', 'jpeg', 'png', 'webp'])
  .maxSize(5 * 1024 * 1024)
```

Available collection options:

- `disk('public')`
- `conversionsDisk('s3')`
- `singleFile()`
- `onlyKeepLatest(5)`
- `acceptsMimeTypes([...])`
- `acceptsExtensions([...])`
- `maxSize(bytes)`

## Media conversions

Conversions define derived files for one or more collections.

```ts
conversion('thumb')
  .performOnCollections('images')
  .width(368)
  .height(232)
  .fit('cover')
  .format('webp')
  .quality(80)
```

Available conversion options:

- `performOnCollections(...)`
- `width(...)`
- `height(...)`
- `fit('cover' | 'contain' | 'fill' | 'inside' | 'outside')`
- `format('avif' | 'jpeg' | 'jpg' | 'png' | 'webp')`
- `quality(1..100)`
- `queued()`

## Adding media

Attach media directly from a model instance.

```ts
const post = await Post.findOrFail(1)

await post
  .addMedia('/tmp/hero.jpg')
  .usingFileName('hero.jpg')
  .toMediaCollection('images')
```

You can also attach binary content:

```ts
await post
  .addMedia(Buffer.from(pdfBytes))
  .usingFileName('report.pdf')
  .toMediaCollection('downloads')
```

Or attach from a structured input:

```ts
await post.addMedia({
  contents: fileBuffer,
  fileName: 'avatar.png',
  mimeType: 'image/png',
}).toMediaCollection('images')
```

Override the target disk for a specific add operation:

```ts
await post
  .addMedia(fileBuffer)
  .usingFileName('export.zip')
  .onDisk('s3')
  .toMediaCollection('downloads')
```

## Adding remote media

Use `addMediaFromUrl()` when the source file is remote.

```ts
await post
  .addMediaFromUrl('https://example.test/hero.jpg')
  .toMediaCollection('images')
```

You can still override the generated file name:

```ts
await post
  .addMediaFromUrl('https://example.test/archive')
  .usingFileName('archive.zip')
  .toMediaCollection('downloads')
```

## Retrieving media

Retrieve media items from the model directly:

```ts
const media = await post.getMedia('images')
const first = await post.getFirstMedia('images')
const hasImages = await post.hasMedia('images')
```

Retrieve URLs and paths directly:

```ts
await post.getFirstMediaUrl('images')
await post.getFirstMediaUrl('images', 'thumb')

await post.getFirstMediaPath('images')
await post.getFirstMediaPath('images', 'thumb')

await post.getMediaUrls('images', 'thumb')
await post.getMediaPaths('images', 'thumb')
```

For private or S3-backed files, use temporary URLs:

```ts
await post.getFirstTemporaryUrl('downloads', undefined, { expiresIn: 300 })
await post.getFirstTemporaryUrl('images', 'thumb', { expiresIn: 300 })
```

## Working with media items

`getMedia()` and `getFirstMedia()` return `MediaItem` objects.

```ts
const media = await post.getFirstMedia('images')

media?.getUrl()
media?.getUrl('thumb')
media?.getPath()
media?.getPath('thumb')
media?.getTemporaryUrl('thumb', { expiresIn: 300 })
media?.getAvailableConversions()
```

## Regenerating conversions

Regenerate conversions from the model:

```ts
await post.regenerateMedia('images')
await post.regenerateMedia('images', 'thumb')
await post.regenerateMedia('images', ['thumb'])
```

Or from a single media item:

```ts
const media = await post.getFirstMedia('images')
await media?.regenerate('thumb')
```

## Queued conversions

Mark heavier conversions with `.queued()`:

```ts
conversion('thumb')
  .performOnCollections('images')
  .width(368)
  .height(232)
  .format('webp')
  .queued()
```

Behavior depends on the configured queue driver:

- `sync` runs the queued conversion immediately
- `redis` enqueues `media.generate-conversions` for a worker
- `database` enqueues `media.generate-conversions` in the `jobs` table for a worker

Run a worker for async queue drivers:

```bash
bunx holo queue:work --connection redis --queue media
```

## Clearing and deleting media

Clear a whole collection:

```ts
await post.clearMediaCollection('images')
```

Delete one media item:

```ts
const media = await post.getFirstMedia('images')
await media?.delete()
```

## Example model

```ts
import { defineModel } from '@holo-js/db'
import { collection, conversion, defineMediaModel } from '@holo-js/media'

const BaseUser = defineModel('users', {
  fillable: ['name'],
})

export const User = defineMediaModel(BaseUser, {
  collections: [
    collection('avatars')
      .disk('public')
      .singleFile()
      .acceptsMimeTypes(['image/jpeg', 'image/png', 'image/webp']),
  ],
  conversions: [
    conversion('thumb')
      .performOnCollections('avatars')
      .width(256)
      .height(256)
      .fit('cover')
      .format('webp')
      .quality(80),
  ],
})
```

Usage:

```ts
const user = await User.findOrFail(1)

await user
  .addMedia('/tmp/avatar.jpg')
  .toMediaCollection('avatars')

const avatarUrl = await user.getFirstMediaUrl('avatars')
const thumbUrl = await user.getFirstMediaUrl('avatars', 'thumb')
```

## Current scope

Holo-JS media currently covers:

- collections
- conversions
- direct model retrieval methods
- remote downloads
- regeneration
- disk-aware URLs and temporary URLs

Not implemented yet:

- responsive images
- HTML helpers
- a custom-properties presentation layer
