# Media Library

The media library attaches files to your models. You upload a post's cover image or a user's avatar, Holo stores it on a [storage disk](/storage/), records it in a `media` table, and can create resized copies such as thumbnails. If you know Spatie Media Library for Laravel, this works the same way.

## Quick example

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'
import { collection, conversion, defineMediaModel } from '@holo-js/media'

const Post = defineModel('posts', {
  fillable: ['title', 'body'],
})

export default defineMediaModel(Post, {
  collections: [
    collection('images').disk('public').singleFile(),
  ],
  conversions: [
    conversion('thumb')
      .performOnCollections('images')
      .width(400)
      .height(300)
      .format('webp'),
  ],
})
```

```ts [server/lib/posts.ts]
import Post from '../models/Post'

export async function setCoverImage(postId: number, image: File) {
  const post = await Post.findOrFail(postId)
  await post.addMedia(image).toMediaCollection('images')

  return {
    original: await post.getFirstMediaUrl('images'),
    thumbnail: await post.getFirstMediaUrl('images', 'thumb'),
  }
}
```

The image is saved to the `public` disk, a 400×300 WebP thumbnail is generated, and both URLs are ready to put in an `<img>` tag.

## Install

```bash
npx holo install media
npx holo migrate
```

`holo install media` adds `@holo-js/media` to your dependencies, creates `config/media.ts`, and writes a migration for the `media` table. `holo migrate` creates the table.

If the package is already installed and you only need the migration, run:

```bash
npx holo media:table
npx holo migrate
```

Media stores files through [File Storage](/storage/), so the disks you name below must exist in `config/storage.ts`. Image conversions use [sharp](https://sharp.pixelplumbing.com/), which `@holo-js/media` installs for you.

## Prepare a model

Wrap a normal [model](/orm/) with `defineMediaModel()` and export the result:

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'
import { collection, conversion, defineMediaModel } from '@holo-js/media'

const User = defineModel('users', {
  fillable: ['name', 'email'],
})

export default defineMediaModel(User, {
  collections: [
    collection('avatars').disk('public').singleFile(),
    collection('documents').disk('local'),
  ],
  conversions: [
    conversion('thumb').performOnCollections('avatars').width(128).height(128),
  ],
})
```

This adds media methods such as `addMedia()` and `getMedia()` to every `User` record, and a `media` relation. Collection and conversion names are typed: `toMediaCollection('avatar')` (a typo) is a type error.

You can also pass a function, which receives `collection` and `conversion` so you don't need to import them:

```ts
export default defineMediaModel(User, ({ collection, conversion }) => ({
  collections: [collection('avatars').singleFile()],
  conversions: [conversion('thumb').width(128)],
}))
```

## Collections

A collection is a named group of files on a model, such as `avatars` or `documents`. Each collection has its own disk and upload rules:

```ts
collection('avatars')
  .disk('public')
  .singleFile()
  .acceptsMimeTypes(['image/jpeg', 'image/png', 'image/webp'])
  .acceptsExtensions(['jpg', 'jpeg', 'png', 'webp'])
  .maxSize(5 * 1024 * 1024)
```

| Method | What it does |
| --- | --- |
| `disk(name)` | Disk for original files |
| `conversionsDisk(name)` | Disk for generated conversions. Defaults to the original file's disk |
| `singleFile()` | Keep one file. Adding a new one replaces the old one |
| `onlyKeepLatest(count)` | Keep the newest `count` files and delete older ones |
| `acceptsMimeTypes(types)` | Only accept files whose detected type is one of these |
| `acceptsExtensions(extensions)` | Only accept these file extensions (with or without the dot) |
| `maxSize(bytes)` | Reject files larger than this |

Every model also has a `default` collection, used when you call `toMediaCollection()` with no name. Any other name you haven't defined throws an error.

When a collection has no `disk()`, Holo stores its files on the media disk, set by `disk` in `config/media.ts`. New projects read it from `MEDIA_DISK`. The default is `public`. See [defineMediaConfig()](#definemediaconfig).

## Add media

`addMedia()` starts an upload. `toMediaCollection()` stores it:

```ts
const post = await Post.findOrFail(1)

await post.addMedia(file).toMediaCollection('images')
```

The model must be saved first. Adding media to a record without a primary key throws an error.

`addMedia()` accepts:

| Source | Example |
| --- | --- |
| A `File` or `Blob` from a form | `post.addMedia(input.image)` |
| A `Buffer`, `Uint8Array`, or `ArrayBuffer` | `post.addMedia(bytes).usingFileName('report.pdf')` |
| An object with contents | `post.addMedia({ contents: bytes, fileName: 'a.png' })` |
| A local file path | `post.addMedia('/tmp/upload-123.jpg')` or `post.addMedia({ path: '/tmp/upload-123.jpg' })` |

To download a file from a URL, use [addMediaFromUrl()](#add-media-from-a-url). To attach a file already stored on a disk, use [addMediaFromDisk()](#add-media-from-a-disk).

Local paths must be inside your system's temp folder or your project's `storage/` folder. Any other path throws, so a user-supplied path can't read arbitrary files from your server.

Before calling `toMediaCollection()` you can set:

```ts
await post
  .addMedia(bytes)
  .usingFileName('q3-report.pdf')
  .usingName('Q3 report')
  .onDisk('s3')
  .toMediaCollection('documents')
```

- `usingFileName()` sets the stored file name, which also decides the extension.
- `usingName()` sets a display name. It defaults to the file name without its extension.
- `onDisk()` overrides the collection's disk for this one file.

## Handle rejected uploads

When a file breaks a collection rule, `toMediaCollection()` doesn't throw. It returns a result with an `error`:

```ts [server/lib/posts.ts]
import { ValidationException } from '@holo-js/validation'

const result = await post.addMedia(input.image).toMediaCollection('images')

if (result.error) {
  throw ValidationException.withMessages({
    image: [result.error.message],
  })
}
```

Holo detects each file's type from its contents, never from the type the browser or a remote server reports. For text formats like CSV, JSON, and SVG, which have no recognizable contents, it uses the file extension. A file whose extension doesn't match its contents, such as text saved as `photo.png`, has no type and fails `acceptsMimeTypes()`.

`result.error.code` is `max_size_exceeded`, `invalid_mime_type`, or `invalid_extension`, and `result.error.message` is ready to show the user, for example "The selected file must be 2 MB or smaller." On success, `result.error` is `null` and the result is the new media item.

::: tip
Also validate uploads in your form schema with [file rules](/basics/validation/rules) such as `field.file().image().maxSize('2mb')`. The user then sees the error next to the field before any file is stored.
:::

## Add media from a URL

`addMediaFromUrl()` downloads a remote file and attaches it:

```ts
await post
  .addMediaFromUrl('https://images.example.com/hero.jpg')
  .toMediaCollection('images')
```

The file name comes from the URL path. Use `usingFileName()` when the URL doesn't end in a useful name.

::: warning
Remote downloads are limited to protect your server. Holo only fetches `http` and `https` URLs, refuses URLs that contain credentials or point at `localhost` or private network addresses, and doesn't follow redirects. Downloads are capped at the collection's `maxSize`, or 10 MB when the collection has none. A download must finish within 30 seconds, including reading the whole file. A failed or slow download throws an error.
:::

## Add media from a disk

`addMediaFromDisk()` attaches a file that's already on a [storage disk](/storage/), such as a file your app saved earlier with `Storage.disk('local').put()`:

```ts
await post
  .addMediaFromDisk('uploads/hero.jpg', 'local')
  .toMediaCollection('images')
```

Holo copies the file to the collection's disk. The original stays where it is, so you can delete it yourself once the media is saved. If the file doesn't exist on that disk, the call throws an error. A collection with `maxSize()` also needs the disk to report file sizes or stream files, and the call throws an error if it can do neither.

## Get media

```ts
const images = await post.getMedia('images')
const first = await post.getFirstMedia('images')
const hasImages = await post.hasMedia('images')
```

Items are returned in the order they were added. Calling `getMedia()` with no name returns the model's media from every collection.

To go straight to URLs:

```ts
await post.getFirstMediaUrl('images')
await post.getFirstMediaUrl('images', 'thumb')
await post.getMediaUrls('images', 'thumb')
```

These return `null` (or skip the item) when the file is on a private disk, or when the conversion hasn't been generated. `getFirstMediaPath()` and `getMediaPaths()` return the same URLs without the domain, such as `/storage/media/…/thumb.webp`.

### Files on private disks

For files on a private disk such as `local` or a private S3 bucket, create a [temporary URL](/storage/#temporary-urls):

```ts
const downloadUrl = await user.getFirstTemporaryUrl('documents', undefined, {
  expiresIn: 300,
})
```

The second argument is a conversion name. Pass `undefined` for the original file.

## Work with a media item

`getMedia()` and `getFirstMedia()` return `MediaItem` objects:

```ts
const image = await post.getFirstMedia('images')

if (image) {
  image.fileName
  image.mimeType
  image.size
  image.collectionName
  image.getUrl()
  image.getUrl('thumb')
  image.getTemporaryUrl('thumb', { expiresIn: 300 })
  image.getAvailableConversions()
}
```

`getAvailableConversions()` lists the conversions that have been generated for this file. `record` returns the full database row, and `toJSON()` returns it ready to send in an API response.

## Delete media

```ts
const image = await post.getFirstMedia('images')
await image?.delete()

await post.clearMediaCollection('images')
await post.clearMediaCollection()
```

Deleting a media item removes its database row, its original file, and its conversions. `clearMediaCollection()` with no name removes all of the model's media.

When you delete the model itself, its media is deleted too. For models with soft deletes, media is only removed on a force delete.

## The media table

Each file is one row in `media`:

| Column | Contents |
| --- | --- |
| `uuid` | Unique ID, also used in the file's path |
| `model_type`, `model_id` | The model the file belongs to |
| `collection_name` | Collection name |
| `name`, `file_name` | Display name and stored file name |
| `disk`, `conversions_disk` | Where the original and conversions are stored |
| `mime_type`, `extension`, `size` | File details |
| `path` | Path of the original on its disk |
| `generated_conversions` | JSON with each generated conversion's path and disk |
| `order_column` | Position within the collection |

Originals are stored at `media/<uuid>/original/<file name>` and conversions at `media/<uuid>/conversions/<conversion name>.<extension>`.

## Available methods

Every method and property a developer can call in the media library. Setup helpers come first, then the methods on models, the upload chain, media items, and the customization hooks.

**Setup helpers**

- [defineMediaModel()](#definemediamodel)
- [collection()](#collection)
- [conversion()](#conversion)
- [defineMediaConfig()](#definemediaconfig)

**Model methods** (on any model wrapped with `defineMediaModel()`; collection and conversion names are typed from your definition)

<div class="method-list">

- [addMedia()](#addmedia)
- [addMediaFromUrl()](#addmediafromurl)
- [addMediaFromDisk()](#addmediafromdisk)
- [getMedia()](#getmedia)
- [getFirstMedia()](#getfirstmedia)
- [hasMedia()](#hasmedia)
- [getMediaUrls()](#getmediaurls)
- [getFirstMediaUrl()](#getfirstmediaurl)
- [getMediaPaths()](#getmediapaths)
- [getFirstMediaPath()](#getfirstmediapath)
- [getFirstTemporaryUrl()](#getfirsttemporaryurl)
- [clearMediaCollection()](#clearmediacollection)
- [regenerateMedia()](#regeneratemedia)
- [media (relation)](#media-relation)

</div>

**Upload chain** (returned by `addMedia()`, `addMediaFromUrl()`, and `addMediaFromDisk()`)

- [usingFileName()](#usingfilename)
- [usingName()](#usingname)
- [onDisk()](#ondisk)
- [toMediaCollection()](#tomediacollection)

**Media item** (returned by `getMedia()` and `getFirstMedia()`)

<div class="method-list">

- [record](#record)
- [collectionName](#collectionname)
- [fileName](#filename)
- [mimeType](#mimetype)
- [size](#size)
- [getEntity()](#getentity)
- [getAvailableConversions()](#getavailableconversions)
- [getPath()](#getpath)
- [getUrl()](#geturl)
- [getTemporaryUrl()](#gettemporaryurl)
- [delete()](#delete)
- [regenerate()](#regenerate)
- [toJSON()](#tojson)

</div>

**Customization**

- [setMediaPathGenerator()](#setmediapathgenerator)
- [getMediaPathGenerator()](#getmediapathgenerator)
- [setMediaConversionExecutor()](#setmediaconversionexecutor)
- [getMediaConversionExecutor()](#getmediaconversionexecutor)
- [createDefaultMediaConversionExecutor()](#createdefaultmediaconversionexecutor)

### defineMediaModel()

Wraps a `defineModel()` model so it can hold media. Pass the collections and conversions as an object, or as a function that receives `collection` and `conversion`. See [Prepare a model](#prepare-a-model).

```ts
export default defineMediaModel(Post, {
  collections: [collection('images').disk('public')],
})
```

### collection()

Starts a named collection. Chain `disk()`, `singleFile()`, and the other options listed in [Collections](#collections).

```ts
collection('avatars').disk('public').singleFile()
```

### conversion()

Starts a named conversion. Chain `width()`, `format()`, and the other options listed in [Define a conversion](/media/conversions#define-a-conversion).

```ts
conversion('thumb').performOnCollections('images').width(400)
```

### defineMediaConfig()

Wraps the object you export from `config/media.ts`. The only option is `disk`, the default disk for collections that don't set `disk()`.

```ts [config/media.ts]
import { env } from '@holo-js/config'
import { defineMediaConfig } from '@holo-js/media'

export default defineMediaConfig({
  disk: env('MEDIA_DISK', 'public'),
})
```

### addMedia()

Starts attaching a file to the record. It returns a chain of [upload methods](#usingfilename) that stores nothing until you call `toMediaCollection()`. The source is a file, binary contents, or a local path. A string is always a path, never a URL.

```ts
await post.addMedia(input.image).toMediaCollection('images')
```

### addMediaFromUrl()

Same as `addMedia()`, but downloads the file from an `http` or `https` URL first. See [Add media from a URL](#add-media-from-a-url).

```ts
await post.addMediaFromUrl('https://images.example.com/hero.jpg').toMediaCollection('images')
```

### addMediaFromDisk()

Same as `addMedia()`, but copies a file that's already on a storage disk. The first argument is the file's path on that disk, and the second is the disk's name. See [Add media from a disk](#add-media-from-a-disk).

```ts
await post.addMediaFromDisk('uploads/hero.jpg', 'local').toMediaCollection('images')
```

### getMedia()

Returns every media item in a collection, or in all collections when you pass no name. Items come back in the order they were added.

```ts
const images = await post.getMedia('images')
```

### getFirstMedia()

Returns the first media item in a collection, or `null` when there is none.

```ts
const cover = await post.getFirstMedia('images')
```

### hasMedia()

Returns `true` when the record has at least one item in the collection (or in any collection when you pass no name).

```ts
if (await post.hasMedia('images')) {
  // show the gallery
}
```

### getMediaUrls()

Returns the public URL of every item in a collection. Pass a conversion name to get that conversion's URL instead. Items without that conversion, or on a private disk, are left out.

```ts
const thumbs = await post.getMediaUrls('images', 'thumb')
```

### getFirstMediaUrl()

Returns the public URL of the first item in a collection, or `null` when there is no public URL. Pass a conversion name to get that conversion's URL.

```ts
const thumb = await post.getFirstMediaUrl('images', 'thumb')
```

### getMediaPaths()

Same as `getMediaUrls()`, but returns paths without the domain, such as `/storage/media/…/thumb.webp`.

```ts
const paths = await post.getMediaPaths('images', 'thumb')
```

### getFirstMediaPath()

Same as `getFirstMediaUrl()`, but returns a path without the domain.

```ts
const path = await post.getFirstMediaPath('images')
```

### getFirstTemporaryUrl()

Returns a signed URL for the first item in a collection, valid for a limited time. It works for private disks. Pass `undefined` as the conversion name to get the original file.

```ts
const link = await user.getFirstTemporaryUrl('documents', undefined, { expiresIn: 300 })
```

### clearMediaCollection()

Deletes every item in a collection, along with their files. Pass no name to delete all of the record's media.

```ts
await post.clearMediaCollection('images')
```

### regenerateMedia()

Rebuilds conversions for every item in a collection. Pass conversion names to rebuild only those. See [Regenerate conversions](/media/conversions#regenerate-conversions).

```ts
await post.regenerateMedia('images', ['thumb'])
```

### media (relation)

The `media` relation returns the record's media rows. Load it with `with('media')` when you need the rows in the same query.

```ts
const post = await Post.with('media').findOrFail(1)
```

### usingFileName()

Sets the stored file name for this upload. The extension in the name decides the file's type.

```ts
await post.addMedia(bytes).usingFileName('q3-report.pdf').toMediaCollection('documents')
```

### usingName()

Sets the display name for this upload. Without it, the name is the file name without its extension.

```ts
await post.addMedia(input.image).usingName('Summer cover').toMediaCollection('images')
```

### onDisk()

Stores this upload on a different disk than the collection's `disk()`.

```ts
await post.addMedia(input.report).onDisk('s3').toMediaCollection('documents')
```

### toMediaCollection()

Stores the file in a collection and returns the result. It's the only method that writes anything. When the file breaks a collection rule, the result has an `error` instead of throwing. See [Handle rejected uploads](#handle-rejected-uploads).

```ts
const result = await post.addMedia(input.image).toMediaCollection('images')

if (result.error) {
  return result.error.message
}
```

### record

The full database row for this file, with every column.

```ts
const row = image.record
```

### collectionName

The name of the collection this file belongs to.

```ts
image.collectionName // 'images'
```

### fileName

The stored file name, such as `cover.jpg`.

```ts
image.fileName
```

### mimeType

The file's MIME type detected from its contents, or `null` when it isn't known.

```ts
image.mimeType // 'image/jpeg'
```

### size

The file's size in bytes.

```ts
image.size
```

### getEntity()

Returns the underlying database entity, for when you need the model's own methods on the row.

```ts
await image.getEntity().refresh()
```

### getAvailableConversions()

Lists the names of the conversions generated for this file. Conversions that haven't been generated yet aren't listed.

```ts
image.getAvailableConversions() // ['thumb']
```

### getPath()

Returns the path of the original file, or of a conversion when you pass its name. Returns `null` when there is no such conversion or the file is on a private disk.

```ts
image.getPath('thumb') // '/storage/media/…/thumb.webp'
```

### getUrl()

Returns the public URL of the original file, or of a conversion when you pass its name. Returns `null` for private disks or missing conversions.

```ts
image.getUrl('thumb')
```

### getTemporaryUrl()

Returns a signed URL for the original file or a conversion, valid for a limited time. Options are `expiresIn` (seconds) or `expiresAt`. See [Files on private disks](#files-on-private-disks).

```ts
image.getTemporaryUrl(undefined, { expiresIn: 300 })
```

### delete()

Deletes this file: its row, its original, and its conversions.

```ts
await image.delete()
```

### regenerate()

Rebuilds conversions for this file. Pass conversion names to rebuild only those. It returns the same item, so you can keep chaining.

```ts
await image.regenerate(['thumb'])
```

### toJSON()

Returns the database row in a form that's ready for `JSON.stringify()`.

```ts
return Response.json(image.toJSON())
```

### setMediaPathGenerator()

Replaces how original and conversion files are named on disk. Paths are relative to the disk root. Files that were already stored keep their saved paths. Call it from a [plugin boot module](/advanced/plugins#run-code-at-boot), which runs every time Holo starts, in the web server and in queue workers. Calling it from route code only changes that one process, so queued conversions would ignore it.

```ts
import { setMediaPathGenerator } from '@holo-js/media'

setMediaPathGenerator({
  originalPath({ uuid, fileName }) {
    return `uploads/${uuid}/${fileName}`
  },
  conversionPath({ uuid, conversion, generatedFileName, fileName }) {
    return `uploads/${uuid}/${conversion.name}-${generatedFileName ?? fileName}`
  },
})
```

Keep `uuid` in both paths so two uploads never share a path.

### getMediaPathGenerator()

Returns the path generator in use. Use it to wrap the default generator and change only part of the naming.

```ts
const base = getMediaPathGenerator()

setMediaPathGenerator({
  originalPath: input => base.originalPath(input).toLowerCase(),
  conversionPath: input => base.conversionPath(input),
})
```

### setMediaConversionExecutor()

Replaces the code that generates conversions. Pass nothing to go back to the built-in sharp executor. Register it the same way as the path generator. See [Custom conversion executor](/media/conversions#custom-conversion-executor).

```ts
const builtIn = createDefaultMediaConversionExecutor()

setMediaConversionExecutor({
  async generate(input) {
    return input.conversion.name === 'thumb' ? builtIn.generate(input) : null
  },
})
```

### getMediaConversionExecutor()

Returns the executor in use. Use it when you want to call the current executor from inside your own.

```ts
const current = getMediaConversionExecutor()
```

### createDefaultMediaConversionExecutor()

Creates a new copy of the built-in sharp executor. Use it inside a custom executor to handle the conversions you don't customize.

```ts
const builtIn = createDefaultMediaConversionExecutor()

setMediaConversionExecutor({
  generate: input => builtIn.generate(input),
})
```

## Next steps

- [Image conversions](/media/conversions): thumbnails, queued conversions, and regenerating files
- [File Storage](/storage/): configure the disks your media uses
- [Tutorial: media uploads](/tutorial/media-uploads)
