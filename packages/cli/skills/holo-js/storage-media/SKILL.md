---
name: holo-storage-media
description: Implement Holo-JS storage disks, uploads, downloads, model media collections, conversions, responsive assets, and queued media processing.
metadata:
  type: focused
  source: https://docs.holo-js.com/media
---

# Storage and media

Use [storage](https://docs.holo-js.com/storage) for disk-level file operations, [media](https://docs.holo-js.com/media) for model-attached assets, and [queued media](https://docs.holo-js.com/queue/media) when conversions run asynchronously.

## Choose the abstraction

- Use `@holo-js/storage` for files, streams, URLs, metadata, and disk selection.
- Add `@holo-js/storage-s3` for S3-compatible disks.
- Use `@holo-js/media` when a file belongs to a model and needs collections, conversions, ordering, metadata, or lifecycle cleanup.
- Use queues for expensive conversion pipelines.

```ts
await Storage.disk('uploads').put(path, file)
```

```ts
await post.addMedia(upload).toMediaCollection('hero')
```

## Safety and lifecycle

- Validate size, MIME type, extension, and image decodability before accepting an upload.
- Generate server-controlled storage keys. Never join untrusted paths directly.
- Keep private assets private and issue time-bounded URLs through the configured driver.
- Coordinate database and file cleanup so failed writes and replaced media do not leave orphans.
- Queue only serializable identifiers, then reload current model state inside the job.

## Completion check

- The correct disk and visibility are explicit.
- Upload limits and authorization are enforced server-side.
- Replacements, deletions, conversion failures, retries, and orphan cleanup are covered.
- Tests use a safe fake or temporary disk and assert observable file/media behavior.
