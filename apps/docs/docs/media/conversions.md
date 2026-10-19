# Image Conversions

A conversion is a resized or re-encoded copy of an uploaded image, such as a thumbnail or a WebP version of a large photo. You define conversions once on a model, and Holo generates them every time an image is added to the [media library](/media/).

## Quick example

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'
import { collection, conversion, defineMediaModel } from '@holo-js/media'

const Post = defineModel('posts', {
  fillable: ['title', 'body'],
})

export default defineMediaModel(Post, {
  collections: [
    collection('images').disk('public'),
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

```ts
await post.addMedia(image).toMediaCollection('images')

const thumbUrl = await post.getFirstMediaUrl('images', 'thumb')
```

When `addMedia()` finishes, the `thumb` file is already stored next to the original.

## Define a conversion

Start with `conversion(name)` and chain the options you need:

| Method | What it does |
| --- | --- |
| `performOnCollections(...names)` | Only run for these collections. Without it, the conversion runs for every collection on the model |
| `width(pixels)` | Target width |
| `height(pixels)` | Target height |
| `fit(mode)` | How the image fills `width` × `height`: `'cover'` (default), `'contain'`, `'fill'`, `'inside'`, or `'outside'` |
| `format(format)` | Output format: `'webp'`, `'avif'`, `'jpeg'`, `'jpg'`, or `'png'` |
| `quality(value)` | Output quality from 1 to 100 |
| `queued()` | Generate later on a queue worker. See [Queued conversions](#queued-conversions) |
| `nonQueued()` | Generate during the upload (the default) |

A few things happen automatically:

- Only images get conversions. When a PDF or ZIP file is added to a collection, its conversions are skipped and the file is stored as-is.
- Images are never made larger than the original.
- Images are rotated to match their camera orientation.
- Without `format()`, the conversion keeps the original's format when it is WebP, AVIF, JPEG, or PNG, and uses PNG otherwise.
- Without `quality()`, WebP and JPEG use 82 and AVIF uses 80.

Conversion names must be unique on a model, and `performOnCollections()` can only name collections you defined. Breaking either rule throws an error when the model loads.

## Store conversions on another disk

By default, conversions are saved on the same disk as the original. Use `conversionsDisk()` on the collection to put them somewhere else:

```ts
collection('photos')
  .disk('local')
  .conversionsDisk('public')
```

This keeps full-size originals private while thumbnails are public.

## Queued conversions

Large images or many conversions can make uploads slow. Mark a conversion with `.queued()` to generate it on a [queue worker](/queue/workers) instead:

```ts
conversion('large')
  .performOnCollections('images')
  .width(2400)
  .format('avif')
  .queued()
```

When the media is added, Holo generates any non-queued conversions, stores the original and the conversions, and then dispatches a `media.generate-conversions` job on the `media` queue. Images are generated before the database transaction starts, so a slow resize doesn't hold the transaction open. Images are limited to 40 million pixels and 1,000 frames, the same limits upload validation uses. If the upload happens inside a [database transaction](/database/transactions), the job is dispatched only after the transaction commits.

What happens next depends on your [queue driver](/queue/drivers):

- With `sync`, the job runs right away, so the conversion is ready when `addMedia()` returns.
- With `redis` or `database`, the job waits for a worker. Run one that listens on the `media` queue:

```bash
npx holo queue:work --queue media
```

Until the worker finishes, `getUrl('large')` and `getFirstMediaUrl('images', 'large')` return `null`. Show the original or a placeholder in the meantime.

If the media is deleted before the job runs, the job finishes without doing anything. A conversion job that throws is handled like any other failed job. See [Failed jobs](/queue/failed-jobs).

## Regenerate conversions

Regenerate conversions after you change a conversion's settings, add a new conversion, or lose generated files.

From the command line:

```bash
npx holo media:regenerate
npx holo media:regenerate Post User
npx holo media:regenerate Post --only=thumb
npx holo media:regenerate --ids=1,2,3
npx holo media:regenerate --only-missing
```

| Argument or flag | Meaning |
| --- | --- |
| `ModelName ...` | Only media for these models. Without names, every model with media is processed |
| `--ids=1,2,3` | Only these rows in the `media` table. These are media IDs, not model IDs |
| `--only=thumb,large` | Only these conversions |
| `--only-missing` | Skip conversions whose files still exist |

`--ids` and `--only` accept comma-separated values or can be repeated, and all filters can be combined. The command works through the `media` table in batches of 100 and prints how many items it regenerated and skipped. Files are written to each item's original disks. Queued conversions are dispatched to the queue, so keep a worker running.

From code, regenerate a model's media or a single item:

```ts
await post.regenerateMedia()
await post.regenerateMedia('images')
await post.regenerateMedia('images', 'thumb')
await post.regenerateMedia('images', ['thumb', 'large'])

const image = await post.getFirstMedia('images')
await image?.regenerate('thumb')
```

When you name conversions, only those are rebuilt and the rest are left alone. Naming a conversion that doesn't exist, or that doesn't apply to the item's collection, throws an error. Regenerating also throws if the original file is missing from its disk.

## When something fails

Adding, replacing, regenerating, and deleting media each run in a database transaction, so a failure doesn't leave half-finished state behind.

- **A conversion fails during upload.** The call throws an error naming the conversion and file. Holo deletes the files it just wrote and doesn't create the `media` row. For a `singleFile()` collection, the previous file stays in place.
- **The upload is inside your own transaction and that transaction rolls back.** Holo removes the new files, restores any files it overwrote, and the previous media is kept.
- **Files are replaced or deleted.** Old files are removed only after the transaction commits, so a rollback never loses the previous file.

::: warning
Some steps run after the database commit: removing old files and dispatching queued conversions. If one of them fails, the call still throws, but the new record and files stay saved. The error message says the change "remains committed", and `error.cause` holds the underlying error. Don't retry the upload blindly in this case, or you'll add the file twice.
:::

Deleting media works the same way: the row is deleted first, then the files. If file cleanup fails, the error says the deletion remains committed and some files may be left on the disk.

## Custom conversion executor

Holo creates conversions with sharp. To change how a conversion is made, such as skipping some conversions or using another image service, replace the executor with `setMediaConversionExecutor()`. Call it from a [plugin boot module](/advanced/plugins#run-code-at-boot), which runs every time Holo starts, in the web server and in queue workers. Calling it from route code only changes that one process, so queued conversions would ignore it.

The executor's `generate()` receives the original file and the conversion. It returns the new file, or `null` to skip that conversion. Use `createDefaultMediaConversionExecutor()` to hand everything else to the built-in executor:

```ts [server/lib/media.ts]
import { createDefaultMediaConversionExecutor, setMediaConversionExecutor } from '@holo-js/media'

const builtIn = createDefaultMediaConversionExecutor()

setMediaConversionExecutor({
  async generate(input) {
    if (input.collection.name === 'documents') {
      return null
    }

    return builtIn.generate(input)
  },
})
```

A result has `contents` (a `Buffer`, `Uint8Array`, `ArrayBuffer`, or `Blob`). It can also set `fileName`, `mimeType`, and `disk` to store the conversion on a different disk. If `generate()` throws, the upload fails and rolls back as described in [When something fails](#when-something-fails).

## Next steps

- [Media Library](/media/): add, read, and delete media
- [Running workers](/queue/workers): keep a `media` worker running in production
- [Failed jobs](/queue/failed-jobs): inspect and retry failed conversions
