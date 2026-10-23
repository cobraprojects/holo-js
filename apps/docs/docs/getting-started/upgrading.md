# Upgrade Guide

## Upgrading from 0.3.x to 0.4.0

0.4.0 is in preparation. This section collects upgrade steps as the release changes land.

[Realtime](/realtime/) and [Broadcast](/broadcasting/) are **Experimental** in 0.4.0. Review their [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates. This label does not change runtime behavior.

### Apple callbacks and signing-key rotation

Serve your [Apple callback](/auth/social-login#apple) over HTTPS. Holo now sends its state cookie with `SameSite=None; Secure`, allowing Apple's cross-site form POST while keeping state validation. Keep the callback as a POST handler and exclude it from CSRF protection. Behind a proxy that terminates TLS, list the proxy in [`trustedProxies`](/basics/security/cors-and-proxies#trusted-proxies) so Holo sees the HTTPS request and sends `Secure`; no other configuration changes are required.

Apple, Clerk, and WorkOS signing keys now expire after ten minutes. An unknown key ID can refresh them at most once per minute, and concurrent requests share the fetch. A newly rotated key may therefore take up to a minute to be accepted. Tokens with invalid signatures under a known key ID no longer trigger a fetch. If a refresh fails, Holo keeps the keys it last loaded for at most ten minutes after that last successful fetch, then rejects tokens until a refresh succeeds. Failed refreshes never extend that window.

### Forwarded headers follow Laravel's TrustProxies

Holo now reads forwarded headers exactly as Laravel's `TrustProxies` middleware does:

- Only `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Port`, `X-Forwarded-Proto`, and `X-Forwarded-Prefix` are honored. The `Forwarded` header is ignored. If your proxy sends only `Forwarded`, configure it to send `X-Forwarded-*` headers.
- When a header lists several values, Holo takes the first, not the last.
- `X-Forwarded-Proto` values other than `https`, `on`, `ssl`, and `1` mean HTTP instead of answering `400`.
- `X-Forwarded-Port` and `X-Forwarded-Prefix` now change the port and path of `resolveRequestUrl()`.
- `X-Forwarded-For` entries that aren't IP addresses are skipped instead of becoming the client IP.
- WorkOS sign-in sends WorkOS the client IP that Holo resolves through `trustedProxies`, instead of the first `X-Forwarded-For` entry or `X-Real-IP`.
- Nuxt requests that arrive over a Unix socket, including in `nuxt dev`, come from `127.0.0.1`. List `'127.0.0.1'` in `trustedProxies` to read forwarded headers from that proxy.
- When the framework doesn't expose the connection address, as in Next.js, forwarded headers are trusted only with `trustedProxies: '*'`. A Next.js app with a list of proxies now ignores them, and `ip(request)` throws. Use `'*'` and make sure the app is reachable only through your proxy. See [Next.js](/basics/security/cors-and-proxies#next-js).

### Temporary URLs behind a proxy

Public and temporary storage URLs read the scheme, host, port, and path prefix from forwarded headers only when `trustedProxies` lists the proxy, as [`resolveRequestUrl()`](/basics/security/cors-and-proxies#read-the-public-url) does. Before, the Nuxt storage route accepted `X-Forwarded-Proto` from any client, and the other forwarded headers were ignored.

If your Nuxt or SvelteKit app runs behind a proxy that terminates TLS and serves temporary URLs, list the proxy:

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  trustedProxies: ['10.0.0.1'],
})
```

Without that, the app sees `http`, and a temporary URL signed with `https://` returns 404. Public files keep working because their path doesn't depend on the scheme.

### Realtime subscription isolation

Server subscriptions now authorize and execute independently, including subscriptions to the same query and arguments. No query definition or subscribe call changes are required. Check that each definition's `access` and handler restrict results to its caller; anonymous callers are rejected by authenticated definitions. Refreshes retain the caller’s authentication credentials and database without retaining a completed transaction. Mutation patches and backfill batches stay within the originating database. Size database capacity for one initial execution and independent refreshes per server subscription. Browser client store sharing is unchanged.

### Realtime relations honor hidden attributes

Realtime patches for a relation loaded with `with(...)` now follow the related model's serialization rules. A relation whose related model sets `hidden`, `visible`, `casts`, `accessors`, or `appended` is re-run instead of patched, so values hidden by the model no longer reach subscribers through belongs-to, has-one, has-many, or belongs-to-many relations. The same applies to a root model that sets those rules and loads a belongs-to relation: Holo re-runs the query when the foreign key changes. A handler that calls `makeHidden()`, `makeVisible()`, `setHidden()`, `setVisible()`, `append()`, `setAppends()`, or `withoutAppends()` on the records it loads gets the same re-run. No code changes are required. Subscriptions to those relations and queries run the handler more often. Relations to plain related models keep incremental patching.


### Model scope grouping

Review model queries and relation constraints that use `orWhere()`. Caller conditions, each global scope, and the soft-delete filter now form separate groups joined with `AND`. Queries can no longer use `OR` to reach foreign-tenant or deleted rows, and instance writes remain limited to their target row. Existing method signatures are unchanged.

Use the existing `withoutGlobalScope()` / `withoutGlobalScopes()` and `withTrashed()` / `onlyTrashed()` controls when deliberately querying outside those filters; apply scope-removal methods before caller conditions as described in [Scopes](/orm/scopes).

### Mass assignment is closed by default

A model without `fillable` or `guarded` now rejects every column in `create()`, `update()`, `make()`, `fill()`, `set()`, property assignment, and query `update()`, `upsert()`, `increment()`, and `decrement()` extra values. Before, it allowed every column. Add a `fillable` list to each such model, or `guarded: []` to allow every column except the primary key and timestamps:

```ts [server/models/Post.ts]
export default defineModel('posts', {
  fillable: ['title', 'body', 'status'],
})
```

The primary key and the `created_at` and `updated_at` columns are now guarded unless you name them in `fillable`. `fillable: ['*']` and `guarded` lists no longer let request data write them. Holo still generates IDs and timestamps itself. Query `upsert()` rows that include `created_at` or `updated_at` now need those columns in `fillable`.

Mass assignment rules are now checked when you assign attributes, not when you save. `fill()`, `set()`, and property assignment throw the `SecurityError` immediately, and `save()` writes every changed column. A JSON path such as `settings->role` follows its column's rules. `forceFill()` assigns without checking, so the next `save()` writes the columns you pass it, even when they're guarded. Code that relied on `forceFill()` failing for guarded columns should use `fill()` instead.

Saving or deleting a loaded model now targets the row it was loaded from, even after its primary key changes. See [mass assignment](/orm/#mass-assignment).

### Lifecycle, factories, and seeders

Attribute changes made in `creating`, `updating`, and `saving` handlers are now written. Before, the insert or update was built before those handlers ran, so their changes were dropped. Mutators run once per write, so `make()` followed by `save()` and factory-made records no longer apply them twice. `make()` stores the values you pass without running mutators or casts; they run when the record is saved.

`save()` on a model with no changes now fires `saving` and `saved`, as in Laravel, and writes nothing. Clean saves no longer write `updated_at` or fire `updating` and `updated`; before, a timestamped model's clean save did both. An `updating` handler that reverts every change fires `saved` without an `UPDATE`. After a save, `wasChanged()` and `getChanges()` report what the save wrote, so edits a `saved` handler makes don't appear there. A save that creates a record reports no changes, as in Laravel. Lifecycle handlers now receive the model you called `save()` on rather than a copy, and after `save()` returns the model is clean even when a `saved` handler changed an attribute: that change is not written. If your `saving` or `saved` handler assumed a clean save runs no code, guard it on `isDirty()`.

Models loaded with `withCount()` or `withExists()` save without error, and their computed values are never written. Changes made in place to JSON and date attributes, such as pushing onto a JSON array, are detected and saved.

Factories and `holo seed` now run without mass-assignment guards, as in Laravel. Remove `unguarded()` wrappers around factories and seeders; code outside them still follows the guards.

### Error reporting

Errors Holo catches in background work, such as failing queue hooks, background cache refreshes, auth cleanup, and broadcast worker messages, now go through one reporter. Without configuration they are still written to the console, now with `console.error` and a `[holo:<capability>] <operation>` prefix instead of the previous per-package messages. To send them to your error tracker, add `exceptions.report` and, optionally, `exceptions.dontReport` to `config/app.ts`, and use `report(error)` from `@holo-js/core` for errors you handle yourself. See [Reporting errors](/basics/errors#reporting-errors).

### Next.js servers close Holo resources on shutdown

When a Next.js server receives `SIGINT` or `SIGTERM`, it now starts closing Holo's database, Redis, queue, and other connections right away, then exits once the close finishes or 30 seconds after the signal. Requests still running at that point can fail if they use those connections, so remove the server from your load balancer before you send the signal. Give your process manager at least 30 seconds to stop the server. For example, set `terminationGracePeriodSeconds` in Kubernetes or `TimeoutStopSec` in systemd. Nuxt already closed Holo resources on shutdown and now reports a failed close through `exceptions.report`. No code changes are required. See [Stop the server](/deployment/#stop-the-server).

### Unexpected SvelteKit errors

Without a `handleError` export in `src/hooks.server.ts`, an unexpected error in a SvelteKit app is logged through the reporter, and the response carries SvelteKit's generic message, `Internal Error`, instead of the error's message. The error's message is still returned while `debug` is `true` in `config/app.ts`. Export `handleError` if your client needs a different message. See [Unexpected errors in SvelteKit](/basics/errors#unexpected-errors-in-sveltekit).

### Debug defaults to false

`debug` in `config/app.ts` now defaults to `false` when `APP_DEBUG` is unset, as in Laravel. Before, it defaulted to `true`, so apps without `APP_DEBUG` showed the messages of unexpected errors in SvelteKit responses. Set `APP_DEBUG=true` in your local `.env` file to keep those messages during development. Apps that set `APP_DEBUG` already, including the scaffold's `.env`, keep their value. SvelteKit error responses and Nuxt's `useHoloDebug()` follow the same setting. Next.js doesn't read it. See [Configuration](/reference/config#app-ts).

### Broadcast subscription errors and channel authorization

A refused channel subscription no longer closes the WebSocket. The worker sends `pusher:subscription_error` for that channel and keeps the connection open, so Flux keeps the browser's other channels and tries the refused channel again the next time you subscribe to it. If your own client waited for close code `4001` after a refused subscription, listen for `pusher:subscription_error` instead.

`holo broadcast:work` now checks unsigned private and presence subscriptions with the user from the connection's session cookie or `Authorization` header, and refuses them when nobody is signed in. Before, those rules received `null`. Subscriptions signed by `/broadcasting/auth` are unchanged.

The worker also stops sending internal error messages. Unexpected realtime errors reach clients as `Realtime request failed.`, failed publishes return `Broadcast publish failed.`, and the original errors go to your [error reporter](/basics/errors#reporting-errors). See [Errors](/broadcasting/production#errors).

### Broadcast connection limits

Each [Broadcast browser connection](/broadcasting/production#connection-limits) can hold 100 channels and 100 realtime query subscriptions, and can send 200 messages in each one-second window. Clients within these limits need no change.

A subscription beyond the channel or realtime limit fails with status `429`, and the socket stays open. A connection that exceeds the message rate, or that has more than 4 MB of output waiting for it, is closed with code `1008`. If a page needs more live queries than one connection allows, split them across pages.

### Browser connections reconnect

Realtime and Flux reconnect on their own after the WebSocket closes or fails. They wait about half a second before the first try, then wait longer after each failed try, up to 30 seconds, with some randomness so browsers don't all retry at once. Live queries and channels are sent again on the new connection, and a live query shows the current result. Flux re-authorizes private and presence channels during reconnect.

Two behaviors changed for app code. A worker restart no longer calls the `onError` of every active subscription, so don't rely on that callback to detect an outage. A realtime mutation that was already sent when the socket closed rejects with a connection error and isn't sent again, because the server may already have run it. Catch that error and retry only when the mutation is safe to repeat. See [When the connection drops](/realtime/#when-the-connection-drops).
### Broadcast dead connections and presence after a crash

The Node.js worker now pings each WebSocket connection every 30 seconds and closes any that don't answer. Browsers and clients built on a WebSocket library that answers pings, such as `ws`, need no change. A custom client that never answers WebSocket pings is disconnected within 60 seconds, so it must answer pings or send a message at least that often.

Workers that use [Redis scaling](/broadcasting/production#run-several-workers) now write a lease key, `holo:broadcast:scaling:<connection>:nodes:<node-id>`, every 10 seconds, and read presence keys to remove members of crashed workers. If your Redis user is limited by ACL rules, allow `SET` and `EXISTS` on `holo:broadcast:scaling:*`. Without them, the worker can't refresh its lease and its presence members disappear from other workers.

### Realtime queries refresh across processes

With [Redis scaling](/broadcasting/production#run-several-workers) on, a query-builder or model write that commits in your web app or queue workers now publishes to `holo:broadcast:scaling:<connection>:events` once per Broadcast worker or app runtime sender in that process. Every Broadcast worker refreshes the realtime queries that read the changed rows, and each worker applies a write once, by its write ID, however many copies arrive. Those processes need the Redis connection, `ioredis` installed, and permission to `PUBLISH` on `holo:broadcast:scaling:*`. Without the permission, writes still commit, but realtime queries on other workers don't update.

### Broadcast workers upgrade together

Upgrade every Broadcast worker that uses [Redis scaling](/broadcasting/production#run-several-workers) to 0.4 at the same time. A presence entry written by a worker from before this change has no lease. The upgraded workers treat it as belonging to a dead node and remove it, so during a mixed rollout users still connected to an old worker drop out of presence until they reconnect.

Stop all old workers, then start the 0.4 workers. Workers that don't use Redis scaling are unaffected.

### Queue jobs interrupted by a stopped worker

Queue workers now recover jobs left behind by a worker that crashed or was killed. With the `redis` driver, another worker picks the job up once at least the connection's `retryAfter` seconds have passed; before, it could stay stuck until you cleared it. A running Redis worker now renews its hold on the job, so jobs longer than `retryAfter` are no longer handed to a second worker.

An interrupted run counts as an attempt on both the `redis` and `database` drivers. When a recovered job has no `tries` left, the worker fails it into the [failed jobs table](/queue/failed-jobs) and calls its `onFailed` hook, instead of running it again. Raise `tries` on jobs that should survive a worker crash on their last attempt.

A `redis` or `database` connection's `retryAfter` must now be at least `1`. Before, `0` was accepted; now the config fails to load with `retryAfter must be greater than or equal to 1.` If you set it to `0`, remove it to use the default `90`, or set another whole number of seconds.

A job whose name isn't registered now fails into the failed jobs table and the worker keeps going. Before, the worker stopped with an error and left the job reserved. If you rename or delete jobs, drain their queued jobs first or retry them later with `npx holo queue:retry`. See [When a worker stops unexpectedly](/queue/workers#when-a-worker-stops-unexpectedly).

### queue:listen waits for its worker

`queue:listen` now passes `Ctrl+C`, `SIGINT`, and `SIGTERM` to its worker and exits only after the worker has closed, so stopping `queue:listen` no longer leaves a worker running. A change that restarts the worker waits for the old worker to exit. If the old worker reports a process error while it stops, `queue:listen` exits with that error instead of starting a replacement. Before, it started one.

If you run `queue:listen` under a process manager, check that it stops when the manager sends `SIGTERM`. Your code doesn't change. See [Develop with queue:listen](/queue/workers#develop-with-queue-listen).

### Windows `.env` percent references

On Windows, `.env` values expand `%NAME%` from the real environment variables, as `cmd.exe` does, and `%%` becomes `%`. A value such as `DATA_DIR=%USERPROFILE%\data` now resolves to your profile folder, and a value that contains `%%` now contains a single `%`. Check Windows `.env` values that contain a percent sign. Values on macOS and Linux are unchanged. See [Values and types](/reference/environment#values-and-types).

### Sensitive input in validation failures

Passwords and fields marked [`sensitive()`](/basics/validation/rules#sensitive) are now left out of every validation failure, including inside nested objects and arrays. This covers the 422 response in Next.js, Nuxt, and SvelteKit, `ValidationException` `values` and `toJSON()`, and `submission.fail()` and `submission.serialize()`. If your code reads a password back from a caught `ValidationException`, read it from the request instead.

In Nuxt, the cookie that flashes errors after a native form post no longer contains the submitted values, and it is marked `Secure` on HTTPS requests. `useValidationErrors()` works as before.

### Validation input limits

Form bodies and query strings are now limited to 1,000 non-file fields, with a separate limit of 1,000 uploaded-file entries per form, and a list index must be lower than the number of different indexes sent for that list. Requests that break these limits, or that use `__proto__`, `constructor`, `prototype`, or the same name used with two shapes (an object and a list, or numbered indexes and `[]`) in any order, fail validation with a 422 instead of throwing. Split forms that exceed either limit into smaller submissions; JSON can be used for larger non-file payloads. See [Input limits](/basics/validation/#input-limits).

A JSON or form body that can't be parsed is now validated as `{}` instead of throwing.

Errors thrown inside `custom()` and `customAsync()` are no longer turned into a validation message on `_root`. They reach your framework's error handling and respond with a 500. If a custom rule calls code that can throw for invalid input, catch the error in the rule and return a message string instead.

### S3 file names with special characters

S3 disks now store files under their exact names. Before 0.4.0, a name with characters other than letters, digits, and `-_.!~*'()` was stored under its URL-encoded form: `reports/Q1 café.pdf` became the object `reports/Q1%20caf%C3%A9.pdf`, and its `url()` returned access denied or not found. After upgrading, Holo looks for `reports/Q1 café.pdf`, so rename those objects before you deploy. With the AWS CLI:

```bash
bucket=my-app-assets
aws s3api list-objects-v2 --bucket "$bucket" --query "Contents[?contains(Key, '%')].Key" --output text \
  | tr '\t' '\n' \
  | while IFS= read -r key; do
      [ -n "$key" ] && [ "$key" != None ] || continue
      aws s3 mv "s3://$bucket/$key" "s3://$bucket/$(node -p 'decodeURIComponent(process.argv[1])' "$key")"
    done
```

Local disks also change to exact names; see [Local file names](#local-file-names). If you call the low-level `getKeys()` on an S3 disk, it now returns `:`-separated keys in the same format as local disks.

S3 requests now time out, and `writeStream()` uploads parts of at most 64 MiB, so one stream can upload up to about 620 GiB. See [S3 timeouts](/storage/s3#timeouts).

### Nuxt builds don't keep storage credentials

`nuxt build` no longer writes the S3 credentials of your storage disks (`accessKeyId`, `secretAccessKey`, and `sessionToken`) into the build's options. The running server reads them when it starts, from the environment that `config/storage.ts` reads, such as `STORAGE_DISKS_S3_ACCESS_KEY_ID`. Set those variables on the server. Values that exist only in the build environment aren't available at runtime. See [S3 storage](/storage/s3).

### S3 uploads now carry a Content-Type

S3 uploads now carry a `Content-Type`, taken from the file's first bytes or its extension. Before, S3 stored every object as `binary/octet-stream`, so browsers downloaded it. New uploads of browser-renderable types, such as images, PDF, text, and JSON, now display inline when a public bucket or CDN serves them. HTML, SVG, and XML are still stored as `application/octet-stream`, so they keep downloading. Existing objects are unchanged. See [Content types](/storage/s3#content-types).

### Local file names

Local disks now store files under their exact names, like Laravel. Before 0.4.0, Holo stored `reports/Q1 café.pdf` as `reports/Q1%20caf%C3%A9.pdf` on disk. After upgrading, Holo looks for `reports/Q1 café.pdf`, and `path()` returns that location.

After you deploy 0.4.0, rename the existing files once for each local disk:

```bash
npx holo storage:decode-names --disk=local
npx holo storage:decode-names --disk=public
```

The command prints what it renamed and what it skipped, and running it again right away changes nothing. Run it once, before new uploads arrive, and rename skipped files by hand. See [storage:decode-names](/reference/cli#storage-decode-names).

Low-level keys still use `:` between folders, but only `%`, `:`, and `$` are escaped inside a name, so the key for `reports/Q1 café.pdf` is `reports:Q1 café.pdf` instead of `reports:Q1%20caf%C3%A9.pdf`. Old-style keys still read the same file. On local disks, file names ending in `$` are now reserved for metadata, so `put('prices.json$', ...)` throws an error.

### Local storage on Nuxt and symlinks

Nuxt apps now use the same local disk code as Next.js, SvelteKit, and plain Node. On Nuxt, `stat()`, `listFiles()`, `readStream()`, and `writeStream()` now work on local disks instead of throwing an unsupported-operation error. Files keep their names and locations, so no data moves.

The Nuxt adapter no longer adds `holo:<disk>` entries to Nitro's `storage` option or a `holoStorage` key to `runtimeConfig`. If your server code calls Nitro's `useStorage('holo:local')`, switch to Holo's disk:

```ts [server/api/report.get.ts]
import { useStorage } from '@holo-js/storage/runtime'

export default defineEventHandler(async () => {
  return await useStorage('local').get('reports/daily.txt')
})
```

`@holo-js/storage` no longer exports the Nitro helpers `applyNitroStorageConfig()`, `buildStorageConfig()`, `buildStorageConfigWithDriver()`, or the `StorageConfig`, `NitroStorageLike`, and `StorageAdapterOptionsLike` types.

On every framework, local disks now refuse to delete through symlinks that lead outside the disk root. `delete()`, `removeItem()`, and `clear(base)` throw instead of deleting the outside file, and `clear()` with no base empties the disk root without replacing a symlinked root folder. `exists()` returns `false` for a folder instead of throwing. If your app keeps files outside the disk root and links them in, delete them through a disk whose root contains them.

### Local disk permissions

New files and folders on local disks use Laravel's permissions: `0600` files and `0700` folders on private disks, and `0644` files and `0755` folders on public disks. Existing files and folders keep their permissions. If another OS user serves your public files, check that it can still read them.

### Media strings are file paths

`addMedia()` no longer downloads a string that starts with `http://` or `https://`. A string is always a local file path, so `post.addMedia('https://example.com/photo.jpg')` now throws instead of downloading the file. Replace it with `addMediaFromUrl()`:

```ts
// Before
await post.addMedia('https://example.com/photo.jpg').toMediaCollection('images')

// After
await post.addMediaFromUrl('https://example.com/photo.jpg').toMediaCollection('images')
```

`addMedia({ url })` is also removed. Use `addMediaFromUrl(url)` in its place.

Remote downloads now have a 30-second limit for the whole download, including reading the file. Slow downloads throw an error instead of waiting indefinitely.

Collections without `disk()` now use the media disk, which is `public` unless `config/media.ts` sets `disk`. Before 0.4.0 they used the default storage disk when it was public, and otherwise the `public` disk if one existed. Projects created before 0.4.0 have an empty `config/media.ts`, and that file doesn't read `MEDIA_DISK`, so setting the variable does nothing until you change the file to:

```ts [config/media.ts]
import { env } from '@holo-js/config'
import { defineMediaConfig } from '@holo-js/media/config'

export default defineMediaConfig({
  disk: env('MEDIA_DISK', 'public'),
})
```

Check this before deploying if your default storage disk is private or S3, since uploads otherwise go to `public`.

Image conversions reject images over 40 million pixels or 1,000 frames, the same limits upload validation uses. Holo generates images before its own database transaction starts. If your code calls `addMedia()` inside your own transaction, the image work still runs inside that transaction, so upload after it commits. Use `addMediaFromDisk(path, disk)` to attach a file that's already on a storage disk.

### Database queue workers on MySQL

The `database` queue driver now needs MySQL 8.0.17 or later. Workers on MySQL and PostgreSQL skip jobs another worker is taking instead of waiting for them, so a MySQL worker no longer keeps retrying a job another worker already took. No config or code changes are required. See [Run several workers](/queue/drivers#run-several-workers).

### Node.js 22.14 or newer

Holo now requires Node.js 22.14 or newer on the 22 line, or Node.js 24 or 26. On Node.js 22.12 and 22.13 the SQLite driver crashes with a segmentation fault when it opens a database. Check `node --version` in development, CI and production, and upgrade Node.js 22 installations to 22.14 or newer before installing 0.4.0.

### Queue job timeouts, dispatch, and retries

A job that runs past its `timeout` now stops the worker, as in Laravel, and counts as an attempt. Before, the worker marked the job failed at once and moved on. Now the job stays reserved and runs again after the connection's `retryAfter` while `tries` remain. To keep failing on the first timeout, set `failOnTimeout: true` on the job. See [Timeouts](/queue/jobs#timeouts).

A job `timeout`, or the worker's `--timeout`, must now be less than its connection's `retryAfter`. The dispatch throws, or `queue:work` refuses to start, when it isn't. Loading the queue config also throws when a registered job's `timeout` isn't below its connection's `retryAfter`. `timeout` and `sleep` above `2147483` seconds are rejected too. Raise `retryAfter` or lower the value.

New dispatch options: `.afterCommit()` on a dispatch, and `afterCommit: true` on a queue connection (default `false`), queue the job only once the surrounding database transaction commits. `@holo-js/queue` now lists `@holo-js/db` as an optional peer for this. Install `@holo-js/db` if you use it; without it, dispatch runs right away.

Queued mail, notifications, and event listeners accept `tries` and `backoff`, and `queue:work` and `queue:listen` accept `--tries` and `--backoff`. These jobs still run once unless you set `tries`. The worker's `--backoff` applies only to jobs that don't set their own `backoff`.

### After-commit queue failures reach the transaction

A job dispatched with `.afterCommit()`, or on a connection with `afterCommit: true`, that can't be queued when its transaction commits now makes the `DB.transaction()` call reject with that error. Before, Holo reported the error and the call resolved, so the caller never saw the failure. Catch the error around `DB.transaction()` if the request should carry on. `onFailed` still runs first, and after-commit callbacks registered after the failed dispatch in that transaction are skipped. See [Dispatch after a database commit](/queue/jobs#dispatch-after-a-database-commit).

### Event listener order and after-commit notification failures

Event listeners run in registration order, with sync and queued listeners interleaved. Before, every sync listener ran first and queued listeners were sent after them. If a listener depended on running after the queued listeners, move it after them or change it to a queued listener. A listener that throws stops the dispatch, so listeners registered after it don't run. See [Order and errors](/events/listeners#order-and-errors).

A notification channel that fails after a transaction commits is reported through `exceptions.report` with capability `notifications` and operation `channel.afterCommit`. Before, it was dropped without a report. Configure `exceptions.report` if you want these failures in your error tracker. See [Reporting errors](/basics/errors#reporting-errors).

### Framework peer dependencies

Holo adapters now use your app's framework packages as peer dependencies instead of installing their own copies. Before you install 0.4.0, upgrade your framework to a release that fixes its published security advisories:

| Adapter | Required in your app's `package.json` |
| --- | --- |
| `@holo-js/adapter-next` | `next` 16.3.8 or newer on the 16 line, and `react` 19.2.6 or newer on the 19 line |
| `@holo-js/adapter-nuxt` | `nuxt` 4.5.1 or newer on the 4 line, and `vue` 3.5.13 or newer on the 3 line |
| `@holo-js/adapter-sveltekit` | `@sveltejs/kit` 2.70.2 or newer on the 2 line, and `svelte` 5.56.8 or newer on the 5 line |

`@holo-js/adapter-nuxt` no longer installs `h3` or `nitropack`. Its server routes and plugins use the h3 and Nitro that come with your Nuxt version. `@holo-js/adapter-sveltekit` no longer installs Svelte. It accepts any Svelte 5 release from 5.56.8 instead of one exact version.

Holo's own dependencies now require patched releases too: `ws` 8.21.0, `sharp` 0.35.5, and `mysql2` 3.22.0 or newer. Your package manager installs these for you. If your lockfile pins older versions, refresh it after upgrading.

### Application environment from `APP_ENV`

The environment now comes only from `APP_ENV`. The `--env` option wins over `APP_ENV` from your shell, which wins over `APP_ENV` in `.env`. When none of them sets it, the environment is `production` instead of `development`. Holo uses that environment to pick which `.env` files load. `HOLO_ENV` is no longer read, and `NODE_ENV` no longer picks the environment. A value other than `development`, `production`, or `test` now stops Holo with an error instead of counting as `development`.

An env file that exists but can't be read, such as a `.env` that is a directory, also stops Holo with the file-system error. Before, it was skipped, so the environment fell back to `production`.

Before installing 0.4.0:

1. Add `APP_ENV=development` to your local `.env`. Without it, local commands and `holo dev` run as `production`.
2. Replace `HOLO_ENV` with `APP_ENV`, or with `--env`, in scripts, CI, and hosting settings.
3. Set `APP_ENV` anywhere you relied on `NODE_ENV` to pick the environment. For example, Vitest sets `NODE_ENV=test`, so set `APP_ENV: 'test'` in your test config as shown in [Testing](/testing/).
4. In `config/app.ts`, set the environment the way new projects do:

```ts [config/app.ts]
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  env: env('APP_ENV', 'production'),
})
```

If you use the config cache, run `npx holo config:cache` again on every server after upgrading. Holo ignores caches written by 0.3.x and loads `config/*.ts` until you rebuild the cache, because an old cache can hold the wrong environment. Mail previews check the environment from `APP_ENV` (or `--env`) rather than a cached `app.env`.

`holo start` now runs your framework server with `NODE_ENV=production`, even when your shell sets another value. Nuxt servers now pick their `.env` files from `APP_ENV` when they start, not from the environment the app was built in. In Nuxt, `useHoloEnv()`, `useHoloDebug()` and `useHoloDb()` now return the running app's values, and throw if called before Holo starts, so call them inside server routes or handlers. If you call `configureMailRuntime()` yourself without Holo, pass `environment`, or previews treat the app as `production`. See [Which `.env` files load](/getting-started/configuration#which-env-files-load).

### Destructive commands confirm in production

`migrate:fresh`, `migrate:rollback`, and `seed` now ask you to confirm when the application environment is `production`. The prompt appears only in a terminal. Without one, the command stops with an error unless you pass `--force`. `migrate:rollback` accepts `--force` now; before, it ignored the flag. `--force` skips the prompt for all three commands.

Before upgrading, check every deploy script, CI job, and cron entry that runs these commands with `APP_ENV=production`, and add `--force` to them. Otherwise they stop instead of running. The `npx holo seed --only roles --force` example in the seeding guide shows the flag in use.

### Migration runs can be isolated

`npx holo migrate --isolated` takes a database lock, so replicas that migrate at deploy time don't apply the same migrations. A replica that finds the lock held skips the migrations and exits successfully. Holo creates a `_holo_migration_locks` table the first time an isolated run starts. The lock expires an hour after it was last renewed, and a single migration that runs longer than an hour can let another runner in. Plain `migrate` doesn't use the lock. Use `--isolated` in your deploy step if more than one replica runs it.
### Generated broadcast credentials and strict env values

Holo no longer uses `app-id`, `app-key`, or `app-secret` when `BROADCAST_APP_ID`, `BROADCAST_APP_KEY`, or `BROADCAST_APP_SECRET` are unset. Without them, your config still loads and `holo prepare` still runs. The broadcast worker, publishing, and channel authorization fail with an error that names the variables. `holo new` writes generated values into `.env`, and existing apps get them the same way:

```bash
npx holo install broadcast
```

The command adds `BROADCAST_APP_*` lines that `.env` doesn't have yet. It leaves existing lines alone, so if a line is present but empty, fill it in or delete the line and run the command again. Use the same three values for your web app and your broadcast worker, and set them in your hosting provider's environment rather than copying your development `.env`.

Holo also throws when a typed `env()` value doesn't convert: `APP_DEBUG=maybe` with a boolean fallback, or `APP_PORT=abc` with a number fallback. Previously Holo used the fallback. Fix or remove those values before deploying.

If you use the config cache, the cache now stores the env values it was built with, secrets included. Config modules that contain functions, such as `app` with an exception reporter or `security` with rate-limit callbacks, still load from their files, and the `env()` values they read while loading are frozen in the cache as well. Code that calls `env()` after startup, such as a reporter's body, reads the runtime environment. Holo ignores 0.3.x caches, so rebuild it after upgrading. Keep `.holo-js/generated/config-cache.json` out of version control; the scaffolded `.gitignore` already does.

### Encrypted session, remember-me, and CSRF cookies

Holo now encrypts the cookies it sets: the session cookie, the remember-me cookie, and `XSRF-TOKEN`. It uses AES-256-GCM with a key derived from `APP_KEY`, and rejects any cookie that was changed. Your own cookies, including ones written with `cookie()` or `cookies.make()`, are not encrypted.

Cookies set by 0.3.x can't be read after the upgrade. Every user is signed out once, remember-me cookies stop working, and the first form each browser submits with an old `XSRF-TOKEN` gets a `419` response. The next page load issues new cookies.

`APP_KEY` must be set wherever Holo sets these cookies. Without it, signing in and issuing the CSRF cookie throw an error. Run `npx holo key:generate` if your `.env` has no key. Changing `APP_KEY` later signs everyone out again.

If you call `sessionCookie()` or `rememberMeCookie()` from `@holo-js/session` directly, they now encrypt the value. Don't read the session ID or remember-me token back from the cookie yourself. Use [Auth](/auth/session-and-cookies) to resolve the current session. CSRF tokens from `csrf.token()` and `csrf.input()` are now random values with no signature, and are no longer the same string as the `XSRF-TOKEN` cookie value. Both are still accepted in the `_token` field and the `X-CSRF-TOKEN` header.

### Per-user remember-me tokens

Remember me now works like Laravel's: each user has one `remember_token`, and the user stays signed in for `rememberMeLifetime` even after their session expires. Add the column to every table an auth provider reads from, such as `users` and `admins`:

```bash
npx holo make:migration add_remember_token_to_users
```

```ts [server/db/migrations/2026_10_19_000000_add_remember_token_to_users.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.table('users', (table) => {
      table.string('remember_token').nullable()
    })
  },
  async down({ schema }) {
    await schema.table('users', (table) => {
      table.dropColumn('remember_token')
    })
  },
})
```

Add `remember_token` to the model's `hidden` list so it never reaches the browser:

```ts [server/models/User.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email', 'password', 'avatar'],
  hidden: ['password', 'remember_token'],
})
```

Behavior changes to expect:

- `logout()` gives the user a new remember token, so remember-me cookies on every device stop working. Other devices with an active session stay signed in until that session ends. Use `logoutOtherDevices()` to end those too.
- Changing the user's password also stops their remember-me cookies.
- Signing in without remember me clears that browser's remember-me cookie but keeps the user's token, so a copy of the cookie keeps working until `logout()`, `logoutOtherDevices()`, or a password change.
- With multi-factor auth, the remember-me cookie is set after the user passes the challenge, not when they enter their password.
- A custom `AuthRuntimeContext` can report whether it can set cookies with `canAppendResponseCookie()`. Auth checks it before any side effect. Without it, Auth uses whether `appendResponseCookie` exists.
- A custom `AuthRuntimeContext` that omits `appendResponseCookie` can no longer log users in or out. The calls throw `cookie_write_unavailable`, the same error a read-only Next.js render raises. Provide a response cookie writer in every request context that signs users in or out.
- Confirming multi-factor enrollment ends remember-me cookies issued before it, so the user signs in with the challenge the next time. The browser that confirmed enrollment stays signed in.

The sessions table no longer uses `remember_token_hash`. You can leave the column in place or drop it. `issueRememberMeToken()` and `consumeRememberMeToken()` are removed from `@holo-js/session`, and session records no longer have `rememberTokenHash`. `rememberMeCookie()` is unchanged.

If you wrote a custom auth provider, add `getRememberToken(user)` and `updateRememberToken(user, token)` to it. Without `updateRememberToken`, `remember: true` and `logout()` for users who have a token throw an `AuthError` with the code `runtime_unconfigured`.
### Rate-limit windows are fixed in every driver

Every rate-limit driver now uses the same window. A window starts with a key's first attempt and lasts `decaySeconds`. Rejected attempts count but don't extend it. Before, the Redis driver counted attempts over a sliding window that rejected attempts extended. See [How the window works](/basics/security/rate-limiting#how-the-window-works).

Redis stores each key as a counter instead of a sorted set. Buckets left by 0.3.x are sorted sets, and an attempt on a key that still holds one fails with a Redis `WRONGTYPE` error until that bucket expires. Clear them once after the upgrade:

```bash
npx holo rate-limit:clear --all
```

The `memory` driver keeps at most 10,000 keys per process and never evicts a live key. When it is full, new keys are limited until one expires. The `file` driver deletes expired keys in the background at most once a minute. The low-level `createSecurityRedisAdapter()` no longer takes a `now` option.

### CSRF tokens stored in the session

The CSRF token now lives in the visitor's [session](/basics/session), as in Laravel. The `XSRF-TOKEN` cookie carries that session token encrypted, and a token copied from another browser or planted by a subdomain no longer matches.

- **Tokens reissue after upgrading.** The first unsafe request each browser sends after the upgrade gets `419`, because its session has no token yet. The next page load stores a token in the session and issues a new `XSRF-TOKEN` cookie.
- **Install `@holo-js/session`.** CSRF protection needs it, so `holo install security` now adds it. If your app enables `csrf`, or leaves it on by default, without Auth, add `@holo-js/session` to your dependencies. Without it, the app fails at startup with `Session support requires @holo-js/session to be installed.` Without a `config/session.ts`, Holo uses the default file session store.
- **Send the session cookie.** Visitors without a session get one on their first page load. Scripts and tests that post with only the `XSRF-TOKEN` cookie must also send the `holo_session` cookie (or your `session.cookie.name`).
- **`X-XSRF-TOKEN` is also accepted.** `_token` and `X-CSRF-TOKEN` still accept the plain token or the cookie value, so existing `fetch` calls keep working. The new `X-XSRF-TOKEN` header accepts the cookie value, as in Laravel.
- **Custom session stores need `setDataIfAbsent`.** The token is written with one atomic store call, so a rotation or logout that runs at the same moment can't bring back the old session. Built-in file, database and Redis stores support it. A custom store must add `setDataIfAbsent(sessionId, key, value)` before CSRF-protected pages load. Return `{ found: false }` for a missing or expired session without recreating it. Otherwise, preserve an existing key or insert the value if absent, then return `{ found: true, value: storedValue }`. For the reserved `_token` key, treat a non-string or empty value as absent and replace it atomically; preserve a valid token initialized by another request. Keep the session's other data and expiry unchanged.
- **`useForm` keeps server-rendered tokens.** A `_token` field already in the form, such as one from `csrf.input()`, is no longer replaced by the cookie value. With `csrf.endpoint`, the fetched token is sent in the `csrf.header` header from `config/security.ts` instead of always `X-CSRF-TOKEN`, and the cookie value is no longer added as `_token`. If the configured header is `X-XSRF-TOKEN`, the fetched token goes in `csrf.field` instead; that header accepts only encrypted cookie values.

### CSRF checks are on by default

`csrf.enabled` now defaults to `true`, as in Laravel's `web` group. A `config/security.ts` that has no `csrf` block checks every unsafe request (`POST`, `PUT`, `PATCH`, `DELETE`). Before, the default was off. Apps created with `holo new` or `holo install security` already set `csrf.enabled: true` and don't change.

- **Unsafe requests without a token get `419`.** Forms and `fetch` calls that don't send the token, such as `csrf.input()`, `useForm`, or the `X-CSRF-TOKEN` header, now fail. Routes that receive webhooks or API calls from other clients can be listed in `csrf.except`.
- **Opt out with `enabled: false`.** Set it to restore the old behavior for the whole app. This removes forgery protection, so prefer `except` for the routes that need it.

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: {
    enabled: false,
  },
})
```

### CSRF endpoints for separate frontends

For a separate frontend using `useForm({ csrf: { endpoint } })`, your token endpoint can now return `{ token, field }`. Use `const { name: field, value: token } = await csrf.field(request)`. The client sends the token in that field, so custom API CSRF names work without reading API cookies. Existing `{ token }` responses keep their current behavior.

### CORS wildcard origins with credentials

`config/cors.ts` can no longer combine `origins: ['*']` with `credentials: true`. Holo throws at startup instead of echoing every origin with credentials. List your frontend origins in `origins`, or set `credentials: false`. A wildcard origin now always answers `Access-Control-Allow-Origin: *`.

### Social sign-in links only verified accounts

Social sign-in no longer signs in as an existing user whose email isn't verified. When a provider's verified email matches such a user, `callback()` from `@holo-js/auth-social` throws `SocialAuthConflictError`. Catch it in your callback routes and ask the user to sign in with their password and verify their email; their next social sign-in links the accounts. See [Link an existing account](/auth/social-login#link-an-existing-account).

Email verification links now only verify the address they were sent to. If a user changes their email, links sent to the old address fail with `email_verification_token_expired`.

### WorkOS sign-in requires a session ID

WorkOS sign-in no longer uses the access token or the authorization code as the session ID. Before, when WorkOS's response had no session ID, sign-in succeeded and `logoutWithWorkos()` sent that token or code to WorkOS as `session_id`. Now the callback fails with `workos_auth_failed` and creates no session. WorkOS AuthKit always returns a session ID in the WorkOS session ID shape (`session_` followed by letters, digits, `_` or `-`), so this only affects malformed responses. Sessions created before the upgrade keep the old value until they expire. Logging out of them ends the local session only: logout sends a stored value to WorkOS only when it has the shape of a WorkOS session ID, and a token or code never does.

The sign-in state cookie is marked `Secure` when `session.cookie.secure` is `true`, even over HTTP, and behind a trusted proxy that terminates TLS when `X-Forwarded-Proto` is `https`.

### Sessions don't cross between 0.3 and 0.4

Sessions written by 0.4 aren't readable by 0.3, because a session no longer stores a copy of the user. A mixed-version rolling deploy, or a rollback to 0.3 after deploying 0.4, signs users out. Deploy 0.4 to every instance at once, or accept that users sign in once more after a rollback.

### Redis sessions use one key per session

Each Redis session is its own key: the store's `prefix`, then `holo:session:`, then the session ID. Sessions spread across a Redis Cluster, and they never sit under a bare session ID.

- **Users sign in again once.** Sessions stored under the old keys aren't found after the upgrade. Users who chose remember me sign back in from their remember-me cookie; everyone else signs in again. Old keys expire at their own TTL, so you don't need to delete them.
- **Deploy to every instance at once.** Follow [Sessions don't cross between 0.3 and 0.4](#sessions-dont-cross-between-03-and-04) for mixed-version deploys. An instance on 0.3 can't read the new keys.
- **Set a `prefix` to share a Redis database.** Holo's `holo:session:` namespace keeps session keys apart from other data, and a `prefix` separates apps that use the same database.
- **Rotation takes two Redis steps.** Rotating a session copies it to the new ID and then deletes the old key, instead of running one script. If the process stops, or the delete fails, between the two steps, the old ID stays valid until its expiry. Under heavy concurrent writes to the same session, rotation falls back to reading the latest state, copying it, and deleting the old key without a check. A write or flash value that lands between that final read and the delete can be lost or kept on both IDs.

### Verification resend requires a signed-in user

`resendEmailVerification()` and `sendEmailVerification()` no longer take an email address, and `verification.resend()` no longer accepts `email`. A new link always goes to the signed-in user, and without one the call throws `email_verification_user_missing` with status 401. The unauthenticated resend is gone, so a guest can no longer ask for a link by typing an address.

Update the resend route and its page:

- Call `resendEmailVerification()` with no arguments. Users are signed in after `login()`, including unverified users, so the verification page can post to the route without an address.
- Rate limit the route per user with the `emailVerificationResend` limiter, for example `limit.perMinute(6).define()`, passing the user's id as the key. New security configs include the limiter. If your `config/security.ts` already exists, add it to `rateLimit.limiters`. The example in [Resend the email](/auth/email-verification#resend-the-email) shows the full route.
- Delete the old `emailVerificationResend` limiter keyed by email and the resend form schema, and stop posting `email` from the page.

### Password reset cycles remember tokens

A successful password reset now replaces the user's `remember_token`, as Laravel does. Remember-me cookies issued before the reset stop restoring. Browsers that are still signed in keep their sessions. The column already exists, so no migration is needed.

### Failed logins and reset-link requests take at least 200 ms

Failed logins and every reset-link request now take at least 200 ms, whether or not the account exists, so response time doesn't reveal which emails have accounts. Successful logins aren't delayed. Your code doesn't change, but failed attempts answer a little slower.

### User records load on every request

`auth.user()` reads the user from the provider once per request, and session records no longer store a copy of the user. Existing sessions keep working, and the stored copy is ignored. Users who were deleted or changed are reflected on their next request. Your provider's `findById()` now runs on each request that reads the user.

### Cache flushes clear the whole store

`cache.flush()` and `npx holo cache:clear` now delete everything in the store, as Laravel does, and a key `prefix` no longer limits them. A Redis store flushes its whole Redis database, a `database` store empties its cache table, and a `file` store empties its folder. If your Redis cache shares a database with queues or sessions, move it to its own database before you flush, or the flush deletes that data too.

Add a `cache` connection to `config/redis.ts` on a database that holds nothing else, and point the Redis store at it. The scaffold uses database `1`:

```ts [config/redis.ts]
cache: {
  url: env('REDIS_URL') || undefined,
  host: env('REDIS_HOST', '127.0.0.1'),
  port: env('REDIS_PORT', 6379),
  username: env('REDIS_USERNAME'),
  password: env('REDIS_PASSWORD'),
  db: env('REDIS_CACHE_DB', 1),
},
```

```ts [config/cache.ts]
redis: {
  driver: 'redis',
  connection: 'cache',
}
```

Entries written with `put()` or `remember()` expire on their own. Entries written with `forever()` stay in the old database until you remove them, so clear that database with your Redis tools once the cache has moved. On a Redis Cluster, `flush()` clears every primary node, so give the cache its own cluster. Give each app its own folder or cache tables for the `file` and `database` stores. See [Cache drivers](/cache/drivers#redis).

### Transaction nesting and commit errors

Check three behaviors when you upgrade:

- A `transaction()` call on a connection object made while a transaction is open on that connection now becomes a savepoint. Before, it started a second transaction that could commit the outer work early. If you relied on that early commit, move the work out of the outer callback.
- When an `afterCommit` callback throws, `DB.transaction()` rejects with that same error. It used to reject with a `TransactionError` wrapping it. Update any `catch` that checked for `TransactionError` in that case.
- `timeoutMs` and `signal` on a transaction only limit how long it takes to start. Commit and rollback are never interrupted. If you relied on a timeout to abandon a slow commit, the commit now finishes. See [Timeouts and cancellation](/database/transactions#timeouts-and-cancellation).

To retry a transaction after a deadlock or lock timeout, pass `attempts`. See [Retry deadlocks](/database/transactions#retry-deadlocks).

### Rollback callbacks and failed rollbacks

Check three behaviors when you upgrade:

- `afterRollback()` callbacks run in reverse registration order. Before, they ran in registration order.
- A callback that throws no longer stops the callbacks after it. When one fails, `DB.transaction()` rejects with an `AggregateError` that holds the original error and a `TransactionError`, so a `catch` that checked for the original error must read the `errors` array.
- When the rollback itself fails, `afterRollback()` callbacks don't run, and `DB.transaction()` rejects with the rollback error. The query logger's `onTransactionRollback` hook receives that failure once.

### Query logger hooks run outside the connection

Check three behaviors when you upgrade:

- `onQueryStart` runs before its query waits for a slot on the connection. Before, a query that the queue limit rejected never ran `onQueryStart`; now it runs both `onQueryStart` and `onQueryError`.
- A hook can run queries on its own connection without stalling it, and queries a hook runs don't trigger the query hooks again. Before, a hook that queried a busy connection could hang it or loop through the error hook.
- A hook inside a transaction that waits for the transaction to finish, or for other work that needs the transaction's connection, still hangs, because the transaction waits for the hook.

### findMany splits large key lists

`findMany()` can split a key list of more than 256 keys into chunks of 256, as eager loads do, instead of sending every key in one statement. A chunked call runs its own queries, so the query count grows with the number of chunks. Duplicate keys are removed, and each row is returned once. Soft-deleted rows stay excluded, and global scopes still apply to every chunk. Update code or tests that count queries or expect one statement for a long key list.

### Query operators, date values, and foreign-key toggles

Check three behaviors when you upgrade:

- `whereColumn()` accepts only `=`, `!=`, `>`, `>=`, `<`, `<=`, and `like`. Laravel also accepts bitwise and regex operators here; Holo rejects them. Any other operator throws `SecurityError` when the query runs. Change a query that used another operator to one of the supported operators.
- On PostgreSQL, `date` and `timestamp` values use `app.timezone`, which comes from [`APP_TIMEZONE`](/reference/environment) (default `UTC`), instead of the Node process's time zone. A `date` reads back as a `Date` at midnight in `app.timezone`, and a `Date` query value is sent with its offset, so the day doesn't change when you save it again. Before, `timestamp` values were read as UTC wall-clock time, so in an app whose `app.timezone` is not UTC they read back shifted; they now read back as saved. Typed model and query-builder writes of `Date` values, `Date` defaults on `timestamp` columns, and Holo's auth, notification, and database session writes are formatted in `app.timezone` too. Before, these wrote UTC wall-clock text, so in a non-UTC app password-reset, email-verification, access-token, and database session expiries were off by the zone offset, and the database session sweep removed sessions at the wrong time. Holo doesn't rewrite existing rows. Typed `timestamp` columns written by 0.3, and Holo's auth, notification, and database session `timestamp` columns, hold UTC wall-clock values, so they read back shifted in a non-UTC app. Once, before the upgraded app writes to those columns, convert them with `UPDATE my_table SET my_column = (my_column AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York'`, using the zone in your `APP_TIMEZONE`. For a database session table, convert `created_at`, `last_activity_at`, and `expires_at`. Don't convert columns written by untyped `DB.table()` inserts of `Date` values: those already stored app-time values, and converting them shifts them again. Running a conversion twice shifts the values twice. On PostgreSQL, a `timestamp` column without a time zone can't tell the two instants of the hour that repeats when clocks fall back apart. With a non-UTC `app.timezone` that observes daylight saving time, an expiry in that hour can be honored up to one hour late, and a `timestamp` written at the earlier instant reads back an hour later. Set `APP_TIMEZONE=UTC`, which Holo recommends for PostgreSQL apps, to avoid this. Dates inside arrays are unchanged. The PostgreSQL adapter now sets its date and timestamp parsers on each query, so injected `client`, `pool`, and `createPool` objects parse them the same way as the built-in pool. Custom clients and pools must accept a query config object (`{ text, values, types }`) as `pg` does.
- On MySQL, `date`, `datetime`, and `timestamp` values use `app.timezone`, which comes from [`APP_TIMEZONE`](/reference/environment) (default `UTC`), as on PostgreSQL. Holo sets the session time zone to `app.timezone` on every pool connection it creates. MySQL needs its time zone tables loaded for any zone other than `UTC`; load them with `mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql`. Without them, queries fail, and the reason is reported through `exceptions.report`. The `timezone` option no longer changes how dates are read or bound. A `datetime` that holds UTC wall-clock time from 0.3 reads back shifted by the zone offset when `app.timezone` isn't `UTC`. Holo doesn't rewrite existing rows, so convert them or set `APP_TIMEZONE=UTC`. `timestamp` values are stored as instants. In the hour that repeats when clocks fall back, MySQL shows both instants with the same wall-clock time, so a `timestamp` stored at the later instant reads back an hour early, and saving it back stores the earlier instant. Values stored at the earlier instant read and save unchanged. Writes of `Date` values from models, the query builder, and Holo's auth, session, and notification tables are formatted in `app.timezone` too. Before, they were sent as UTC wall-clock time, so in a non-UTC app password-reset, email-verification, access-token, and database-session expiries were off by the zone offset. Zero dates and dates with a zero month or day, such as `0000-00-00` or `2024-01-00`, come back as their stored text. Holo converts dates only on the pools it creates. Injected `client`, `pool`, and `createPool` objects keep their own mysql2 settings and date handling, and Holo doesn't set their session time zone. An app that sets `dateStrings` or `typeCast: false` on a MySQL connection gets the stored date strings, which are already in `app.timezone`, and Date bindings are still formatted in `app.timezone`.
- Foreign-key `onDelete()` and `onUpdate()` values other than `cascade`, `restrict`, `set null`, and `no action` throw `SchemaError`. MySQL `enum` values and string defaults that contain a backslash are now stored as written. Before, MySQL read the backslash as an escape, so the stored value could differ. Existing columns keep their stored values; check them with `SHOW COLUMNS` if they contain backslashes.
- MySQL `enum` values can't contain a backslash or a NUL character. The schema build fails with `SchemaError` naming the value. Before, such a value broke `CREATE TABLE` or was stored altered.
- On MySQL, queries with bindings run as server-side prepared statements, so a quote in a bound string can't end a SQL literal under `NO_BACKSLASH_ESCAPES`. Custom MySQL pools passed to `createMySQLAdapter()` must implement `execute()` for bound queries; the adapter throws a clear error otherwise. Each connection keeps at most 256 prepared statements, where mysql2 keeps 16000 by default. The server allows 16382 prepared statements in total, so many statement shapes, such as `IN` lists of different sizes, would otherwise exhaust it and block every connection. Change the cap with `maxPreparedStatements` in the pool options passed to `createMySQLAdapter()`.
- A transaction started inside `withoutForeignKeyConstraints()` runs on the same pinned connection, one at a time. A query issued on that connection while the transaction is open fails with `TransactionError` instead of joining the transaction. Before, such a query joined the transaction and was rolled back if the transaction failed. Await the transaction before running other queries, or run the query inside the transaction. A transaction that reaches that connection after the callback has returned fails with `TransactionError` and writes nothing.
- `withoutForeignKeyConstraints()` keeps every query in its callback on one pooled connection. The standalone `disableForeignKeyConstraints()` and `enableForeignKeyConstraints()` still change only the connection they run on. On PostgreSQL or MySQL, wrap the work in `withoutForeignKeyConstraints()` instead. See [Foreign key constraints](/database/migrations#withoutforeignkeyconstraints).

### Pivot columns and one-of-many relations

Check three behaviors when you upgrade:

- `pivot` on a many-to-many relation holds only the pivot keys and the columns declared with `withPivot()` and `withTimestamps()`. Before, it held every pivot column. Add `withPivot('column')` for each column your code reads from `pivot`. A custom pivot model from `using()` receives the same columns, so add `'id'` to `withPivot()` if you read the pivot's `id`.
- A one-of-many relation (`latestOfMany`, `oldestOfMany`, `ofMany`, and the morph variants) whose column is `NULL` on every related row loads `null`, as in Laravel. Before, it loaded the first related row. To keep the old result, skip the `NULL` rows with a constraint: `scopeRelation(latestOfMany(() => Post, 'user_id', 'id', 'score'), query => query.whereNotNull('score'))`.
- Eager loads run one query per 256 parent keys, except a relation whose constraint sets `limit()` or `offset()`, which runs as one query so the limit or offset applies to the whole load. A constraint callback passed to `with()` or `scopeRelation()` can run more than once: once per chunk, and for one-of-many relations once for the grouped lookup and once for the outer query. Don't count or log calls inside it.

### MySQL `ssl` with a connection URL

A MySQL connection that sets `ssl` next to `url` now uses that setting, which adds TLS settings to the URL. The URL's own `ssl` parameter takes precedence over the setting, and `ssl: false` doesn't disable TLS that the URL requests. Before, the setting was ignored when `url` was set. Before you deploy, check that the server accepts the connection with `ssl` and that its certificate is trusted, or remove `ssl` if the connection should not use it.

### Query writes set updated_at

On a model with timestamps, these query writes now set `updated_at` to the current time unless you pass your own value: `update()`, `updateJson()`, `increment()`, and `decrement()`. Query `upsert()` sets `created_at` and `updated_at` on new rows, and sets `updated_at` on conflict when you list columns to update. On a soft-delete model, query and instance `delete()` and `restore()` set `updated_at` together with `deleted_at`. Before, all of these left `updated_at` unchanged. Instance `restore()` also saves the model's unsaved changes, as Laravel's restore does, so a changed attribute or primary key is written when you restore.

Check code that reads `updated_at` to find changed rows, such as a "recently updated" list, a cache key, or a sync cursor. Rows you write from now on change `updated_at`; existing rows keep their stored values. `forceDelete()` and the table builder (`DB.table()`) don't change. Use the table builder for a write that must leave `updated_at` alone. See [Query updates](/orm/writes#update-many-rows).


### Nested relation callbacks apply to the leaf relation

A callback on a nested eager load applies only to the relation it names. `with('posts.comments', query => ...)` loads `posts` unconstrained and filters `comments`, as Laravel's `with(['posts.comments' => fn])` does. Before, the callback was also applied to `posts`, so it could only use columns that every model on the path had, and a `comments` column failed at query time.

If your code depended on the old behavior, give each level the constraint explicitly:

```ts
User.with({
  posts: query => query.where('published', true),
  'posts.comments': query => query.where('approved', true),
})
```

Relation callbacks now also type their query builder as the related model, so a callback that uses a column of another model is a type error. `whereRelation()` and `orWhereRelation()` on a nested path check their column against the leaf model too. See [Constraining eager loads](/orm/relationships/loading#constraining-eager-loads).

### Lifecycle handlers and scope constraints are typed

Handlers in a model's `events` option receive the model's entity, and the callback you pass to `scopeRelation()` receives a query on the related model. TypeScript checks the columns those callbacks use and any parameter annotation you wrote. An annotation that doesn't match the entity, or a constraint that names a column the related table lacks, is now a type error. The runtime behavior doesn't change. Correct the annotation or the column name.

### Scope names must not match builder methods

Model scopes are now also methods on every query builder for the model, so a scope name has to be free on the builder as well as on the model. Defining a model with a scope named like a query builder method (`where`, `count`, `get`) or an internal builder property throws a configuration error. Before, the scope silently replaced that method on the model, so a call such as `Post.where(...)` ran the scope instead.

Rename the scope. A name such as `whereActive` or `activeOnly` keeps the meaning clear and does not collide with a builder method. See [Local scopes](/orm/scopes#local-scopes).

### Password hashing cost

New password digests use scrypt with N = 2^15, r = 8, p = 3, up from N = 2^14, r = 8, p = 1. Each hash takes about 6 times as much CPU, because N doubles and p triples, and uses about 32 MiB of memory.

A process runs at most four password hashes at once, so later logins queue instead of exhausting memory. Budget for this on small or constrained hosts.

No migration is needed. A digest made with the old settings still verifies. A successful login replaces it with a new digest for the built-in database providers. A custom provider keeps its old digest until the user changes their password. See [Authentication](/auth/).

### Dev server exits non-zero on a port conflict

`holo dev` now exits with a non-zero status when another `holo dev` for the same project is already running. Before, it exited 0 and left the first server running. A port already in use by another process has always exited non-zero, and it still does, now with the port named. `holo dev` never stops a process for you. Update any CI script or wrapper that treated a second `holo dev` as success. To replace a running server, stop it first, using the PID in the message.

## Earlier 0.3.x releases

Recent Holo-JS releases moved config helpers into the package for each feature, and split database, queue, cache, and storage drivers into their own packages. Your config objects and runtime code keep the same shape. Only imports and dependencies change.

Follow these steps in order.

### 1. Update all Holo packages together

Holo packages are released as one group. Update every `@holo-js/*` package in `package.json` to the same new version, then install:

```bash
npm install
```

Mixing versions of Holo packages is not supported.

### 2. Move config helper imports

Each `define...Config` helper now comes from the package for that feature. `env` stays in `@holo-js/config`.

| Helper | Old import | New import |
| --- | --- | --- |
| `defineAuthConfig` | `@holo-js/config` | `@holo-js/auth` |
| `defineBroadcastConfig` | `@holo-js/config` | `@holo-js/broadcast` |
| `defineCacheConfig` | `@holo-js/config` | `@holo-js/cache` |
| `defineDatabaseConfig` | `@holo-js/config` | `@holo-js/db` |
| `defineMailConfig` | `@holo-js/config` | `@holo-js/mail` |
| `defineMediaConfig` | `@holo-js/config` | `@holo-js/media/config` |
| `defineNotificationsConfig` | `@holo-js/config` | `@holo-js/notifications` |
| `defineQueueConfig` | `@holo-js/config` | `@holo-js/queue` |
| `defineRedisConfig` | `@holo-js/config` | `@holo-js/kernel` |
| `defineSecurityConfig` | `@holo-js/config` | `@holo-js/security` |
| `defineCorsConfig` | `@holo-js/config` | `@holo-js/security` |
| `defineSessionConfig` | `@holo-js/config` | `@holo-js/session` |
| `defineStorageConfig` | `@holo-js/config` | `@holo-js/storage` |

For example, `config/database.ts` changes like this:

```ts [config/database.ts]
import { defineDatabaseConfig, env } from '@holo-js/config' // [!code --]
import { env } from '@holo-js/config' // [!code ++]
import { defineDatabaseConfig } from '@holo-js/db' // [!code ++]

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: env('DB_URL', './storage/database.sqlite'),
    },
  },
})
```

The object you pass to each helper does not change.

### 3. Install the driver packages you use

Drivers are no longer bundled with the feature package. Install the package for each driver your config selects:

| If your config uses | Install |
| --- | --- |
| SQLite (`driver: 'sqlite'`) | `@holo-js/db-sqlite` |
| PostgreSQL (`driver: 'postgres'`) | `@holo-js/db-postgres` |
| MySQL (`driver: 'mysql'`) | `@holo-js/db-mysql` |
| Redis queue | `@holo-js/queue-redis` |
| Database queue or database failed-job storage | `@holo-js/queue-db` |
| Redis cache | `@holo-js/cache-redis` |
| Database cache | `@holo-js/cache-db` |
| S3 storage disk | `@holo-js/storage-s3` |

For example, an app on Postgres with a Redis queue and S3 files:

```bash
npm install @holo-js/db-postgres @holo-js/queue-redis @holo-js/storage-s3
```

Keep the feature packages too (`@holo-js/db`, `@holo-js/queue`, `@holo-js/storage`, and so on). Your app code still imports models, `dispatch`, `Storage`, and other APIs from them. Uninstall any driver package your config no longer uses.

If your code imports a driver directly, update the import:

| Old import | New import |
| --- | --- |
| SQLite adapter from `@holo-js/db` | `createSQLiteAdapter` from `@holo-js/db-sqlite` |
| Postgres adapter from `@holo-js/db` | `createPostgresAdapter` from `@holo-js/db-postgres` |
| MySQL adapter from `@holo-js/db` | `createMySQLAdapter` from `@holo-js/db-mysql` |
| Redis queue driver from `@holo-js/queue` | `redisQueueDriverFactory` from `@holo-js/queue-redis` |
| Database queue driver from `@holo-js/queue` | `databaseQueueDriverFactory` from `@holo-js/queue-db` |
| S3 driver from `@holo-js/storage/runtime/drivers/s3` | default export of `@holo-js/storage-s3` |

The `@holo-js/storage/runtime/drivers/s3` path no longer exists.

### 4. Move schema imports to `@holo-js/validation`

`@holo-js/forms` no longer exports schema builders, and the `@holo-js/forms/schema` entry has been removed. Import `schema` and `field` from `@holo-js/validation`:

```ts [shared/schemas/auth.ts]
import { field, schema } from '@holo-js/forms' // [!code --]
import { field, schema } from '@holo-js/validation' // [!code ++]

export const loginForm = schema({
  email: field.string().required().email(),
  password: field.password().required().min(8),
})
```

Forms helpers such as `validate()` and `useForm()` accept these schemas directly.

#### Read validation errors across framework boundaries

If you use `isValidationException(error)` to recognize a serialized response or framework-wrapped error, switch to `serializeValidationException(error)` from `@holo-js/validation`. It returns the failure payload, or `undefined` for unrelated errors:

```ts
import { serializeValidationException } from '@holo-js/validation'

const payload = serializeValidationException(error)
if (payload) {
  return payload
}
throw error
```

Read field messages from `payload.errors`. Keep `isValidationException()` when you need to narrow a live exception and call its error bag methods. Holo's adapters and `useForm()` handle transported failures automatically. See [Error Messages](/basics/validation/errors#add-errors-from-your-own-logic).

### 5. Add the session revocations table (apps using auth)

Auth now records signed-out sessions in an `auth_session_revocations` table, which other-device logout depends on. New projects include this migration. Existing apps need to add it.

Create an empty migration:

```bash
npx holo make:migration create_auth_session_revocations
```

Replace its contents with the same migration new projects get:

```ts [server/db/migrations/2026_01_01_000000_create_auth_session_revocations.ts]
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ db }) {
    const stringType = db.getDialect().name === 'mysql'
      ? 'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'
      : 'VARCHAR(255)'
    await db.executeCompiled({
      sql: `CREATE TABLE auth_session_revocations (provider ${stringType} NOT NULL, user_id ${stringType} NOT NULL, generation INTEGER NOT NULL DEFAULT 0, retained_session_id ${stringType}, PRIMARY KEY (provider, user_id))`,
      source: 'schema',
    })
  },
  async down({ schema }) {
    await schema.dropTable('auth_session_revocations')
  },
})
```

Then run it:

```bash
npx holo migrate
```

The table is required whichever session store you use. On MySQL it requires MySQL 8.0.17 or later.

::: warning
After you deploy this change, users who are signed in through the browser must sign in again. Existing API tokens keep working.
:::

### 6. Plugin authors: depend on `@holo-js/kernel`

If you maintain a Holo plugin:

- Add `@holo-js/kernel` as a dependency.
- Import `defineHoloPlugin` and the plugin types from `@holo-js/kernel` instead of `@holo-js/cli`.
- Make sure plugin IDs and contribution names are unique. Holo rejects absolute paths and paths that point outside the plugin package.
- If your plugin adds a config file, register its normalizer with `registerConfigNormalizer` from `@holo-js/config`, and augment `HoloConfigRegistry` so `useConfig()` infers its type.

See [Writing Plugins](/advanced/plugins) for the full package layout.

### 7. Declare your trusted proxies

`HOLO_SECURITY_TRUST_PROXY` is gone. Holo now identifies visitors by their connection address, and reads forwarded headers only from proxies you list in `config/security.ts`:

```ts [config/security.ts]
import { defineSecurityConfig } from '@holo-js/security'

export default defineSecurityConfig({
  trustedProxies: ['127.0.0.1', '::1'],
})
```

- Remove `HOLO_SECURITY_TRUST_PROXY` from your `.env` files.
- If you set it, list your proxies' addresses or ranges instead. Use `'*'` for a hosting platform whose proxy address you don't know. See [Trusted proxies](/basics/security/cors-and-proxies#trusted-proxies).
- Next.js apps need `trustedProxies`, because Next.js doesn't expose the connection address.
- Call `ip(request)` without the second argument. It now follows `trustedProxies`.

### 8. Verify

Regenerate Holo's files and check that everything compiles and passes:

```bash
npx holo prepare
npm run typecheck
npm run build
```

Run your test suite as well. Fix any import errors the type checker reports; they point at the imports from steps 2 to 4 and `ip()` calls from step 7. Then deploy as usual. Your deploy's build step runs `holo build`, which refreshes the generated files.

### Give custom auth contexts a request scope

If you supply your own `AuthRuntimeContext`, add `getRequestScope(): object`. Return one stable object per request, with a different object for every request. Holo uses it to cache remember cookies safely and combine concurrent guard restorations into one browser session. Built-in auth contexts provide this automatically. Remember-cookie writes require a scope and throw `runtime_unconfigured` before changing authentication when it is missing. This includes remembered login, clearing an existing remember cookie on login or logout, and renewing it through other-device logout. Without a scope, you can still restore remembered guards sequentially; cookie reads remain uncached.

## Next steps

- [Configuration](/getting-started/configuration)
- [Packages](/reference/packages): what each `@holo-js/*` package is for
- [Deploying Holo Apps](/deployment/)
