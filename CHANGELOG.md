# Changelog

## Unreleased

- Make `@holo-js/validation` the only public schema-builder package. Remove schema builders from `@holo-js/forms` and remove the `@holo-js/forms/schema` entry.
- Accept `@holo-js/validation` schemas directly in Forms submission helpers and framework form adapters.
- Keep compiled browser validation on the Validation entry and reject the removed Forms schema entry in packaged-export checks.

### Added

- Add optional `AuthRuntimeContext.getRequestScope()` for request-isolated remember-me state and concurrent guard restoration. Remember-cookie writes require a scope; unscoped custom contexts retain uncached sequential restoration.

- Add `exceptions.report` and `exceptions.dontReport` to `config/app.ts`, and `report(error)` from `@holo-js/core`. Errors that Queue hooks, Auth cleanup, Cache flexible refresh and driver disposal, query-cache invalidation listeners, the Broadcast worker and Realtime subscription callbacks previously logged to the console are reported with their capability and operation. A throwing or rejecting reporter never breaks the originating request or job. Without a reporter, errors go to `console.error`. `config:cache` keeps an `app` config with a reporter live, so it is loaded from `config/app.ts` at runtime. See [Reporting errors](apps/docs/docs/basics/errors.md#reporting-errors).
- Add explicit other-device browser logout through `auth.logoutOtherDevices()` and session-guard `logoutOtherDevices()`, backed by durable provider/user revocation state. Retain the current logical browser session and reject the selected identity on other browsers' next authenticated request, including remember-cookie restoration. Unrelated identities and personal access tokens remain valid. Applications own recent reauthentication policy; Clerk and WorkOS logout affects Holo sessions, not upstream provider sessions.
- Add `tokens.revokeOthers({ guard })` to revoke a user's other personal access tokens while retaining the verified token used for the current request. Browser-session revocation remains separate.
- Allow session rotation to receive a complete replacement `data` payload and `renewLifetime`. Auth transitions renew lifetime while preserving private flash state and remember policy; ordinary rotation retains its defaults.

### Security

- Enforce the configured remember lifetime on the server using an authenticated expiry in each encrypted recaller. Replayed expired remember cookies cannot restore authentication.

- Read forwarded headers as Laravel's TrustProxies does. Honor only `X-Forwarded-For`, `-Host`, `-Port`, `-Proto`, and `-Prefix` from trusted proxies, taking the first value of each list except `X-Forwarded-For`, and ignore `Forwarded`. Trust headers from an unknown connection address only with `trustedProxies: '*'`, so Next.js apps with a proxy list ignore them. Skip `X-Forwarded-For` entries that aren't IP addresses, treat unknown `X-Forwarded-Proto` values as HTTP, and add `X-Forwarded-Prefix` to the path of `resolveRequestUrl()`. Nuxt requests over a Unix socket, as behind `nuxt dev`, come from `127.0.0.1`. Nuxt CSRF, broadcast-auth and realtime requests no longer take `X-Forwarded-Proto` from h3 for untrusted peers. WorkOS sign-in sends the trusted client IP instead of the raw first `X-Forwarded-For` entry or `X-Real-IP`. Rate-limit keys keep the full client IP. See [Trusted proxies](apps/docs/docs/basics/security/cors-and-proxies.md#trusted-proxies).
- Leave passwords and `sensitive()` fields out of every serialized validation failure, including inside nested objects and arrays: `ValidationException` `values` and `toJSON()` from Validation and Forms `validate()`, Forms `fail()` and `serialize()`, and the 422 responses from Next.js, Nuxt and SvelteKit. `useForm()` clears the same fields after a failed submission, including items of sensitive arrays. The Nuxt form-failure cookie no longer carries submitted values and is `Secure` on HTTPS requests. See [Sensitive data](apps/docs/docs/basics/validation/rules.md#sensitive).
- Isolate Realtime query results and refresh state per server subscription. Every subscription runs authorization independently; identical query names and arguments no longer reuse another caller’s result. Browser client store sharing is unchanged.

- Group model caller conditions, each global scope, and soft-delete filters independently. Prevent `orWhere()` from leaking foreign or deleted rows through reads, eager loads, and `whereHas()`, and keep instance updates and deletes restricted to their target row.

- Make email-verification and password-reset token redemption single-use under concurrent requests. Coordinate the claim and user mutation transactionally when Core proves they share the same database context. Password reset also revokes sibling tokens for the same provider, email and broker table before user mutation.
- Fail closed after authenticated-session transition failures: invalidate the new session, clear affected request identities, keep the previous session identifier invalidated, and report cleanup failures alongside the original error. Ordinary login and rotation preserve other devices' authentication.
- Make token-guard `logout()` revoke its verified current token before clearing request identity. A deletion failure rejects logout and preserves that request identity; other tokens and browser sessions remain valid.
- Remember me uses one `remember_token` per user, as in Laravel. The encrypted remember-me cookie carries the user ID, the token and a hash of the password hash, compared in constant time, and restores the user after the session expires for up to `rememberMeLifetime`. `logout()` cycles the token so remember-me cookies on every device stop working while other active sessions remain; `logoutOtherDevices()` cycles it too and resends the current browser's cookie. With multi-factor auth the cookie is set only after the challenge passes. Session records no longer carry remember credentials. See [Per-user remember-me tokens](apps/docs/docs/getting-started/upgrading.md#per-user-remember-me-tokens).
- Encrypt the cookies Holo sets (session, remember-me and `XSRF-TOKEN`) with AES-256-GCM keyed from `APP_KEY`, bound to each cookie name. Changed, swapped, plaintext or foreign-key cookies are treated as absent. CSRF tokens are random values protected by the encrypted cookie instead of an HMAC signature; the `_token` field and `X-CSRF-TOKEN` header accept the plain token or the cookie value. Application cookies are not encrypted. See [Encrypted session, remember-me, and CSRF cookies](apps/docs/docs/getting-started/upgrading.md#encrypted-session-remember-me-and-csrf-cookies).

### Changed

- Require CI typechecks, lint and the full library suite on Node 24, plus native package loading and server lifecycle checks on Linux, Windows and macOS with Node 22.14.0, 24 and 26. Example-app, published-package, scaffold and browser-bundle acceptance run locally with `bun run test`. Monitor npm and Actions updates, block high/critical published-runtime dependency advisories, and reject new Fallow dead-code findings against a pinned baseline. Concurrent test typechecks retain their own generated configurations.

- Core capability disposal and startup rollback continue cleanup after individual failures, close only Holo-owned resources, and restore prior live bindings. Multiple failures are reported together. Queue asynchronous shutdown closes all owned drivers and resets state even if closure fails.
- Queue separates handler outcomes from reservation finalization. Acknowledgement, release, failed-job persistence or reservation deletion errors stop `runQueueWorker` with the original adapter error instead of entering handler retry logic. Terminal failures are persisted before reservation deletion; delivery may repeat according to driver reservation semantics. See [worker failure semantics](apps/docs/docs/queue/workers.md#delivery-and-finalization-failures).
- Queue workers recover abandoned reservations. Redis workers check for abandoned reservations and renew the lock on the job they run, so a job abandoned by a stopped worker is redelivered once at least `retryAfter` has passed and a job running longer than `retryAfter` keeps its reservation. Recovering an abandoned reservation consumes an attempt on the Redis and database drivers; once a recovered job exceeds its `tries`, the worker fails it with `Queue job "<name>" has been attempted too many times.` into failed-job storage without running its handler. A reserved job whose name is not registered fails terminally into failed-job storage and the worker continues, instead of rejecting `runQueueWorker`. `redis` and `database` connections now reject `retryAfter` below `1`, and `redis` connections reject it above `2147483` (the Node timer limit), when their config is normalized. Finalization failure semantics are unchanged; when finalization fails, the worker abandons the reservation and stops renewing its Redis lock, so the job is recovered like any abandoned reservation. Async queue drivers may implement optional `abandon(job)` to stop maintaining a reservation. See [When a worker stops unexpectedly](apps/docs/docs/queue/workers.md#when-a-worker-stops-unexpectedly).
- Database queue workers on MySQL and PostgreSQL skip jobs another worker is reserving instead of waiting for them. Concurrent MySQL workers no longer loop on a job another worker already took, and two workers never hold the same reservation. The `database` queue driver requires MySQL 8.0.17 or later. See [Run several workers](apps/docs/docs/queue/drivers.md#run-several-workers).
- Realtime shares row-window patch preparation while preserving distinct pagination, aggregate and relation policies. Refills stay bounded, cursor windows retain their next-page boundary, and projected rows expose only selected fields after mutations. Unsafe shapes fall back to the original query.
- Media coordinates record changes and file compensation with the enclosing transaction. Rollback restores prior records and overwritten conversions; obsolete-file cleanup and queued conversion dispatch run after commit. Post-commit failures report errors while retaining committed changes. Explicitly installed Media works with package defaults without `config/media.ts`. See [Media mutation outcomes](apps/docs/docs/media.md#mutation-commitment-and-failures).
- Flux shares typed readonly presence-membership helpers across React, Vue and Svelte while retaining native subscription lifetimes. Each membership event delivers its own snapshot; framework helpers remove the first equivalent member, while core wire-event removal retains its all-match policy.
- Default native database pools use UTC timestamp handling: MySQL defaults its timezone to `Z` and sets connection time to UTC for that default; PostgreSQL parses text timestamps without timezone as UTC unless custom type parsers are configured.

- S3 disks store files under their exact names and encode them once in request URLs, `url()` and `temporaryUrl()`, so files with spaces, non-ASCII characters or `%` are reachable. Low-level S3 `getKeys()` returns `:`-separated keys with URL-encoded names, like local disks. Local `path()` returns the stored file's URL-encoded name. See [S3 file names](apps/docs/docs/storage/s3.md#file-names).
- S3 requests time out after 30 seconds without a response, with 1 extra second per 128 KiB uploaded, and downloads fail after 30 seconds without data. `writeStream()` buffers one multipart part of at most 64 MiB, which limits one stream to about 620 GiB. `clear()` deletes one 1,000-key listing page at a time with at most 8 concurrent deletes. See [S3 timeouts](apps/docs/docs/storage/s3.md#timeouts).

### Compatibility and upgrade requirements

- **Add a nullable `remember_token` column to each auth provider table** and hide it on the model. New scaffolds and the example apps include it, and the scaffolded sessions table no longer has `remember_token_hash`. `issueRememberMeToken()`, `consumeRememberMeToken()`, `RememberTokenOptions` and `SessionRecord.rememberTokenHash` are removed from `@holo-js/session`. Custom auth providers need `getRememberToken(user)` and `updateRememberToken(user, token)` for remember me. See [Per-user remember-me tokens](apps/docs/docs/getting-started/upgrading.md#per-user-remember-me-tokens).
- **Users are signed out once when they upgrade.** Session, remember-me and `XSRF-TOKEN` cookies set by 0.3.x can't be decrypted, and the first form submitted with an old CSRF cookie gets `419`. `APP_KEY` is required wherever Holo sets these cookies.
- **Rename S3 objects with special characters before deploying.** Objects written by 0.3.x under URL-encoded names, such as `Q1%20report.pdf`, are no longer found by their original path. See [S3 file names with special characters](apps/docs/docs/getting-started/upgrading.md#s3-file-names-with-special-characters).
- **Migrate before deploying the updated Core Auth integration.** Existing applications must add and apply the `auth_session_revocations` migration using `npx holo migrate`. New Auth scaffolds include it. This durable table is required independently of whether sessions use database, file or Redis storage; missing-table and persistence errors propagate explicitly. The documented MySQL migration requires **MySQL 8.0.17 or later** and exact binary identity comparison.
- **Existing browser users must sign in again on adoption.** Authenticated browser payloads without logical-session and generation metadata are rejected when revocation persistence is enabled, including old remember-cookie payloads. **Existing personal access tokens remain valid.** No session enumeration or store cleanup is required. See [existing application rollout](apps/docs/docs/auth/session-and-cookies.md#existing-application-rollout) for the migration and deployment instructions.
- Custom `EmailVerificationTokenStore` and `PasswordResetTokenStore` implementations must provide atomic `redeem<TResult>(record, operation): Promise<TResult | null>`. Custom `AuthTokenStore.deleteByUserId` implementations must honor optional `{ exceptId?: string }` to retain the current token during other-token revocation.
- Custom session integrations must support native `rotate` with complete payload replacement and lifetime renewal; Auth rejects unsupported stores before mutation. Standalone Auth needs a durable `sessionRevocations` adapter for other-device logout; requesting it without an adapter fails explicitly.
- With external providers or different database contexts, verification/reset claims are consumed before user mutation; a failed mutation requires a fresh token. Run these flows outside caller-owned token-storage transactions, which Core rejects with `TransactionError` before any claim or provider mutation. Proven shared native persistence retains transactional rollback behavior. See [verification](apps/docs/docs/auth/email-verification.md#single-use-redemption) and [password reset](apps/docs/docs/auth/password-reset.md#custom-token-stores).
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

## 0.3.13

Prepared, not yet published.

- Separate shared browser HTTP error helpers into `@holo-js/adapter-shared/client` and compiler transformations into `@holo-js/adapter-shared/build`. Keep all existing root exports.
- Update Next, Nuxt, and SvelteKit forms and realtime clients to use browser-safe imports, excluding the TypeScript compiler from production browser bundles.
- Import SvelteKit validation helpers through the existing `@holo-js/forms/schema` entry to avoid loading server-side security dependencies.
- Add production Next browser tests against npm tarballs, plus bundle checks for all adapter forms and realtime entries. Cover form validation, submission, native redirects, HTTP errors, root export compatibility, and compiler transformations.
- Compile supported static browser schemas into individual Valibot calls through the existing Next, Nuxt and SvelteKit build integrations. Preserve application APIs, server validation and runtime handling for dynamic schemas. Verify packaged behavior and production blur validation in all three example apps. See [scope and additional measurements](reports/compiled-browser-validation.md).
- Advance the fixed release group of 46 packages to 0.3.13, including catalog ranges, the generated CLI catalog, and the lockfile. Applications keep their existing imports and form code.

See [measurements and release verification](reports/browser-bundle-0.3.13.md).
