# Changelog

## Unreleased

- Make `@holo-js/validation` the only public schema-builder package. Remove schema builders from `@holo-js/forms` and remove the `@holo-js/forms/schema` entry.
- Accept `@holo-js/validation` schemas directly in Forms submission helpers and framework form adapters.
- Keep compiled browser validation on the Validation entry and reject the removed Forms schema entry in packaged-export checks.

### Added

- Add `exceptions.report` and `exceptions.dontReport` to `config/app.ts`, and `report(error)` from `@holo-js/core`. Errors that Queue hooks, Auth cleanup, Cache flexible refresh and driver disposal, query-cache invalidation listeners, the Broadcast worker and Realtime subscription callbacks previously logged to the console are reported with their capability and operation. A throwing or rejecting reporter never breaks the originating request or job. Without a reporter, errors go to `console.error`. `config:cache` keeps an `app` config with a reporter live, so it is loaded from `config/app.ts` at runtime. See [Reporting errors](apps/docs/docs/basics/errors.md#reporting-errors).
- Add explicit other-device browser logout through `auth.logoutOtherDevices()` and session-guard `logoutOtherDevices()`, backed by durable provider/user revocation state. Retain the current logical browser session and reject the selected identity on other browsers' next authenticated request, including remember-cookie restoration. Unrelated identities and personal access tokens remain valid. Applications own recent reauthentication policy; Clerk and WorkOS logout affects Holo sessions, not upstream provider sessions.
- Add `tokens.revokeOthers({ guard })` to revoke a user's other personal access tokens while retaining the verified token used for the current request. Browser-session revocation remains separate.
- Allow session rotation to receive a complete replacement `data` payload and `renewLifetime`. Auth transitions renew lifetime while preserving private flash state and remember policy; ordinary rotation retains its defaults.

### Security

- Isolate Realtime query results and refresh state per server subscription. Every subscription runs authorization independently; identical query names and arguments no longer reuse another caller’s result. Browser client store sharing is unchanged.

- Group model caller conditions, each global scope, and soft-delete filters independently. Prevent `orWhere()` from leaking foreign or deleted rows through reads, eager loads, and `whereHas()`, and keep instance updates and deletes restricted to their target row.

- Make email-verification and password-reset token redemption single-use under concurrent requests. Coordinate the claim and user mutation transactionally when Core proves they share the same database context. Password reset also revokes sibling tokens for the same provider, email and broker table before user mutation.
- Fail closed after authenticated-session transition failures: invalidate the new session, clear affected request identities, keep the previous session identifier invalidated, and report cleanup failures alongside the original error. Ordinary login and rotation preserve other devices' authentication.
- Make token-guard `logout()` revoke its verified current token before clearing request identity. A deletion failure rejects logout and preserves that request identity; other tokens and browser sessions remain valid.

### Changed

- Require CI typechecks, lint, package/scaffold/browser acceptance and full tests on Node 22.14.0, 24 and 26. Monitor npm and Actions updates, block high/critical published-runtime dependency advisories, and reject new Fallow dead-code findings against a pinned baseline. Concurrent test typechecks retain their own generated configurations.

- Core capability disposal and startup rollback continue cleanup after individual failures, close only Holo-owned resources, and restore prior live bindings. Multiple failures are reported together. Queue asynchronous shutdown closes all owned drivers and resets state even if closure fails.
- Queue separates handler outcomes from reservation finalization. Acknowledgement, release, failed-job persistence or reservation deletion errors stop `runQueueWorker` with the original adapter error instead of entering handler retry logic. Terminal failures are persisted before reservation deletion; delivery may repeat according to driver reservation semantics. See [worker failure semantics](apps/docs/docs/queue/workers.md#delivery-and-finalization-failures).
- Realtime shares row-window patch preparation while preserving distinct pagination, aggregate and relation policies. Refills stay bounded, cursor windows retain their next-page boundary, and projected rows expose only selected fields after mutations. Unsafe shapes fall back to the original query.
- Media coordinates record changes and file compensation with the enclosing transaction. Rollback restores prior records and overwritten conversions; obsolete-file cleanup and queued conversion dispatch run after commit. Post-commit failures report errors while retaining committed changes. Explicitly installed Media works with package defaults without `config/media.ts`. See [Media mutation outcomes](apps/docs/docs/media.md#mutation-commitment-and-failures).
- Flux shares typed readonly presence-membership helpers across React, Vue and Svelte while retaining native subscription lifetimes. Each membership event delivers its own snapshot; framework helpers remove the first equivalent member, while core wire-event removal retains its all-match policy.
- Default native database pools use UTC timestamp handling: MySQL defaults its timezone to `Z` and sets connection time to UTC for that default; PostgreSQL parses text timestamps without timezone as UTC unless custom type parsers are configured.

### Compatibility and upgrade requirements

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
