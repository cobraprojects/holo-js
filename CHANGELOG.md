# Changelog

## Unreleased

- Make `@holo-js/validation` the only public schema-builder package. Remove schema builders from `@holo-js/forms` and remove the `@holo-js/forms/schema` entry.
- Accept `@holo-js/validation` schemas directly in Forms submission helpers and framework form adapters.
- Keep compiled browser validation on the Validation entry and reject the removed Forms schema entry in packaged-export checks.
- Generate the application key and broadcast app ID, key, and secret in `holo new`, writing them to `.env` with blank values in `.env.example`. `holo install broadcast` adds missing broadcast values to existing apps. Broadcast config no longer falls back to the literal `app-id`, `app-key`, and `app-secret`. Missing broadcast credentials fail when the worker starts, a broadcast is published, or a channel is authorized, not at config load, and the error names `BROADCAST_APP_ID`, `BROADCAST_APP_KEY`, and `BROADCAST_APP_SECRET`. Flux refuses to connect without a broadcast key instead of using `app-key`. Scaffolded broadcast projects run `holo install broadcast` in `prepare`, so a clone without `.env` installs and prepares.
- `config:cache` evaluates `env()` with the real environment values and stores them in the cache file, so runtime `.env` changes don't affect cached config. Config modules that contain functions (`app` with reporters, `security` with callbacks, and `database` when it holds functions) still load from their files, and the `env()` values they read while loading are frozen in the cache too. Code that calls `env()` after startup, such as a reporter's body, reads the runtime environment. Caches written before this change are ignored until `config:cache` runs again. The cache format is version 5; 0.3.x and earlier caches are ignored.
- Markdown mail links escape their `href` once, so `[Search](https://example.test/?a=1&b=2)` renders `href="https://example.test/?a=1&amp;b=2"` instead of a double-escaped URL that doesn't work. Links with unsafe schemes such as `javascript:` still render as plain text.
- File sessions no longer time out acquiring a lock when several requests write the same session on a slow or busy file system. A waiter's timeout restarts whenever the lock changes hands (capped at 30 seconds), and a lock whose owner released it but couldn't delete its file is reclaimed by any process, not only the owner.
- `env()` with a boolean or number fallback throws, naming the variable, when the value doesn't convert, instead of returning the fallback.
- Run event listeners in registration order with sync and queued listeners interleaved, as Laravel's dispatcher does. Before, every sync listener ran first and queued listeners were sent after them. A listener that throws, or a queued listener that can't be sent, stops the dispatch and rejects it, so later listeners don't run.
- Report notification channel failures after a transaction commits through `exceptions.report`, with capability `notifications` and operation `channel.afterCommit`. Before, these failures were not reported at all.
- `queue:listen` forwards `SIGINT` and `SIGTERM` to its worker and exits only after the worker closes, so no worker is left running after `queue:listen` stops. A restart waits for the old worker to close. A process error while the old worker stops ends `queue:listen` with that error instead of starting a replacement. See [Develop with queue:listen](apps/docs/docs/queue/workers.md#develop-with-queue-listen).
- Holo CLI commands that run npm, pnpm, or yarn, such as dependency installs and the framework `prepare` and `sync` steps, launch on Windows. Before, they failed with `spawn npm ENOENT` because the package manager's `.cmd` shim can't be started without a shell.
- Reconfiguring Holo never closes a Redis connection or rate-limit store while an operation is still using it. Unchanged Redis connections are reused instead of reopened. A replaced connection or store closes as soon as its last in-flight operation settles, a failed reconfiguration releases what it acquired, and a replaced resource that fails to close is reported without failing the reconfiguration. Reconfiguration and shutdown run one at a time, so concurrent calls can't open a connection twice and leave one behind. Before, every reconfiguration closed the previous rate-limit and session Redis connections immediately, so requests in progress could fail with `Connection is closed`. A store you keep and use outside an operation fails with that error once its configuration is replaced. See [How startup works](apps/docs/docs/advanced/architecture.md#what-happens-when-your-app-starts).
- A plugin boot hook that is still running when the runtime resets or shuts down doesn't mark its module as booted, so the next initialization boots the module again.
- An auth call made in the root async context during startup no longer shares its auth state with later requests that set their own request accessors, so each such request sees only its own session and user.
- Browser Realtime and Flux connections reconnect after the WebSocket closes or fails, with backoff from about half a second up to 30 seconds. Live queries and channels resubscribe on reconnect, and a live query shows the current result after recovery. A worker shutdown no longer sends an error to every active subscription; it logs one warning and the subscriptions resume when the worker returns. A realtime mutation in flight when the socket closes rejects and is not sent again. `disconnect()` stops reconnecting, and a Realtime connection also stops once its last subscription is removed. A subscription made while the connection is recovering waits for the next successful connection instead of failing. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#browser-connections-reconnect).
- Node.js Broadcast workers ping each WebSocket connection every 30 seconds and close a connection that sends nothing else before its next ping and doesn't answer the one before. Before, a connection that stopped answering stayed open indefinitely. See [Dead connections](apps/docs/docs/broadcasting/production.md#dead-connections).
- Broadcast presence members are tied to a Redis lease that each worker refreshes every 10 seconds. When a worker stops refreshing for 30 seconds, other workers remove its presence members from their rosters, with `pusher_internal:member_removed` events, within about 40 seconds of the worker crashing. A member that is also connected to a live worker stays listed. Before, a crashed worker's members stayed listed indefinitely. See [Run several workers](apps/docs/docs/broadcasting/production.md#run-several-workers).

### Added

- Add optional `AuthRuntimeContext.getRequestScope()` for request-isolated remember-me state and concurrent guard restoration. Remember-cookie writes require a scope; unscoped custom contexts retain uncached sequential restoration.

- Add `addMediaFromDisk(path, disk)` to attach a file already on a storage disk. Holo copies it to the collection's disk and leaves the original in place. `config/media.ts` reads `MEDIA_DISK` as `disk`, which sets the disk for collections without `disk()` and defaults to `public`. See [Media](apps/docs/docs/media/index.md#add-media-from-a-disk).
- Add `holo migrate --isolated`, which takes a database lock so concurrent runners, such as deploy replicas, don't apply the same migrations. A run that finds the lock held skips the migrations and exits successfully. The lock lives in `_holo_migration_locks`, expires an hour after it was last renewed if a runner stops, and is renewed before each migration. See [Isolating migration runs](apps/docs/docs/database/migrations.md#isolating-migration-runs).
- Add `--force` to `holo migrate:rollback`.
- Add `attempts` to transaction options. `DB.transaction(callback, { attempts: 3 })` runs the transaction again after a deadlock, a lock wait timeout, or a busy SQLite database, as Laravel's `DB::transaction()` does. See [Retry deadlocks](apps/docs/docs/database/transactions.md#retry-deadlocks).
- Add `.afterCommit()` to queue dispatches and `afterCommit` to queue connections (default `false`), so a job dispatched inside a database transaction is queued only after it commits.
- Add `failOnTimeout` to `defineJob`, so a timed-out run fails the job immediately instead of retrying it.
- Accept `tries` and `backoff` on queued mail, notifications, and event listeners, and `--tries` and `--backoff` on `queue:work` and `queue:listen`. Framework-owned queued jobs run once unless `tries` is set.
- Add `holo storage:decode-names --disk=<name>` to rename files that 0.3 stored on a local disk under URL-encoded names to their exact names. It never replaces an existing file, and it skips ambiguous names, existing targets, names that collide when case or Unicode normalization is ignored, names Windows can't store, and symbolic links (never followed, along with their metadata), reports any rename that fails and keeps going, and running it again right away renames nothing. See [storage:decode-names](apps/docs/docs/reference/cli.md#storage-decode-names).
- Add `exceptions.report` and `exceptions.dontReport` to `config/app.ts`, and `report(error)` from `@holo-js/core`. Errors that Queue hooks, Auth cleanup, Cache flexible refresh and driver disposal, query-cache invalidation listeners, the Broadcast worker and Realtime subscription callbacks previously logged to the console are reported with their capability and operation. A throwing or rejecting reporter never breaks the originating request or job. Without a reporter, errors go to `console.error`. `config:cache` keeps an `app` config with a reporter live, so it is loaded from `config/app.ts` at runtime. See [Reporting errors](apps/docs/docs/basics/errors.md#reporting-errors).
- Add explicit other-device browser logout through `auth.logoutOtherDevices()` and session-guard `logoutOtherDevices()`, backed by durable provider/user revocation state. Retain the current logical browser session and reject the selected identity on other browsers' next authenticated request, including remember-cookie restoration. Unrelated identities and personal access tokens remain valid. Applications own recent reauthentication policy; Clerk and WorkOS logout affects Holo sessions, not upstream provider sessions.
- Add `tokens.revokeOthers({ guard })` to revoke a user's other personal access tokens while retaining the verified token used for the current request. Browser-session revocation remains separate.
- Allow session rotation to receive a complete replacement `data` payload and `renewLifetime`. Auth transitions renew lifetime while preserving private flash state and remember policy; ordinary rotation retains its defaults.
- Add a `LICENSE` file (MIT) at the repository root and in every published package, and list it in each package's `files`.
- Add `SECURITY.md` with a private reporting channel and the supported-version policy.
- Add a [versioning policy](apps/docs/docs/getting-started/versioning.md) to the documentation: what `0.MINOR.PATCH` means, what a breaking change is, and how security fixes ship.
- Add `repository` metadata to every published package, pointing at its directory in the Holo-JS repository.

### Security

- Raise the default scrypt password cost to N = 2^15, r = 8, p = 3 (about 32 MiB per hash, up from N = 2^14, r = 8, p = 1), following the OWASP Password Storage Cheat Sheet's equivalent setting for N = 2^17, r = 8, p = 1. A process runs at most four password hashes at once, so peak scrypt memory stays near 128 MiB whatever `UV_THREADPOOL_SIZE` is. A successful login replaces a digest made at older settings for the built-in database providers, with one conditional write that only applies if the stored digest is still the one just verified. Custom providers keep their digest until the password changes, and a failed save does not fail the login. Digests made at N = 2^14, r = 8, p = 1 still verify. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#password-hashing-cost).
- WorkOS sign-in no longer falls back to the access token or authorization code as the session ID. A callback whose WorkOS response has no session ID, or one that is not in the WorkOS session ID shape, fails with `workos_auth_failed` and creates no session, so those values can no longer reach WorkOS in the logout URL or the session payload. Logout sends a stored value upstream only when it has the shape of a WorkOS session ID; sessions stored by earlier versions with a token or code log out locally. The WorkOS sign-in state cookie is `Secure` when `session.cookie.secure` is `true`, and when the request is HTTPS through a trusted proxy. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#workos-sign-in-requires-a-session-id).
- Harden remote-fetch address classification in `addMediaFromUrl()`. See [Add media from a URL](apps/docs/docs/media/index.md#addmediafromurl).
- Read the forwarded scheme, host, port, and path prefix for public and temporary storage URLs only from `trustedProxies`, through the same resolver as `resolveRequestUrl()`. Before, the Nuxt storage route accepted `X-Forwarded-Proto` from any client. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#temporary-urls-behind-a-proxy).
- Build the Nuxt realtime query, realtime mutation, and broadcast auth requests with one helper that leaves forwarded headers to `resolveRequestUrl()`, so these routes apply the same trusted-proxy rule as storage. These routes don't read the request scheme today, so their responses don't change.
- Keep hidden foreign keys out of Realtime patches. When a model hides, shows only some, casts, or appends attributes, or a handler changes visibility or appends attributes on the records it loads, Realtime re-runs the query instead of patching it when a belongs-to foreign key changes, so the hidden key can no longer reach subscribers through a patch. Plain models keep incremental patching. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#realtime-relations-honor-hidden-attributes).
- Enforce the configured remember lifetime on the server using an authenticated expiry in each encrypted recaller. Replayed expired remember cookies cannot restore authentication.
- Bound each Broadcast browser connection to 100 channels and 100 realtime query subscriptions. The worker closes a connection that sends more than 200 messages in a one-second window or whose buffered output exceeds 4 MB, with code `1008`. Refused channel and realtime subscriptions beyond the limits return status `429` and keep the socket open. See [Connection limits](apps/docs/docs/broadcasting/production.md#connection-limits).
- Bound rate-limit storage in every driver. The memory store keeps at most 10,000 keys per process. When it is full it drops expired keys first, then limits new keys until one expires, and it never evicts a live counter. The file store deletes expired key files in the background at most once a minute, and it hashes each key once. The Redis store keeps one counter per key, so rejected attempts no longer add Redis state. See [Rate limiting](apps/docs/docs/basics/security/rate-limiting.md#drivers).
- Local disks refuse `delete()`, `removeItem()`, and `clear()` paths that lead outside the disk root through a symlink, and `clear()` with no base empties the root without replacing a symlinked root folder. Deleting an in-disk symlink removes only the link. On Windows, public and temporary URLs whose names Windows would resolve to another file, such as `report.txt%24.` for the `report.txt$` metadata file, return 404. See [Safe paths](apps/docs/docs/storage/index.md#safe-paths).
- New local files and folders use Laravel's permissions: `0600` files and `0700` folders on private disks, `0644` and `0755` on public disks. Existing files and folders keep their permissions. See [Local disk permissions](apps/docs/docs/getting-started/upgrading.md#local-disk-permissions).
- Harden the Broadcast worker protocol. A refused or failed channel subscription returns `pusher:subscription_error` and keeps the socket open; Flux marks that channel unsubscribed and retries it on the next subscribe or connect. `holo broadcast:work` authorizes unsigned private and presence subscriptions with the user resolved from the connection's session cookie or `Authorization` header and refuses them without a user. Socket IDs use the full Pusher range and duplicate IDs are refused. Unexpected subscription, Realtime and publish errors go to the error reporter while clients receive a generic message; `RealtimeError`, access and validation errors keep their message. See [Broadcast errors](apps/docs/docs/broadcasting/production.md#errors).

- Read forwarded headers as Laravel's TrustProxies does. Honor only `X-Forwarded-For`, `-Host`, `-Port`, `-Proto`, and `-Prefix` from trusted proxies, taking the first value of each list except `X-Forwarded-For`, and ignore `Forwarded`. Trust headers from an unknown connection address only with `trustedProxies: '*'`, so Next.js apps with a proxy list ignore them. Skip `X-Forwarded-For` entries that aren't IP addresses, treat unknown `X-Forwarded-Proto` values as HTTP, and add `X-Forwarded-Prefix` to the path of `resolveRequestUrl()`. Nuxt requests over a Unix socket, as behind `nuxt dev`, come from `127.0.0.1`. Nuxt CSRF, broadcast-auth and realtime requests no longer take `X-Forwarded-Proto` from h3 for untrusted peers. WorkOS sign-in sends the trusted client IP instead of the raw first `X-Forwarded-For` entry or `X-Real-IP`. Rate-limit keys keep the full client IP. See [Trusted proxies](apps/docs/docs/basics/security/cors-and-proxies.md#trusted-proxies).
- Leave passwords and `sensitive()` fields out of every serialized validation failure, including inside nested objects and arrays: `ValidationException` `values` and `toJSON()` from Validation and Forms `validate()`, Forms `fail()` and `serialize()`, and the 422 responses from Next.js, Nuxt and SvelteKit. `useForm()` clears the same fields after a failed submission, including items of sensitive arrays. The Nuxt form-failure cookie no longer carries submitted values and is `Secure` on HTTPS requests. See [Sensitive data](apps/docs/docs/basics/validation/rules.md#sensitive).
- Bound validation work by request size. Form bodies and query strings are limited to 1,000 non-file input variables and, separately, 1,000 uploaded-file entries per form, and a list index must be lower than the number of distinct indexes submitted for that list. Names are limited to 64 nesting levels after the root, matching PHP’s default `max_input_nesting_level`. Too many variables or uploaded-file entries, overly deep names, out-of-range indexes, `__proto__`/`constructor`/`prototype` names and names used with two shapes (for example an object and a list, or numbered indexes and `[]`), whatever their order, and names with unclosed or unmatched brackets fail validation on `_root` instead of throwing; malformed JSON and form bodies validate as `{}`. Array `max()` and `size()` are checked before any item is validated, and image files larger than their `max()`, `maxSize()` or `size()` in the same transform segment are not decoded, and size rules check the value at their own place in the chain, so a transform can't bypass them. Errors thrown by `custom()` and `customAsync()` now propagate as server errors instead of becoming a `_root` validation message. See [Input limits](apps/docs/docs/basics/validation/index.md#input-limits).
- Refresh Apple, Clerk and WorkOS signing keys once when a token names a key ID the cache doesn't hold. Cached keys expire after 10 minutes, a provider's keys refresh at most once a minute, and concurrent refreshes share one request. Forged tokens therefore can't trigger repeated key fetches, and a failed key fetch waits a minute before the next attempt. Signature failures under a known key ID no longer refetch keys.
- Keep hidden, visible, cast, accessor and appended attributes out of Realtime relation patches. A relation whose related model sets any of them is re-run instead of patched from raw rows, so belongs-to, has-one, has-many and belongs-to-many relations send the same serialized values as a fresh query. Plain related models keep incremental patching. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#realtime-relations-honor-hidden-attributes).
- Isolate Realtime query results and refresh state per server subscription. Every subscription runs authorization independently; identical query names and arguments no longer reuse another caller’s result. Browser client store sharing is unchanged.

- Close model mass assignment by default. A model without `fillable` or `guarded` rejects every column, and the primary key and `created_at`/`updated_at` columns are guarded unless named in `fillable`. Mass assignment rules are checked when attributes are assigned: `fill()`, `set()` and property assignment reject guarded columns, judging `column->path` keys by their column, and `forceFill()` assigns without checking. Model state is held in private fields, so properties copied onto a model with `Object.assign()` can't change what it saves. Saves, deletes, restores and force deletes target the row's original primary key, so changing a loaded model's key can't redirect the write to another row. See [mass assignment](apps/docs/docs/orm/index.md#mass-assignment).

- Group model caller conditions, each global scope, and soft-delete filters independently. Prevent `orWhere()` from leaking foreign or deleted rows through reads, eager loads, and `whereHas()`, and keep instance updates and deletes restricted to their target row.

- Link a social sign-in to an existing local user only when that user's email is verified. A provider-verified email matching an unverified local user now throws `SocialAuthConflictError` (`social_identity_conflict`) instead of signing in as that user. Email verification tokens only verify the address they were sent to and are rejected after the user's email changes. See [Link an existing account](apps/docs/docs/auth/social-login.md#link-an-existing-account).
- Make email-verification and password-reset token redemption single-use under concurrent requests. Coordinate the claim and user mutation transactionally when Core proves they share the same database context. Password reset also revokes sibling tokens for the same provider, email and broker table before user mutation.
- Fail closed after authenticated-session transition failures: invalidate the new session, clear affected request identities, keep the previous session identifier invalidated, and report cleanup failures alongside the original error. Ordinary login and rotation preserve other devices' authentication.
- Make token-guard `logout()` revoke its verified current token before clearing request identity. A deletion failure rejects logout and preserves that request identity; other tokens and browser sessions remain valid.
- Confirming multi-factor enrollment cycles the user's remember token, so remember cookies issued before enrollment stop restoring a session that would skip the new TOTP challenge. The enrolling browser keeps its session and gets a fresh remember cookie only if that login was remembered.
- `login()`, `loginUsing()`, `logout()` and the other calls that set authentication cookies throw `cookie_write_unavailable` in a context with no response cookie writer, the same as a read-only Next.js render, instead of reporting success without setting the cookie.
- A session restored from a remember cookie is never recent authentication: `multiFactor.beginEnrollment()` and `confirmEnrollment()` reject it with `multi_factor_reauthentication_required` until the user signs in with a password. An explicit login establishes fresh authentication.
- `refreshUser({ fresh: true })` in a request with no response cookie writer refetches the remembered user from the provider and returns null once that user is deleted.
- Other-device logout cycles the remember token only after the caller is retained, so a browser that loses the revocation race no longer invalidates the winner's reissued remember cookie.
- Remember cookies expire from the configured remember lifetime, not from the cookie's `Max-Age`, so a session runtime that sets only `Expires` still restores. Custom session runtimes report that lifetime through `rememberMeLifetimeMinutes()`.
- `impersonate()` and `impersonateById()` refuse `remember: true` with `impersonation_remember_unsupported` before changing any state. Impersonation never issues a remember-me cookie for the impersonated user, so a copied cookie can't restore a session as that user with no actor.
- Logging out during impersonation cycles the actor's remember-me token, as a normal logout cycles the signed-in user's token, so a copied actor cookie stops restoring.
- Remember-me restoration rotates the session ID, as Laravel's `migrate(true)` does on every login, so a session ID planted by another subdomain no longer becomes authenticated when a remember cookie restores. The planted ID is destroyed.
- Write capability is checked before any side effect: login, logout, impersonation, multi-factor challenge completion, other-device logout and multi-factor enrollment confirmation refuse with `cookie_write_unavailable` before they touch state. Confirming multi-factor enrollment refreshes a remembered user's cookie before saving the credential, so a rejected cookie write no longer loses the recovery codes.
- Next.js, Nuxt and SvelteKit report whether they can set cookies and throw `cookie_write_unavailable` outside a request, instead of silently skipping the cookie.
- Remember-me restoration without a response cookie writer, such as a custom context that omits `appendResponseCookie`, authenticates the request without persisting a session, matching the read-only Next.js case.
- Remember-me restoration in a read-only cookie context, such as a Next.js Server Component render, authenticates that request without persisting a session. Explicit `login()` and `logout()` there throw the cookie-write error instead of reporting success.
- Remember me uses one `remember_token` per user, as in Laravel. The encrypted remember-me cookie carries the user ID, the token and a hash of the password hash, compared in constant time, and restores the user after the session expires for up to `rememberMeLifetime`. `logout()` cycles the token so remember-me cookies on every device stop working while other active sessions remain; `logoutOtherDevices()` cycles it too and resends the current browser's cookie. With multi-factor auth the cookie is set only after the challenge passes. Session records no longer carry remember credentials. See [Per-user remember-me tokens](apps/docs/docs/getting-started/upgrading.md#per-user-remember-me-tokens).
- Store the CSRF token in the session, following Laravel's `VerifyCsrfToken`. The CSRF middleware starts a session for new visitors, and the `XSRF-TOKEN` cookie carries the encrypted session token. `_token` (form body, JSON body or query string) and `X-CSRF-TOKEN` accept the plain token or the encrypted cookie value, and `X-XSRF-TOKEN` accepts the encrypted cookie value. A token planted by another browser or subdomain is rejected. Security reads the session through an accessor Core injects and has no dependency on Session. See [CSRF tokens stored in the session](apps/docs/docs/getting-started/upgrading.md#csrf-tokens-stored-in-the-session).
- Initialize session CSRF tokens atomically without restoring sessions removed by a concurrent login, logout or password reset.
- Repair invalid reserved CSRF session tokens atomically, preserving a valid token initialized by another request. Next forwards a newly issued session to the route handling that same request, so its first token and submission use the same browser session.
- Delete expired sessions as Laravel does: about 2 in 100 requests that write a session sweep expired file and database sessions. The file sweep skips locked sessions and never follows symbolic links. Redis sessions already expire through their TTL. See [Expired session cleanup](apps/docs/docs/basics/session.md#expired-session-cleanup).
- Reject CORS configuration that combines wildcard origins with credentials. Wildcard origins answer `Access-Control-Allow-Origin: *`, and `X-XSRF-TOKEN` is an allowed header by default.
- Encrypt the cookies Holo sets (session, remember-me and `XSRF-TOKEN`) with AES-256-GCM keyed from `APP_KEY`, bound to each cookie name. Changed, swapped, plaintext or foreign-key cookies are treated as absent. CSRF tokens are random values protected by the encrypted cookie instead of an HMAC signature; the `_token` field and `X-CSRF-TOKEN` header accept the plain token or the cookie value. Application cookies are not encrypted. See [Encrypted session, remember-me, and CSRF cookies](apps/docs/docs/getting-started/upgrading.md#encrypted-session-remember-me-and-csrf-cookies).
- Allow only `=`, `!=`, `>`, `>=`, `<`, `<=`, and `like` in `whereColumn()`. Other operators throw `SecurityError` instead of being written into the SQL text. Reject foreign-key `onDelete()` and `onUpdate()` values other than `cascade`, `restrict`, `set null`, and `no action` with `SchemaError`. Write MySQL string defaults and JSON paths that contain a backslash as hexadecimal literals, so their stored text doesn't depend on `NO_BACKSLASH_ESCAPES`. Reject MySQL enum values with a backslash or NUL character with `SchemaError`. Run MySQL queries with bindings as server-side prepared statements, so a quote in a bound string can't end a SQL literal under `NO_BACKSLASH_ESCAPES`. Each MySQL connection keeps at most 256 prepared statements, so distinct statement shapes can't exhaust the server's `max_prepared_stmt_count`. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#query-operators-date-values-and-foreign-key-toggles).
- Pad failed logins and every reset-link request to at least 200 ms, as Laravel's timebox does, so response timing doesn't reveal whether an account exists. Successful logins are not delayed.
- Password reset cycles the user's remember token, as Laravel does. Remember-me cookies issued before the reset stop restoring, and browsers that are still signed in keep their sessions.
- `db-mysql`: keep the configured `ssl` option when a URL is set. Before, `ssl` was dropped when `url` was set. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#mysql-ssl-with-a-connection-url).

### Changed

- `addMediaFromUrl()` fetches public IPv6-literal URLs such as `http://[2606:4700:4700::1111]/hero.jpg`, which were refused because the brackets stayed in the hostname. An IP literal is checked against the same address rules as a resolved address and skips DNS. A loopback or private IPv6 literal is refused with the same message as a hostname that resolves to one, `must not resolve to local or private hosts`. IPv4 literals that point at a local or private network now get that message too, where they used to get `must not target local or private hosts`. The IPv6 block list also refuses, for literals and resolved addresses alike, `fec0::/10`, `100::/64`, `100:0:0:1::/64`, `2001:db8::/32`, `3fff::/20`, `5f00::/16`, and the `2001::/23` IETF protocol assignments except the globally reachable sub-blocks in the IANA IPv6 Special-Purpose Address Registry. The IPv6 check is an allowlist: only global unicast `2000::/3` is eligible, so reserved and unassigned IPv6 space is refused for literals and resolved addresses alike. IPv6 addresses outside `2000::/3` that embed an IPv4 address, such as `::ffff:0:0/96` and `64:ff9b::/96`, are fetched only when the embedded IPv4 address is itself allowed. The IPv4 block list also refuses `240.0.0.0/4`, `255.255.255.255`, and `192.88.99.2`, and refuses `192.0.0.0/24` except its globally reachable `192.0.0.9` and `192.0.0.10`, as listed in the IANA IPv4 Special-Purpose Address Registry.
- Many-to-many relations (`belongsToMany`, `morphToMany`, `morphedByMany`) load only the pivot keys and the columns declared with `withPivot()` and `withTimestamps()` into `pivot`, as Laravel does. Before, every pivot column was loaded. See [Reading pivot columns](apps/docs/docs/orm/relationships/many-to-many.md#reading-pivot-columns).
- One-of-many relations (`latestOfMany`, `oldestOfMany`, `ofMany`, and their morph variants) choose the related row in the query, as Laravel does, instead of loading every related row into memory. A relation whose column is `NULL` for every candidate loads `null`, as in Laravel; before, it loaded the first candidate.
- Eager loads and relation filters split their key lists into chunks of at most 256 keys, so a relation loaded for thousands of parents stays within database bind-parameter limits. Each chunk runs its own query. A relation whose constraint sets `limit()` or `offset()` runs as one query, so the limit or offset applies to the whole load, as in Laravel.
- `scopeRelation()` types its constraint callback as a query on the related model, so the columns it can name are checked. Lifecycle handlers in `events` are typed as receiving the model's entity, not `(...args: unknown[])`.
- `auth.user()` loads the user from the provider once per request. Session records no longer store a copy of the user, and existing copies are ignored.
- `resendEmailVerification()`, `sendEmailVerification()` and `verification.resend()` no longer accept an email address. They send only to the signed-in user and throw `email_verification_user_missing` (401) without one. See [Verification resend requires a signed-in user](apps/docs/docs/getting-started/upgrading.md#verification-resend-requires-a-signed-in-user).
- SvelteKit apps without a `handleError` export log unexpected errors through the reporter and answer with SvelteKit's generic message, `Internal Error`, instead of the error's message. The error's message is returned only while `debug` is `true`. Application `handleError` hooks and validation responses are unchanged. See [Unexpected SvelteKit errors](apps/docs/docs/getting-started/upgrading.md#unexpected-sveltekit-errors).
- `debug` in `config/app.ts` defaults to `false` when `APP_DEBUG` is unset, as in Laravel. Set `APP_DEBUG=true` in local `.env` files. See [Debug defaults to false](apps/docs/docs/getting-started/upgrading.md#debug-defaults-to-false).
- Flush cache stores completely. Redis `flush()` runs `FLUSHDB` on the store's database (every primary node of a cluster), the `database` store empties its entries table and leaves locks alone, and the `file` store empties its entry and lock folders. Key prefixes no longer limit a flush, so the prefix options are removed from the Redis, database and file driver factories. The scaffold gives the Redis cache store its own `cache` connection on database `1` (`REDIS_CACHE_DB`). See [Cache drivers](apps/docs/docs/cache/drivers.md#redis).
- Fix transaction nesting and commit integrity. A `transaction()` call on a connection object while a transaction is open on that connection joins it as a savepoint, instead of starting a second transaction that committed the outer work early on PostgreSQL and MySQL. Savepoints on one transaction run one at a time. `timeoutMs` and `signal` only limit how long a transaction takes to start, so a commit or rollback is never interrupted and a committed transaction is never reported as rolled back. A failed commit doesn't run `afterRollback` callbacks. An `afterCommit` callback's error reaches the caller unchanged and skips the callbacks after it. See [Transactions](apps/docs/docs/database/transactions.md).
- Give database cache locks a single holder under contention. Acquisition replaces an expired lock only while it is still expired, and release frees only a lock the caller still owns. Expired lock rows are pruned by a lottery on about 2% of lock attempts. See [Cache drivers](apps/docs/docs/cache/drivers.md#database).
- Media treats `addMedia()` strings as local file paths and never downloads them. `addMediaFromUrl(url)` is the only way to download a remote file, and `addMedia({ url })` is removed. Remote downloads must finish within 30 seconds, including the body. Image conversions reject images over 40 million pixels or 1,000 frames and generate before the database transaction starts. See [Media strings are file paths](apps/docs/docs/getting-started/upgrading.md#media-strings-are-file-paths).
- `holo migrate:fresh`, `holo migrate:rollback` and `holo seed` ask for confirmation when `APP_ENV` is `production`, as Laravel's confirmable commands do. Without a terminal they stop with an error unless `--force` is passed, and `--force` is honored by all three. `migrate:rollback` previously ignored `--force`.
- `@holo-js/core` and `@holo-js/adapter-nuxt` decide whether to read the config cache from the resolved application environment instead of `NODE_ENV`, so `APP_ENV` in `.env` selects the cache the same way it selects env files. Nuxt project accessors cache the loaded project under the same rule.
- Realtime queries and mutations on Next.js, Nuxt and SvelteKit resolve definitions only from the prebuilt list, and never scan or bundle realtime files per request. A name missing from that list answers `404` instead of `400`. Nuxt generates the list from `server/realtime`, as Next.js and SvelteKit already do.
- Make rate-limit windows the same in the memory, file, and Redis drivers. A window starts with a key's first attempt, lasts `decaySeconds`, counts rejected attempts, and is not extended by them. The Redis driver used a sliding window before. Redis buckets are now counters, so clear buckets left by 0.3.x with `holo rate-limit:clear --all`. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#rate-limit-windows-are-fixed-in-every-driver).
- Local disks store files under their exact names, like Laravel, so `path('reports/Q1 café.pdf')` returns `<root>/reports/Q1 café.pdf`. Low-level keys from local and S3 disks escape only `%`, `:`, and `$` inside a name. Local file names ending in `$` are reserved for metadata. See [Local file names](apps/docs/docs/getting-started/upgrading.md#local-file-names).
- Nuxt uses the same hardened local disk backend as Next.js, SvelteKit, and plain Node, so local `stat()`, `listFiles()`, `readStream()`, and `writeStream()` work on Nuxt. The Nuxt adapter no longer registers Nitro `holo:<disk>` storage mounts, the Nitro S3 driver, or `runtimeConfig.holoStorage`, and `@holo-js/storage` drops `applyNitroStorageConfig()`, `buildStorageConfig()`, `buildStorageConfigWithDriver()`, `StorageConfig`, `NitroStorageLike`, and `StorageAdapterOptionsLike`. Local `exists()` no longer reads file contents, so unreadable files still exist, and returns `false` for folders. Local `listFiles()` reads only the folders a page needs instead of the whole disk. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#local-storage-on-nuxt-and-symlinks).
- Require CI typechecks, lint and the full library suite on Node 24, plus native package loading and server lifecycle checks on Linux, Windows and macOS with Node 22.14.0, 24 and 26. Example-app, published-package, scaffold and browser-bundle acceptance run locally with `bun run test`. Monitor npm and Actions updates, block high/critical published-runtime dependency advisories, and reject new Fallow dead-code findings against a pinned baseline. Concurrent test typechecks retain their own generated configurations.

- Core capability disposal and startup rollback continue cleanup after individual failures, close only Holo-owned resources, and restore prior live bindings. Multiple failures are reported together. Queue asynchronous shutdown closes all owned drivers and resets state even if closure fails.
- Queue separates handler outcomes from reservation finalization. Acknowledgement, release, failed-job persistence or reservation deletion errors stop `runQueueWorker` with the original adapter error instead of entering handler retry logic. Terminal failures are persisted before reservation deletion; delivery may repeat according to driver reservation semantics. See [worker failure semantics](apps/docs/docs/queue/workers.md#delivery-and-finalization-failures).
- A job that runs past its `timeout` stops the worker and counts as an attempt; it is retried after `retryAfter` while tries remain. Before, the job failed at once and the worker continued. Set `failOnTimeout` to keep the immediate failure.
- Reject a job or worker `timeout` that is not below the connection's `retryAfter`, and cap `timeout` and database `sleep` at 2147483 seconds, the Node timer limit.
- Queue workers recover abandoned reservations. Redis workers check for abandoned reservations and renew the lock on the job they run, so a job abandoned by a stopped worker is redelivered once at least `retryAfter` has passed and a job running longer than `retryAfter` keeps its reservation. Recovering an abandoned reservation consumes an attempt on the Redis and database drivers; once a recovered job exceeds its `tries`, the worker fails it with `Queue job "<name>" has been attempted too many times.` into failed-job storage without running its handler. A reserved job whose name is not registered fails terminally into failed-job storage and the worker continues, instead of rejecting `runQueueWorker`. `redis` and `database` connections now reject `retryAfter` below `1`, and `redis` connections reject it above `2147483` (the Node timer limit), when their config is normalized. Finalization failure semantics are unchanged; when finalization fails, the worker abandons the reservation and stops renewing its Redis lock, so the job is recovered like any abandoned reservation. Async queue drivers may implement optional `abandon(job)` to stop maintaining a reservation. See [When a worker stops unexpectedly](apps/docs/docs/queue/workers.md#when-a-worker-stops-unexpectedly).
- Database queue workers on MySQL and PostgreSQL skip jobs another worker is reserving instead of waiting for them. Concurrent MySQL workers no longer loop on a job another worker already took, and two workers never hold the same reservation. The `database` queue driver requires MySQL 8.0.17 or later. See [Run several workers](apps/docs/docs/queue/drivers.md#run-several-workers).
- Sign in with Apple completes in modern browsers. On HTTPS the Apple state cookie is `SameSite=None; Secure`, so the cross-site form-post callback carries it; state validation is unchanged. See [Apple](apps/docs/docs/auth/social-login.md#apple).
- Realtime shares row-window patch preparation while preserving distinct pagination, aggregate and relation policies. Refills stay bounded, cursor windows retain their next-page boundary, and projected rows expose only selected fields after mutations. Unsafe shapes fall back to the original query.
- Media coordinates record changes and file compensation with the enclosing transaction. Rollback restores prior records and overwritten conversions; obsolete-file cleanup and queued conversion dispatch run after commit. Post-commit failures report errors while retaining committed changes. Explicitly installed Media works with package defaults without `config/media.ts`. See [Media mutation outcomes](apps/docs/docs/media.md#mutation-commitment-and-failures).
- Flux shares typed readonly presence-membership helpers across React, Vue and Svelte while retaining native subscription lifetimes. Each membership event delivers its own snapshot; framework helpers remove the first equivalent member, while core wire-event removal retains its all-match policy.
- Resolve the application environment the Laravel way. `APP_ENV` comes from `--env`, then the shell, then `.env`, and defaults to `production`. It selects which `.env` files load and sets `app.env` when `config/app.ts` omits it. Nuxt servers resolve it when they start instead of using the environment from build time, and `useHoloEnv()`, `useHoloDebug()` and `useHoloDb()` read the running app's config instead of values embedded at build time. `holo start` runs the framework with `NODE_ENV=production`. Seeding uses the same environment, and mail previews receive it through the new `environment` mail runtime binding. The config cache format moves to version 4, so caches written by 0.3.x are ignored until `config:cache` runs again. New projects write `APP_ENV=development` and `env: env('APP_ENV', 'production')`. See [Which `.env` files load](apps/docs/docs/getting-started/configuration.md#which-env-files-load).
- Default native database pools use UTC timestamp handling: MySQL defaults its timezone to `Z` and sets connection time to UTC for that default; PostgreSQL parses text timestamps without timezone as UTC unless custom type parsers are configured.

- S3 disks store files under their exact names and encode them once in request URLs, `url()` and `temporaryUrl()`, so files with spaces, non-ASCII characters or `%` are reachable. Low-level S3 `getKeys()` returns `:`-separated keys in the local-disk key format. See [S3 file names](apps/docs/docs/storage/s3.md#file-names).
- S3 requests time out after 30 seconds without a response, with 1 extra second per 128 KiB uploaded, and downloads fail after 30 seconds without data. `writeStream()` buffers one multipart part of at most 64 MiB, which limits one stream to about 620 GiB. `clear()` deletes one 1,000-key listing page at a time with at most 8 concurrent deletes. See [S3 timeouts](apps/docs/docs/storage/s3.md#timeouts).

- Clean saves fire `saving` and `saved` only, as in Laravel, and no longer write `updated_at` or fire `updating` and `updated`. An `updating` handler that reverts every change fires `saved` without an `UPDATE`. After a save, `wasChanged()` and `getChanges()` report the attributes the save wrote, not edits made in `saved` handlers. A save that creates a record reports no changes, and lifecycle handlers receive the model you saved. After `save()` the model is clean, even when a `saved` handler changed an attribute. A `saving` handler that dirties the model takes the normal update path. See [lifecycle, factories, and seeders](apps/docs/docs/getting-started/upgrading.md#lifecycle-factories-and-seeders).
- Run set mutators after each lifecycle handler on the fields that handler changed, so a later handler on the same or a later event sees normalized values. Each value is still mutated once per assignment.
- Persist attribute changes made in `creating`, `updating`, and `saving` handlers, and apply mutators once per write, including `make().save()` and factories. Models loaded with `withCount()` or `withExists()` save without writing the computed values, and in-place changes to JSON and date attributes are detected and saved. Factories and `holo seed` run seeders without mass-assignment guards, as Laravel does. See [lifecycle, factories, and seeders](apps/docs/docs/getting-started/upgrading.md#lifecycle-factories-and-seeders).
- Publish packages from CI. The Release workflow runs on pushes to `main` and publishes every package version that npm doesn't have yet, with npm provenance. The publish job runs only for `main` and uses the `release` environment, which holds the `NPM_TOKEN` secret. Without the secret, the run logs a notice and succeeds without publishing. Only the publish step receives the token.
- `bun run release` stops the running `changeset publish` and every process it started, then restores the package manifests it rewrites when a publish is interrupted with SIGINT, SIGTERM, or SIGHUP, not only when the publish fails. Processes that ignore SIGTERM get SIGKILL after five seconds, and manifests are restored only after they have all exited.
- `withoutForeignKeyConstraints()` runs its callback, and the restore, on one pooled connection, so no other pooled connection is left with foreign key checks off. The standalone `disableForeignKeyConstraints()` still changes only the connection that runs it. If the restore statement goes through the query logger and the logger throws, the checks are still restored, the call resolves, and the logger error goes to `exceptions.report` as `db` / `schema.restoreForeignKeys`.
- Work started inside a transaction or a `withoutForeignKeyConstraints()` callback that runs after that callback returns no longer reuses the pooled connection the scope released. It uses a connection from the pool instead.
- PostgreSQL `date` and `timestamp` values use `app.timezone` (default `UTC`) instead of the Node process's time zone. A `date` reads as a `Date` at midnight in `app.timezone`, `timestamp` reads and writes its wall-clock time in `app.timezone`, and a `Date` query value is sent with its offset. Full PostgreSQL date formats are parsed, including five-digit years, `BC`, and `infinity`. Injected PostgreSQL clients, pools, and `createPool` objects read dates and timestamps in `app.timezone` too, through a per-query type config. Ambiguous fall-back times resolve to standard time, as PostgreSQL does. A `DATE` or `TIMESTAMP` that falls in a DST gap resolves forward, as PostgreSQL does, so a DATE keeps its calendar day. `timestamptz` values bind with their full historical offset, seconds included. Holo's date and timestamp parsers take precedence over a custom `types` config for those two OIDs, and the config still applies to every other OID.
- A transaction started inside `withoutForeignKeyConstraints()` runs on the pinned connection one at a time, so concurrent transactions can't share one `BEGIN`. A transaction that reaches the pinned connection after its callback returned fails with `TransactionError` instead of running with foreign-key checks on.

### Compatibility and upgrade requirements

- **Pivot columns aren't loaded unless declared.** Code that reads `pivot` for a column that isn't in `withPivot()` or `withTimestamps()` gets `undefined`. Add the column to `withPivot()`. See [Pivot columns](apps/docs/docs/getting-started/upgrading.md#pivot-columns-and-one-of-many-relations).
- **Sessions don't cross between 0.3 and 0.4.** A session written by 0.4 isn't readable by 0.3, so a mixed-version rolling deploy or a rollback signs users out. See [Sessions don't cross between 0.3 and 0.4](apps/docs/docs/getting-started/upgrading.md#sessions-dont-cross-between-03-and-04).
- **Broadcast workers on Redis scaling upgrade together.** Presence entries written by a worker that predates this change have no lease, so the upgraded workers treat them as dead and remove them. Stop every old worker before starting the new ones; users still connected to an old worker drop out of presence until they reconnect. See [Upgrading](apps/docs/docs/getting-started/upgrading.md#broadcast-workers-upgrade-together).
- **Add a nullable `remember_token` column to each auth provider table** and hide it on the model. New scaffolds and the example apps include it, and the scaffolded sessions table no longer has `remember_token_hash`. `issueRememberMeToken()`, `consumeRememberMeToken()`, `RememberTokenOptions` and `SessionRecord.rememberTokenHash` are removed from `@holo-js/session`. Custom auth providers need `getRememberToken(user)` and `updateRememberToken(user, token)` for remember me. See [Per-user remember-me tokens](apps/docs/docs/getting-started/upgrading.md#per-user-remember-me-tokens).
- Broadcast clients that relied on close code `4001` after a refused subscription must handle `pusher:subscription_error`. Channel rules served by `holo broadcast:work` no longer receive a `null` user for unsigned subscriptions. See [Broadcast subscription errors](apps/docs/docs/getting-started/upgrading.md#broadcast-subscription-errors-and-channel-authorization).
- **Run `npx holo config:cache` again after upgrading** if you use the config cache. Caches from 0.3.x and earlier are ignored, and the app loads `config/*.ts` until the cache is rebuilt. The cache now holds secrets, so keep it out of version control.
- **Temporary URLs behind a TLS proxy need `trustedProxies`.** A temporary URL is signed with the `https://` origin of `APP_URL`. Behind a proxy that terminates TLS, the app sees `http`, so the link returns 404 unless `trustedProxies` lists the proxy. See [Temporary URLs behind a proxy](apps/docs/docs/getting-started/upgrading.md#temporary-urls-behind-a-proxy).
- **Set broadcast credentials before deploying.** Run `npx holo install broadcast` for apps that use broadcasting, and set `BROADCAST_APP_ID`, `BROADCAST_APP_KEY`, and `BROADCAST_APP_SECRET` for your web app and worker. Typed env values that don't convert, such as `APP_DEBUG=maybe`, now fail instead of using the fallback.
- **Set `APP_ENV=development` in local `.env` files.** A missing `APP_ENV` now means `production` instead of `development`. `HOLO_ENV` is removed, `NODE_ENV` no longer selects the environment, and values other than `development`, `production`, or `test` fail instead of counting as `development`. See the [upgrade guide](apps/docs/docs/getting-started/upgrading.md#application-environment-from-app-env).
- **Users are signed out once when they upgrade.** Session, remember-me and `XSRF-TOKEN` cookies set by 0.3.x can't be decrypted, and the first form submitted with an old CSRF cookie gets `419`. `APP_KEY` is required wherever Holo sets these cookies.
- **CSRF tokens reissue once after upgrading.** The first unsafe request from each browser gets `419` until a page load stores a token in its session. CSRF protection requires `@holo-js/session`; `holo install security` adds it. `origins: ['*']` with `credentials: true` in `config/cors.ts` now fails at startup. See [CSRF tokens stored in the session](apps/docs/docs/getting-started/upgrading.md#csrf-tokens-stored-in-the-session).
- Custom session stores must implement the optional `setDataIfAbsent` method so the CSRF token is written atomically; see [CSRF tokens stored in the session](apps/docs/docs/getting-started/upgrading.md#csrf-tokens-stored-in-the-session).
- `useForm` keeps a `_token` field already in the form. With `csrf.endpoint`, it sends only the fetched token, in the configured `csrf.header` (or `csrf.field` when the header is the encrypted-cookie-only `X-XSRF-TOKEN`). `SecurityClientConfig.csrf` gains `header`.
- CSRF token endpoints may return `{ token: string, field?: string }`. When `field` is supplied, `useForm` sends the token in that input field so a separate frontend can use custom API CSRF names without reading API cookies. Existing token-only responses keep their transport.
- **Rename S3 objects with special characters before deploying.** Objects written by 0.3.x under URL-encoded names, such as `Q1%20report.pdf`, are no longer found by their original path. See [S3 file names with special characters](apps/docs/docs/getting-started/upgrading.md#s3-file-names-with-special-characters).
- **Migrate before deploying the updated Core Auth integration.** Existing applications must add and apply the `auth_session_revocations` migration using `npx holo migrate`. New Auth scaffolds include it. This durable table is required independently of whether sessions use database, file or Redis storage; missing-table and persistence errors propagate explicitly. The documented MySQL migration requires **MySQL 8.0.17 or later** and exact binary identity comparison.
- **Existing browser users must sign in again on adoption.** Authenticated browser payloads without logical-session and generation metadata are rejected when revocation persistence is enabled, including old remember-cookie payloads. **Existing personal access tokens remain valid.** No session enumeration or store cleanup is required. See [existing application rollout](apps/docs/docs/auth/session-and-cookies.md#existing-application-rollout) for the migration and deployment instructions.
- Custom `EmailVerificationTokenStore` and `PasswordResetTokenStore` implementations must provide atomic `redeem<TResult>(record, operation): Promise<TResult | null>`. Custom `AuthTokenStore.deleteByUserId` implementations must honor optional `{ exceptId?: string }` to retain the current token during other-token revocation.
- Custom session integrations must support native `rotate` with complete payload replacement and lifetime renewal; Auth rejects unsupported stores before mutation. Standalone Auth needs a durable `sessionRevocations` adapter for other-device logout; requesting it without an adapter fails explicitly.
- With external providers or different database contexts, verification/reset claims are consumed before user mutation; a failed mutation requires a fresh token. Run these flows outside caller-owned token-storage transactions, which Core rejects with `TransactionError` before any claim or provider mutation. Proven shared native persistence retains transactional rollback behavior. See [verification](apps/docs/docs/auth/email-verification.md#single-use-redemption) and [password reset](apps/docs/docs/auth/password-reset.md#custom-token-stores).
- Cache stores that shared a Redis database, database tables or a folder with other data lose it on `cache.flush()` or `holo cache:clear`. Move the cache to its own database, tables or folder first; see [Cache flushes clear the whole store](apps/docs/docs/getting-started/upgrading.md#cache-flushes-clear-the-whole-store).
- Database `afterRollback` callbacks now run in reverse registration order and continue after callback failures; `afterCommit` callbacks retain registration order. Transaction and rollback-compensation failures are preserved together.

These changes were merged in [#96](https://github.com/cobraprojects/holo-js/pull/96).

## 0.4.0

In preparation, not yet released.

### Documentation

- Prepare the 0.3.x to 0.4.0 upgrade guide and mark Realtime and Broadcast as **Experimental** in the documentation and package READMEs. Production reliability work remains in the separate Realtime production readiness milestone; this label does not change runtime behavior.

### Security

- Raise dependency floors past published advisories: `ws` 8.21.0, `sharp` 0.35.5 and `mysql2` 3.22.0, with framework peers Next.js 16.3.8, Nuxt 4.5.1, SvelteKit 2.70.2 and Svelte 5.56.8.

### Changed

- Framework runtimes are peer dependencies. `@holo-js/adapter-nuxt` peers on `nuxt` and takes h3 and Nitro from Nuxt's `#imports` instead of depending on `h3` and `nitropack`. `@holo-js/adapter-sveltekit` peers on `svelte` (`^5.56.8`) instead of depending on an exact version. Applications share one framework runtime with Holo. See [framework peer dependencies](apps/docs/docs/getting-started/upgrading.md#framework-peer-dependencies).
- The published runtime audit accepts reviewed, time-boxed exceptions in `audit-exceptions.json` for blocking advisories that have no patched release. braces 3.0.3 (GHSA-vfj7-8cjw-p6xm) and node-forge 1.4.0 (GHSA-86w9-cpqp-85rv), reachable only through the application's Nuxt peer, are excepted until 2026-12-17.
- Require Node.js 22.14 or newer on the 22 line (`^22.14.0 || ^24.0.0 || ^26.0.0`). The SQLite driver's prebuilt binary needs Node-API 10 and crashed with a segmentation fault on Node.js 22.12 and 22.13. CI tests Node.js 22.14.0, 24 and 26.
- Nuxt auth redirects write the status and `Location` header through the request's native response, including for supplied request events outside a Nitro build. Redirect responses no longer include h3's HTML meta-refresh body.

### Fixed

- Holo CLI writes generated and updated project files, including `package.json`, through a temporary file and an atomic rename. Editors, watchers and package managers reading a file while `holo dev` or `holo install` updates it no longer see an empty or truncated file.
- Next.js realtime queries call React `use()` on every render, so a query that suspends for its first result renders without React errors on Next.js 16.4.

## 0.3.28

### Added

- `resolveRequestUrl()` and its request input types, `HoloRequestInput` and `HoloRequestHeaders`, are exported from `@holo-js/kernel`. They accept native `Request` objects and framework request-like inputs, including trusted proxy URL resolution.
- `Storage.stat(path)` and `disk(...).stat(path)` return `{ size, mimeType }`, or `null`, for local, public, and S3 disks. Custom backends may implement the optional `getItemStat(key, { sampleBytes })`.

### Security

- File types are detected from file contents wherever Holo judges a file. Text formats without recognizable contents (CSV, JSON, Markdown, SVG, HTML) use the file extension, and a binary extension whose contents do not match has no type.
- Public storage shows images, audio, video, fonts, PDFs, and plain text formats inline and sends everything else as a download, so uploads such as XML disguised as images cannot execute on the application origin.
- `image()` validation accepts only complete JPEG, PNG, GIF, WebP, AVIF, and TIFF images identified from their bytes, and rejects SVG. Server-side validation fully decodes every frame through the optional `sharp` peer of `@holo-js/kernel`, and rejects images over 40,000,000 decoded pixels or 1,000 frames.
- `HOLO_SECURITY_TRUST_PROXY` trusts exactly one proxy header family: `true`, `1`, `yes`, `on`, or `x-forwarded` trust `X-Forwarded-*`, and `forwarded` trusts `Forwarded`. The two families are never mixed, and rate-limit keys use the bare client address.
- Malformed request URLs and trusted proxy headers get `400 Bad Request` from the security middleware instead of a server error.
- Form ambient request URLs no longer come from the `Referer` header. CSRF, Auth, Forms, and Next resolve URLs through `resolveRequestUrl()`.

### Changed

- Media stores and checks `acceptsMimeTypes()` against the detected type.
- `Storage.stat()` reports the same type for the same bytes on local, public, and S3 disks. S3 disks read metadata with one ranged GET and ignore stored content types.
- `inferMimeTypeFromName()` in `@holo-js/mail` recognizes `avif`, `css`, `mp3`, `woff`, and `woff2`. Existing answers are unchanged.
- When the broadcast worker cannot be reached, `broadcast()` throws `[@holo-js/core] Broadcast publish request could not reach the broadcast worker at <origin>.` with the network error as its cause, instead of a raw `fetch failed` error.

### Fixed

- Public local-file responses honor `Range` requests with `206` and `416` responses, streamed from disk.
- Nullable array fields keep `null` during coercion.
- Regex rules test against a fresh copy of the pattern with `lastIndex` reset, so reused schemas no longer depend on earlier matches.
- Writes to `json` columns are JSON-encoded once, and non-SQLite reads return stored JSON without dialect normalization.
- The Next request context carries `url`, so the public origin resolves from `Host`.
- `queue:listen` ignores generated discovery output when watching queue sources, and waits for queued project preparation to finish before restarting a worker.

### Compatibility and upgrade requirements

- `mimeType` is removed from `addMedia({ contents, fileName })` and `addMedia({ url })`. The type is detected from the bytes, so remove the argument from calls.
- `mediaRuntimeInternals.inspectImage()` is removed from `@holo-js/media`.
- Deployments whose proxy sends only `Forwarded` must set `HOLO_SECURITY_TRUST_PROXY=forwarded`.
- Server-side `image()` validation needs `sharp` installed. Without it, validation reports an error asking for the install.
- Custom storage backends that implement `getItemStat` receive `(key, { sampleBytes })` and return the file size and leading bytes.

## 0.3.27

### Changed

- `DB.connection(name)` returns the active connection only when its name matches the requested name or no name is given. Previously, a named request inside an active connection context returned that connection.

### Compatibility and upgrade requirements

- `@holo-js/mail` now depends on `nodemailer` `^10.1.0` instead of the catalog version. Verify SMTP delivery after upgrading.

## 0.3.26

No user-visible changes.

## 0.3.25

### Security

- Built-in `logging: true` no longer prints SQL text, savepoint names, or error messages by default. SQL appears only with `security.debugSqlInLogs: true`.

### Added

- `belongsToMany`, `morphToMany`, and `morphedByMany` pivots gain `withTimestamps()`.
- Connection config accepts `max`, `connectionTimeoutMillis`, `idleTimeoutMillis`, `application_name`, `concurrency`, and `logger`. The kernel exports the new database types.
- New PostgreSQL scaffolds include pool and concurrency settings and `DB_*` environment entries. Queries beyond the queue limit fail with `QUERY_SCHEDULER_BACKPRESSURE`.

### Changed

- `count()`, `exists()`, and `doesntExist()` run in the database instead of loading rows.
- Increment and decrement compile to a single `col = col + ?` UPDATE, so concurrent counter updates are preserved.
- PostgreSQL and MySQL transactions take a query-scheduler slot, so they count against `maxConcurrentQueries`.
- Loaded pivot attributes include every pivot column.
- Native-form arrays of objects serialize as indexed names (`items[0].name`). Primitive arrays keep `tags[]`.

### Fixed

- Pool, timeout, `application_name`, `concurrency`, and `logger` settings from `config/database.ts` reach the runtime. Pool budgets apply only to PostgreSQL.
- Increment and decrement accept numeric strings from drivers.
- Session persistence upserts on `id`, removing the session creation race.
- Next helpers resolve `next/headers` and `next/navigation` from the consuming project, so locally linked framework packages use the host's request scope.
- Native-form submissions include programmatic fields that have no matching input.
- Migration recovery works when a model or seeder table lacks primary-key metadata.

### Compatibility and upgrade requirements

- Apps that relied on SQL text in logs must set `security.debugSqlInLogs: true`. A non-boolean value throws.
- Code that parses `items[]` keys for arrays of objects must read `items[0].name` instead.
- Pivot relation return types change to `InitialPivotRelation`, and `as()` and `using()` return configured types.

## 0.3.24

### Added

- `clearNotifications(query)` and `markAllNotificationsAsRead(query)` are exported from `@holo-js/notifications`.
- The Flux client delivers `notifications.message` payloads to `onNotification` listeners.

### Changed

- CLI dev, build, and start processes receive values from `.env` files loaded by `loadEnvironment`, not only from `process.env`.
- Raw SQL numbered placeholders bind by index and must start at 1. Quoted strings and comments are skipped when scanning placeholders.
- Redis Cluster queues use a `{queueName}` hash-tag key prefix. The non-cluster prefix is unchanged.
- File session locks use a new on-disk layout.

### Fixed

- `avg`, `min`, and `max` on an empty set return `null`.
- SQLite `whereYear`, `whereMonth`, and `whereDay` compare as integers.
- Broadcast worker shutdown closes sockets with code 1001 and awaits pending messages.

### Compatibility and upgrade requirements

- `@holo-js/config` adds a runtime dependency on `jiti`. `.ts`, `.mts`, and `.cts` config files load through jiti on all supported Node runtimes.
- `@holo-js/adapter-nuxt` declares `vue` as a peer dependency.

## 0.3.23

No user-visible changes beyond 0.3.22.

## 0.3.22

### Added

- `DatabaseContext.table()` is added, and `DB.table()` delegates to it.
- `createMySQLAdapter({ client })` accepts an existing `mysql2/promise` connection. The adapter owns it and closes it on disconnect.

### Changed

- Queue CLI commands load project jobs through the project runtime, and disabled job discovery is respected.
- Realtime live-query predicates follow SQL `NULL` rules, use exact string equality, and fetch from the database when a local comparison cannot match its collation.
- SQLite connections open in WAL mode, and writes serialize per database file within a process, so application and worker connections can commit while readers keep their snapshots.

### Fixed

- PostgreSQL multi-statement results return the last statement's rows, and multi-statement migration results are handled.
- MySQL JSON, text, and blob defaults compile wrapped in parentheses. Paginated locking reads compile `LIMIT` and `OFFSET` before the locking clause.
- Numeric identifiers hydrate consistently, and unsafe integers throw.
- PostgreSQL database cache entries expire correctly, and native database cache connections are released on runtime shutdown.
- Broadcast worker shutdown also shuts down the realtime runtime.
- Authorization policy checks reuse the validated request actor, avoiding repeated database session writes and realtime dependency self-deadlocks. Direct auth lookups and new requests still validate sessions.
- Session timestamps serialize per dialect, so MySQL session creation, activity updates, and rotation work.
- Next auth refreshes cancel on navigation and unmount.
- Validation schemas may be empty for CSRF-only forms, and submitted transport fields are not treated as application data.
- SvelteKit disposes Holo runtime resources when the native SvelteKit server shuts down.
- SQLite table rebuilds keep `sqlite_sequence` for auto-increment columns.
- Project job, event, and listener definitions load as one graph, so shared definitions keep their identity.

### Compatibility and upgrade requirements

- Generated Next and SvelteKit apps use a new `definition-importer.ts` file, and `job-importer.ts` is removed when the registry is regenerated (#97).

## 0.3.21

### Added

- `security.allowUnsafeRawSql` can be set per native connection in `config/database.ts`. It enables `unsafeQuery()` and `unsafeExecute()`, defaults to disabled, and must be a boolean.

### Changed

- The `MediaEnabledModel` type no longer intersects with the base model type.

### Fixed

- Pooled PostgreSQL and MySQL transactions run on separate leased connections instead of deadlocking behind the shared query queue.
- Realtime HTTP requests send the configured CSRF cookie token, so strict protection accepts browser queries and mutations.
- `import.meta.url` in project modules bundled by the CLI resolves to the source file URL.

## 0.3.20

### Security

- Unsafe requests no longer pass CSRF on a signed cookie plus a matching `Origin` or `Referer`. A submitted token in the configured header or form field is required.

### Changed

- Next, Nuxt, and SvelteKit CSRF middleware apply the configured CORS headers and answer preflight requests from allowed origins. Nuxt treats `OPTIONS` as a safe method.
- Next.js builds wrap exported HTTP method handlers in `app/**/route.ts` so validation and rate-limit errors become JSON responses.

### Fixed

- Next server-action requests carrying the CSRF form field have that token mapped to the header, so login server actions keep working.
- Rate-limit (429) errors are serialized with `Retry-After` in Next, Nuxt, and SvelteKit.
- The `forms` client reads the `method` attribute from the live form element.

### Compatibility and upgrade requirements

- Clients that send unsafe requests relying on `Origin` or `Referer` matching must send the CSRF token in the configured header or form field.

## 0.3.19

### Added

- Next.js apps get `proxy.ts` calling `csrfProtection()`, and Nuxt apps get `server/middleware/csrf.ts`, when auth or security is enabled. Existing projects with `@holo-js/security` get these files on sync if no middleware exists.
- The SvelteKit managed `hooks.server.ts` runs `csrfProtection()` when `@holo-js/security` is a dependency.

### Changed

- The Nuxt runtime plugin no longer logs `Holo DB connected` at startup. Requests wait for database initialization through the Nitro request hook and receive its error.

## 0.3.18

No user-visible changes.

## 0.3.17

### Added

- `auth.logoutOtherDevices()` revokes the other browser sessions of the signed-in user through a durable per-user generation in the new `auth_session_revocations` table. The current session is kept.
- `auth.tokens.revokeOthers({ guard? })` revokes the other personal access tokens of the current token user and keeps the current token.
- `holo media:regenerate [ModelName ...] [--ids=] [--only=] [--only-missing]` regenerates media conversions on their stored disks.
- `temporaryUrl()` works on local and public disks, not only S3-compatible disks. Local URLs are signed with the application key, expire, and are served by the framework storage route.
- `createSvelteKitHoloHooks` is exported from `@holo-js/adapter-sveltekit`, and generated SvelteKit hooks use it.
- `join`, `leftJoin`, and `rightJoin` on the table query builder accept a table definition and type the joined columns. Left and right joins mark those columns nullable.
- `config/app.ts` gains `timezone` (default `UTC`), read from `APP_TIMEZONE` in new scaffolds.
- New scaffolds include an `s3` storage disk with `STORAGE_DISKS_*` variables, and add `@holo-js/storage-s3` when storage is enabled.

### Security

- Token guards reject access tokens issued for a different provider, and the guard provider is checked before token authentication.
- Password reset redemption is single-use under concurrent requests: the token claim and the password update run in one transaction.
- Email verification tokens are claimed atomically. On the native model path the claim and the user update share a transaction, so a failed update leaves the token usable.
- Logging out of a token guard deletes the current personal access token.
- A login that fails after the session is written invalidates that session and clears the guard's session state.

### Changed

- Model `chunk`, `chunkById`, and `chunkByIdDesc` read rows in database batches instead of loading the full result first (#82).
- `afterRollback` callbacks run in reverse registration order. Multiple failures, and rollback compensation failures, are thrown as `AggregateError`.
- Native MySQL pools default `timezone` to `Z` and set the session time zone to `+00:00` unless `timezone` is configured. Native Postgres reads `timestamp without time zone` values as UTC.
- Blank storage and mail environment values are treated as unset. An empty S3 endpoint falls back to the regional AWS endpoint, and empty SMTP credentials are omitted.
- Scalar validation fields no longer take the last element of a JSON array. Only repeated form keys collapse to their last value.
- A failed `custom()` skips later transforms in the chain, and a parent array transform does not run when child checks fail. A `confirmed()` placed after `transform()` compares transformed values.
- Form submission results are discarded if a field is edited or the form is reset while the submission is in flight.
- The S3 storage backend is created on first use of its disk, not at startup.
- Public storage responses serve only `GET` and `HEAD`. The Nuxt route moved from `storage.get.ts` to `storage.ts`, and the generated SvelteKit route passes the app key.
- New media migrations add indexes on `path` and on `file_name, mime_type`.
- New SvelteKit `vite.config` allows the workspace root in `server.fs.allow`.

### Fixed

- The model `hidden` option keeps literal attribute names in its type.
- Media attachment, deletion, and regeneration compensate file changes in rollback order, and post-commit failures keep the committed-state error.
- `holo dev` restarts the framework server only after pending preparation finishes, and shutdown is terminal. Process cleanup on shutdown is fixed (#68).
- The CLI keeps media configuration when `@holo-js/media` is installed without app media config.

### Compatibility and upgrade requirements

- Apps that installed auth before 0.3.17 must add an `auth_session_revocations` table: `provider` and `user_id` as `VARCHAR(255) NOT NULL`, `generation` as `INTEGER NOT NULL DEFAULT 0`, `retained_session_id` as nullable `VARCHAR(255)`, with primary key (`provider`, `user_id`). Session-authenticated requests read this table. The scaffold ships the migration only for new projects.
- Apps that relied on the host time zone must set `APP_TIMEZONE`. The config runtime now sets `process.env.TZ` from `app.timezone`, which defaults to `UTC`.
- MySQL and Postgres apps should review date and time columns written by earlier versions, because naive values are now read and written as UTC.
- Calling password reset or email verification redemption inside a caller's database transaction throws `TransactionError` when the user model is not a native repository. Run redemption outside the transaction.
- Custom `AuthTokenStore` implementations must honor the new optional `exceptId` argument of `deleteByUserId`. Otherwise `tokens.revokeOthers()` also deletes the current token.
- Nuxt server models, the generated schema, and the model import directory resolve from the project root instead of `srcDir`. Apps that set `srcDir` must move those files.

## 0.3.16

### Added

- `useForm(...)` accepts `credentials` (`'omit' | 'same-origin' | 'include'`) and `csrf: { endpoint }` for APIs on another origin. The built-in submitter fetches the CSRF endpoint before unsafe requests and sends the returned `token` in `X-CSRF-TOKEN`.
- `@holo-js/validation` exports the `InferValidationSchemaData` type.

### Changed

- Scaffolded configuration reads environment variables: `DB_CONNECTION` and `DB_DRIVER` (database), `REDIS_CONNECTION` (Redis), `QUEUE_CONNECTION` (queue), `CACHE_DRIVER` (cache), `AUTH_GUARD` and `AUTH_PASSWORD_BROKER` (auth), and `RATE_LIMIT_DRIVER` (security). Generated `.env` and `.env.example` files include these keys.
- The scaffolded Redis queue, Redis cache, and rate-limit configs no longer set `connection: 'default'`, and the generated cache config always lists a `redis` driver.
- `holo agents:install` installs a versioned `holo-js` skill tree with a routing skill and focused guides such as `database-orm`, `forms-validation`, and `queues-events`. It replaces the single documentation-search skill, and `@holo-js/cli` now publishes a `skills` directory.
- `holo agents:install` refuses to overwrite a skill tree when any file differs from the packaged version or an extra file is present. `--force` replaces the whole tree.
- SvelteKit `useForm` with `credentials` or `csrf` options uses the default fetch submitter instead of the SvelteKit action submitter.

### Fixed

- `holo dev` and `holo start` forward SIGINT and SIGTERM to the framework child process, and return without an error when the child stops because of the signal.
- On Windows, `holo dev` and `holo start` stop the framework process tree with `taskkill /T /F`.
- Seeded runs initialize the application runtime with `initializeHolo` before seeders execute, so configured application services are booted first.
- The default forms submitter copies `retryAfterSeconds` into 429 failure results. It previously checked for `retryAfter`, which is not the contract field name.
- `@holo-js/flux` keeps the WebSocket connection promise pending while connector options are resolved, which fixes a connection race.
- Queue dependency scaffolding reads the queue config file only when no driver is passed.
- The Next.js adapter adds an ignore rule for the dynamic filesystem access warning on Holo core, kernel, and media runtime chunks.

### Compatibility and upgrade requirements

- Schema builders moved to `@holo-js/validation`. `@holo-js/forms` no longer exports `schema`, `isFormSchema`, `defineSchema`, `field`, `parse`, `createErrorBag`, `DEFAULT_VALIDATION_BAG`, `ValidationException`, `isValidationException`, `FormSchema`, or the error and field types, and the `@holo-js/forms/schema` subpath is removed. Applications must import these from `@holo-js/validation`, use `ValidationSchema` in place of `FormSchema`, and replace `schema(...)` with `defineSchema(...)`.
- The engines range narrows to `^22.12.0 || ^24.0.0 || ^26.0.0` for the root and all packages. Node 23, 25, and 27 or later fall outside the declared range, so run Node 22.12 or newer on the 22, 24, or 26 lines.

## 0.3.15

### Added

- `holo dev` accepts framework arguments (`holo dev [...frameworkArgs]`) and forwards them to the framework dev command, in the same way `holo start` does.

### Changed

- `holo dev` and `holo start` use the `PORT` environment variable as the port when no `--port` or `-p` flag is passed. A `PORT` that is not an integer from 0 to 65535 fails with an error.
- For `holo start` in Nuxt and SvelteKit projects, `--port` is passed as the `PORT` environment variable (and `NITRO_PORT` for Nuxt) instead of as a flag.

### Compatibility and upgrade requirements

- Node.js 22.12 or newer is required. The root and packages declare `>=22.12.0`, and the root previously declared `^20.19.0 || >=22.12.0`. Applications on Node 20 must upgrade Node before upgrading Holo.

## 0.3.14

### Changed

- Compile supported static `@holo-js/validation` schemas used by browser code into individual Valibot calls through the Next, Nuxt, and SvelteKit build integrations. Dynamic schemas and server-side validation keep the runtime path.

## 0.3.13

Prepared, not yet published.

- Separate shared browser HTTP error helpers into `@holo-js/adapter-shared/client` and compiler transformations into `@holo-js/adapter-shared/build`. Keep all existing root exports.
- Update Next, Nuxt, and SvelteKit forms and realtime clients to use browser-safe imports, excluding the TypeScript compiler from production browser bundles.
- Import SvelteKit validation helpers through the existing `@holo-js/forms/schema` entry to avoid loading server-side security dependencies.
- Add production Next browser tests against npm tarballs, plus bundle checks for all adapter forms and realtime entries. Cover form validation, submission, native redirects, HTTP errors, root export compatibility, and compiler transformations.
- Compile supported static browser schemas into individual Valibot calls through the existing Next, Nuxt and SvelteKit build integrations. Preserve application APIs, server validation and runtime handling for dynamic schemas. Verify packaged behavior and production blur validation in all three example apps. See [scope and additional measurements](reports/compiled-browser-validation.md).
- Advance the fixed release group of 46 packages to 0.3.13, including catalog ranges, the generated CLI catalog, and the lockfile. Applications keep their existing imports and form code.

See [measurements and release verification](reports/browser-bundle-0.3.13.md).
