# Queue And Media

Holo-JS media can now use the queue subsystem for queued conversions.

## Mark a conversion as queued

Use `.queued()` on the conversion definition:

```ts
import { collection, conversion, defineMediaModel } from '@holo-js/media'

export const Post = defineMediaModel(BasePost, {
  collections: [
    collection('images').disk('public'),
  ],
  conversions: [
    conversion('thumb')
      .performOnCollections('images')
      .width(368)
      .height(232)
      .format('webp')
      .queued(),
  ],
})
```

## What happens at runtime

- non-queued conversions still run inline
- queued conversions dispatch the package-owned `media.generate-conversions` job
- the queued payload contains only serializable identifiers and conversion names
- worker-side processing regenerates the derived files and updates the media row safely

## Driver behavior

With the scaffolded `sync` driver, queued media conversions run immediately because queue dispatch is
inline.

With `redis` or `database`, the job is enqueued and processed by a worker:

```bash
npx holo queue:work --connection redis --queue media
```

## Why the payload stays small

Media conversion jobs do not serialize model instances or file handles. They queue:

- the media row identifier
- the queued conversion names

The worker reloads the media record and original file from storage when it executes the job.

## Recommended setup

- keep quick, cheap conversions inline
- queue heavier image work such as large thumbnails or format conversion chains
- run a dedicated `media` worker if conversions are slower than the rest of your app jobs

Example dedicated worker:

```bash
npx holo queue:work --connection redis --queue media
```

## Continue

- [Media](/media)
- [Workers](/queue/workers)
