# Low-priority production findings: dispositions (#137)

Audit date: 2026-10-20. Baseline: `f8780e26` (`origin/main`). The ticket records `761c8d31` as its baseline. Every disposition and line number here refers to `f8780e26`; the two baselines differ in some cited files (notably `packages/db/src/model/ModelRepository.ts`, changed by 182 lines), so line numbers from the ticket's baseline will not match. This report records a disposition for each of the 37 inventory entries in #137. No application code changed. Every reproduction was a throwaway probe, run against the baseline and deleted afterward. Where a probe asserted the defect, it passed because the defect is present; a passing probe is not a fix.

Governing rules: [ADR-0016](../docs/adr/0016-laravel-behavioral-parity.md) (follow Laravel unless Node cannot be equally safe; hardening Laravel does not apply is rejected), [ADR-0002](../docs/adr/0002-query-traversal-fallback-semantics.md), [ADR-0015](../docs/adr/0015-concurrent-device-authentication.md).

## Summary

| Disposition | Count | Items |
| --- | --- | --- |
| reproduced | 14 | 2, 5, 7, 13, 15, 16, 18, 20, 21, 23, 28, 30, 31, 37 |
| insufficient-information | 12 | 1, 3, 11, 22, 24, 25, 26, 29, 32, 33, 34, 35 |
| already-fixed | 6 | 4, 6, 8, 9, 12, 19 |
| rejected-by-decision | 5 | 10, 14, 17, 27, 36 |

These are the four dispositions the ticket permits; "not-reproduced" is not one of them. The Resolution table gives each item's 2026-10-20 outcome and issue. Each row below records the audit reasoning and, where one was made, the same outcome.

Decisions were resolved on 2026-10-20 by the orchestrator (see Resolution). Implementation issues are filed as #212–#225 and linked as sub-issues of #98. Every item now has an outcome: 32 and 33 are wontfix, 1 is #224, and 22 is carried by #222.

## Dispositions

### Auth / Session

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 1 | scrypt cost N=2^14 | insufficient-information | `packages/auth/src/runtime/scryptPasswordHasher.ts:5-7,19` uses N=16384, r=8, p=1 and is pinned by `packages/auth/tests/package.test.ts`. Laravel core has no scrypt hasher, and its bcrypt default (12 rounds) does not establish that N=2^14 is adequate, so ADR-0016 does not settle the strength question. **Decision (2026-10-20):** raise to N=2^15, r=8, p=3, which the OWASP Password Storage Cheat Sheet lists as equivalent in strength, at about 32 MiB per operation. Rejected alternative: N=2^17, r=8, p=1, which needs about 128 MiB per operation and can exhaust memory across the libuv pool. Existing N=16384 digests upgrade through `needsRehash` on their next login. Pass `maxmem` explicitly with headroom (for example 64 MiB), because Node's default is 32 MiB and a lower limit makes `hash` throw `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` while `verify` returns false. Add an internal bound of at most 4 scrypt operations per process, with no public option, and a test with 16 concurrent hashes. Record the setting and the bound in ADR-0016 as hardening. Filed as #224. |
| 2 | Secure cookie defaults; state-cookie Secure follows protocol | reproduced (state-cookie half) | `packages/auth-workos/src/index.ts:501-516` sets `secure` from the request scheme, which overrides `cookie.secure` config (`packages/session/src/runtime.ts:151`). A configured `secure: true` app served over http gets a non-Secure state cookie. The session default (`packages/session/src/config.ts:99`, `secure: false`) matches Laravel's `SESSION_SECURE_COOKIE` default and is not a defect. **Proposed ticket:** auth-workos — state cookie Secure = configured session cookie secure OR an https request, where "https request" is decided by the shared trusted-proxy-aware resolver `resolveRequestUrl` (`packages/kernel/src/requestUrl.ts:173`), not the raw `request.url` protocol. Not app-facing. Config-only Secure would drop the flag on default https sites and must not be used. |
| 3 | Redis session keys in one hash slot | insufficient-information | `packages/session/src/drivers/redis-adapter.ts:327-329` uses a constant `{holo-session}` hash tag so the two-key ROTATE script stays atomic under Cluster (`:52-67`). Every session key shares one slot and node. Not recorded in ADR-0016. Laravel uses one key per session with no hash tag and non-atomic rotation. **Decision (2026-10-20):** per-session keys with no hash tag, Laravel parity; rotation becomes copy-then-delete. ADR-0012 and the upgrade impact are in #213. |
| 4 | File sessions have no GC | already-fixed | `packages/session/src/drivers/file.ts:473-531` (bounded expired-session sweeper, wired at `:535` and `:629`), lottery `packages/session/src/runtime.ts:313-325` (2/100, as Laravel's `session.lottery`). `packages/session/tests/session-gc.test.ts` passes 7/7. |
| 5 | WorkOS session identifier falls back to the token | reproduced | `packages/auth-workos/src/index.ts:949-953` falls back to the access token, then the authorization code. The access token is stored as `workos.sessionId` and sent as the upstream logout `session_id` (`:547-551`, `:1140`). An opaque access token (no `sid` claim) therefore lands in the session payload and in a redirect URL. The authorization-code fallback is pinned by `packages/auth-workos/tests/package.test.ts:1186-1200`. **Decision (2026-10-20):** remove both the access-token and authorization-code fallbacks. Fail closed: reject authentication when WorkOS returns no session id (no session object id, no `sid` claim, no `session_id`); the `WorkosVerifiedSession.sessionId: string` contract is unchanged. The pinned test at `packages/auth-workos/tests/package.test.ts:1186-1200` changes. Filed as #212. Reachability is low because WorkOS access tokens normally carry `sid`. |
| 6 | WorkOS trusts forwarded client addresses | already-fixed | WorkOS calls the shared resolver (`packages/auth-workos/src/index.ts:922` → `packages/kernel/src/requestUrl.ts:181-183`, forwarded headers only when configured). Fixed by #118 / PR #158. `packages/auth-workos/tests/package.test.ts:1055-1075` ("never a spoofed forwarded address") passes. |
| 7 | Holo session outlives Clerk/WorkOS revocation | reproduced | `packages/auth-workos/src/index.ts:857-868` and `:1026-1040` re-verify upstream only on hosted `authenticate()`; the guard resolves from the Holo record. Clerk has the same shape (`packages/auth-clerk/src/index.ts:885-931`). ADR-0015 scopes these sessions to Holo and treats upstream sessions as separate, and Laravel's session guard never consults upstream state. A per-request upstream check would be a new recorded departure. **Decision (2026-10-20):** rejected. No per-request upstream revocation check; it is not Laravel parity. |

### Security

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 8 | CSRF header comparison not constant-time | already-fixed | `packages/security/src/csrf.ts:74-81` uses `timingSafeEqual` after a length check, which leaks only the fixed token length. |
| 9 | Browser client hardcodes X-CSRF-TOKEN | already-fixed | Superseded by #120 / PR #164. `packages/security/src/client-config.ts:109-113` sends the encrypted `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`; the custom header is configurable through `csrf.header`. `packages/security` client suite passes 6/6. |
| 10 | Broadcast auth CSRF exemption fixed, not configurable | rejected-by-decision | `packages/security/src/csrf.ts:48-51,259` exempts `/broadcasting/auth` unless `csrf: true`, and the docs say so (`apps/docs/docs/basics/security/csrf.md:139`). Laravel also exempts the broadcast auth route from `VerifyCsrfToken` and does not make that configurable. A throwaway probe confirmed the exemption and the `csrf: true` override (deleted). |
| 11 | CSRF disabled by default in configuration | insufficient-information | `packages/security/src/config.ts:185,426` defaults `csrf.enabled` to `false`; the scaffold sets `true` (`packages/cli/src/project/scaffold/config-renderers.ts:326`). Laravel's `web` group always validates CSRF. The default is not in ADR-0016. **Decision (2026-10-20):** enabled by default, Laravel parity, with an upgrade note. Apps that register `csrfProtection()` without a `csrf` block start receiving 419 on unsafe requests unless they send a token. Filed as #219. |
| 25 | Connections without Origin are allowed | insufficient-information | `packages/broadcast/src/worker.ts:217-227` allows an absent Origin, on both upgrade paths (`:2230`, `:2412`). Cross-site WebSocket hijacking needs a browser, and browsers always send Origin on the upgrade, so an Origin-less connection cannot carry ambient cookies. Private channels still require credentials via the auth endpoint (`:924`). The behavior is real (a throwaway probe passed and was deleted). **Decision (2026-10-20):** rejected. Origin is not required; allowed-origins stays optional (Reverb parity). |
| 26 | Publish authentication has a replay window | insufficient-information | `packages/broadcast/src/worker.ts:349` allows 300 s of skew and `:1905` signs method, path, sorted params and a body MD5. An identical signed publish is accepted twice within the window (probe passed, deleted). The window is inherent to the Pusher-style protocol (Pusher allows 600 s, no nonce) and Holo's is tighter. A nonce cache would be Holo-only hardening. **Decision (2026-10-20):** rejected. The 300 s window is Pusher parity. |

### Database / ORM

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 12 | MySQL DDL default/index identifier escaping | already-fixed | Identifiers pass `assertValidIdentifierSegment` before quoting (`packages/db/src/schema/SQLSchemaCompiler.ts:236-240,287-296`; index names via `generatedNames.ts`). Defaults with quote, backslash, newline, NUL and JSON round-tripped exactly on live MySQL (`packages/db/src/core/mysqlStringLiteral.ts:1-12` switches to a hex literal). Probe deleted. |
| 13 | MySQL URL handling drops ssl | reproduced | `packages/db-mysql/src/index.ts:378-379` (URL branch passes only `{ uri }`) versus `:380-387` (structured branch passes `ssl`). Live MySQL: structured `ssl` gives a TLS cipher, the URL path gives plaintext. Laravel's URL parser merges query and primary config, so configured options survive. **Proposed ticket:** db-mysql — pass `ssl` into the URI branch. Not app-facing. The other dropped pool options (`max`, timeouts, `application_name`) are a separate decision. |
| 14 | chunk/cursor fallback loads the full result | rejected-by-decision | ADR-0002: joined, grouped, distinct and union shapes keep full-result fallback. |
| 15 | Bulk insert is not chunked | reproduced | `packages/db/src/query/TableQueryBuilder.ts:2134-2160` builds one statement for all rows. Pivot inserts are batched (`packages/db/src/model/PivotMutation.ts:108`, budget 900). Probes: SQLite 3,300 × 10 (33,000 binds) fails with zero rows written; MySQL 7,000 × 10 fails the same way. Laravel's `insert` is also one call with no chunking. **Decision (2026-10-20):** rejected. No bulk-insert splitting, as Laravel does not split either. |
| 16 | Pivot `sync([1,1])` may duplicate associations | reproduced | `packages/db/src/model/PivotMutation.ts:133-141` keeps duplicate ids and `:43-69` snapshots `current`, so each duplicate becomes an insert. Without a unique key it writes two rows; with the usual unique key it throws and rolls back. Laravel's `formatRecordsList` keys by id, so duplicates collapse. `attach` is deliberately different and matches Laravel's `formatAttachRecords` (`packages/db/tests/pivot-mutations-integration.test.ts:153-169`). **Proposed ticket:** packages/db — dedupe ids in `sync` only (last attributes win). Not app-facing. |
| 17 | Observers instantiated again for each dispatch | rejected-by-decision (ADR-0016 parity: the construction is real, but Laravel also builds a fresh observer per dispatch and no state differs; closed wontfix as performance-only) | `packages/db/src/model/ModelEventDispatcher.ts` `resolveHandlers` constructs a class observer per dispatch. Probe: one `create()` built each observer four times. Per-event state does not survive in Laravel either (fresh instance per dispatch), so there is no observable state difference. |
| 18 | Query `update()` skips `updated_at` | reproduced (model builder) | `packages/db/src/model/ModelQueryBuilder.ts:1381-1383` does not apply timestamps; the save path does (`packages/db/src/model/ModelRepository.ts:1774`). Probe: `Note.query().where(...).update()` leaves `updated_at` unchanged. Laravel's `Eloquent\Builder::update` adds `updated_at` when the model uses timestamps. The table builder (`packages/db/src/query/TableQueryBuilder.ts:2249-2252`) matches Laravel's base builder and is correct. **Proposed ticket:** packages/db — on timestamped models, `ModelQueryBuilder.update`, `updateJson`, `increment` and `decrement` set `updated_at` when the caller omits it, and `upsert` sets `created_at` and `updated_at`, matching Laravel's Eloquent builder. **Decision (2026-10-20):** implement with an upgrade note, since existing query updates, increments and upserts now change timestamps. Filed as #214. |
| 19 | forceFill behaves like fill | already-fixed | `packages/db/src/model/Entity.ts:170-174` (`fill` asserts mass assignable) and `:181-184` (`forceFill` assigns directly). Commit `055cb658` (#153). `packages/db/tests/model-mass-assignment.test.ts` passes 8/8. |

### Storage / Mail

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 20 | Remote-fetch address classification gap (security-sensitive; details in private advisory GHSA-h2jh-r2v8-m68q) | reproduced | `packages/media/src/model/adder.ts` address classification leaves a gap that the public report does not describe. Laravel core has no remote-media fetch, so this guard is Holo-only; the fix does not change the API. **Proposed ticket:** media — harden remote-fetch address classification; fix tracked in #215. Not app-facing. **Decision (2026-10-20):** keep the guard and record it in ADR-0016 as hardening, since Laravel core has no remote-media fetch. Filed as #215. |
| 21 | S3 PUT omits Content-Type | reproduced | `packages/storage-s3/src/index.ts:220-292` signs no content type; `setItem`/`setItemRaw` (`:699-705`) and multipart create (`:720-745`) send none. A real local HTTP endpoint received a PUT with no content-type header (deleted probe). Flysystem's S3 adapter sets a MIME type when none is given. **Proposed ticket:** storage-s3 — set `Content-Type` from `inspectFileContent`/MIME inference before signing, on PUT and multipart create. Changes stored metadata for new objects. **Decision (2026-10-20):** store `Content-Type`, Flysystem parity. Filed as #216. |
| 22 | Temporary URLs behind a TLS proxy | insufficient-information | The signature covers the origin from configured `appUrl` (`packages/storage/src/temporaryLocalStorage.ts:22-80`). A signed `https://` URL serves 200 when the request is https and 404 when it reaches the app as http. The probe shows only this scheme-mismatch rejection. Behind a configured trusted TLS proxy, the correct result is not reproduced: `createPublicStorageResponse` (`packages/storage/src/publicStorage.ts:203-215`) takes the scheme from the raw `request.url` and does not use the shared trusted-proxy resolver, while Laravel's TrustProxies accepts a trusted forwarded scheme. **Decision (2026-10-20):** folded into #222 as an acceptance criterion. Temporary URLs behind a trusted TLS proxy must use https, and the reproduction runs through the adapter with proxy trust configured. **Separate observation (follow-up, needs a ticket):** the Nuxt storage route (`packages/adapter-nuxt/src/runtime/server/routes/storage.ts`) builds its request URL with h3's default `toWebRequest`, which honors `X-Forwarded-Proto`. The realtime and broadcast-auth routes (`realtime-request.ts:12`, `broadcast-auth.post.ts:42`) pass `xForwardedProto: false`. The storage route therefore accepts a forwarded scheme even when `trustedProxies` is a list, which departs from ADR-0016's forwarded-header rule. No bearer escalation, because the signature covers the origin. |
| 23 | Markdown href is double-escaped | reproduced | `packages/mail/src/markdown.ts:1-57` escapes the whole input and then escapes the href again. `[Search](https://example.test/?a=1&b=2)` renders `&amp;amp;`, which is a broken link. The label is escaped once and is correct. No test pins the double escape (`packages/mail/tests/native-delivery.test.ts:295` checks a plain href). **Proposed ticket:** mail — escape the href once from raw markdown, keep `isSafeMailHref`. Not app-facing. |
| 24 | No SMTP connection pooling | insufficient-information | `packages/mail/src/runtime.ts:850-866` creates a transport per send with no `pool` option. Laravel's `smtp` mailer config has no pool key and reuses one mailer per process. **Decision (2026-10-20):** opt-in public pooling is rejected, with no app-facing pool key. Per-process transport reuse is kept for Laravel parity: Laravel's `MailManager` caches the mailer and its Symfony `SmtpTransport`, which keeps the connection open, so per-message connections are not parity. The cached transporter must hold a persistent connection internally (for example Nodemailer `pool: true`, not exposed in config), because a reused non-pooled Nodemailer SMTP transporter still connects per send. Filed as #225; no public option. |

### Realtime / Broadcast

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 27 | Broadcast afterCommit defaults to false | rejected-by-decision | `packages/broadcast/src/runtime.ts:296` falls back to `queueDefaults?.afterCommit ?? false`. Laravel's queue connections default `after_commit` to false (`config/queue.php`), and broadcast jobs follow the queue connection. Docs already tell users to call `.afterCommit()` (`apps/docs/docs/broadcasting/events-and-channels.md:218`). Default unchanged; no proposed change. |

### CLI / Adapters

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 28 | Next dev conflict exits zero; dead branch | reproduced | `packages/cli/src/project/scaffold/framework-renderers.ts:1276,1285-1289` gates the stop-and-restart branch behind `force` (default false, no caller passes it), and `:1402-1404` exits 0. Probe: the runner exits 0 and leaves an owned stale `next dev` running (deleted). Commit `35ae82e5` added the gate without a recorded reason. **Decision (2026-10-20, revised):** `holo dev` never stops another process automatically. Every port conflict exits non-zero and names the port. When the holder is this project's own `next dev`, the message says another `holo dev` is running and gives its PID. The dead `force` stop-and-restart branch is deleted. Ownership matching cannot tell a stale server from a healthy one, so it is not used to stop anything. Filed as #218. |
| 29 | Worker processes launch via bare node | insufficient-information | `packages/cli/src/runtime.ts:389,397,408` spawns `node`; other launches use `process.execPath` (`packages/cli/src/dev.ts:28,106`, `packages/cli/src/queue.ts:651`). Probe: with `node` missing from PATH, the runtime launch fails with ENOENT while `process.execPath` runs. Pinned by `packages/cli/tests/cli.test.ts:7137-7140`. **Decision (2026-10-20):** launch via `process.execPath`. Update the pinned test and confirm `--experimental-strip-types` still works. Filed as #218. |
| 30 | Environment payload has a 128 KB limit | reproduced (Linux; low priority) | `packages/cli/src/runtime.ts:514-537` sends the whole migrate/seed payload as `HOLO_RUNTIME_PAYLOAD`. Linux `E2BIG` at 131072 bytes (checked in a `node:22-alpine` container; macOS allows far more). Reachable only with roughly 700+ bundled files. **Proposed ticket:** packages/cli — pass the payload on stdin or as a temp file path. Not app-facing. |
| 31 | Development module-import cache can grow | reproduced (low severity) | `packages/config/src/loader.ts:81` (jiti, `moduleCache: false`) and `:84-96` (`?t=` nonce ESM import for `.js`/`.mjs`/`.cjs`; `importConfigModule` clears the require cache for `.cjs` and still imports a fresh `?t=` URL, so `.cjs` grows too). Each `.mjs` load retains about 4.6 KB for the life of the process (1000 loads ≈ 4.6 MB); `.ts` via jiti retains about 430 B. Scaffolded configs are `.ts`, so only `.js`/`.mjs`/`.cjs` apps grow. **Decision (2026-10-20):** route `.js`/`.mjs`/`.cjs` configs through a non-retaining loader or bound retention, after confirming evaluation semantics are unchanged. Filed as #220. Internal. |
| 32 | cli.ts has a 1,763-line function | insufficient-information | `packages/cli/src/cli.ts:418-2211` (`createInternalCommands`) measures 1,794 lines inclusive by AST. It is a single `return [...]` of 51 declarative command definitions, not hidden behavior. The ticket's 1,763 does not match this count, and the method behind it is unknown. Closed as wontfix on 2026-10-20: maintainability only, no behavior defect. |
| 33 | Generated run.mjs assembled from string arrays | insufficient-information | Only TypeScript-side interpolations, each `JSON.stringify`d (`packages/cli/src/project/scaffold/framework-renderers.ts:1052-1054`); the project root is computed at runtime from `import.meta.url`. Probes: the runner works from a path with spaces, an apostrophe and a double quote; a command name with quotes, backslashes, U+2028 and `${…}` passes `node --check` and round-trips. Closed as wontfix on 2026-10-20: maintainability only, no behavior defect. |
| 34 | Svelte legacy shims | insufficient-information (rejected 2026-10-20; see Decision 13) | `packages/adapter-sveltekit/src/preprocess.ts:33-240` is live, tested and documented (`apps/docs/docs/basics/forms/frameworks.md:331`). `packages/cli/src/project/registry-svelte.ts:438-455,509-557,602-622,640-660,750-821` migrates pre-0.3 generated projects on every `holo prepare`; it is undocumented and has no ADR. **Decision (2026-10-20):** rejected. No pre-0.3 Svelte upgrade support (0.x policy). No ticket is filed for removing the migration code. `packages/flux-svelte` has no shim. |

### Tests / Flux

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 35 | Sleep-based waits | insufficient-information (not a product defect; test-quality follow-up needs scoping) | 87 awaited sleep waits in 43 test files out of 468, by package: cli 17, db 11, security 7, queue 7, queue-redis 6, core 6, config 6, session 3, queue-db 3, cache-redis 3, mail 2, events 2, cache-db 2, cache 2, broadcast 2, auth 2, storage-s3 1, realtime 1, notifications 1, db-sqlite 1, db-postgres 1, adapter-next 1. 176 call sites already use `expect.poll`/`vi.waitFor`. This is test-speed and flake risk only; a follow-up can start with cli and db. |
| 36 | Thin coverage in queue-redis, cache-redis, adapter-shared, flux | rejected-by-decision | Maintainer decision of 2026-10-20: coverage gaps and percentages are not work items. TDD for concrete behaviors and regressions only. |
| 37 | Flux client parses JSON without error handling | reproduced (low severity) | `packages/flux/src/index.ts:300-306` (raw `JSON.parse`), `:540` (every WebSocket frame), `:543` and `:315` (string re-parse). A non-JSON frame throws out of the message listener; later valid frames still deliver and status stays `connected`. Auth-response handling is safe. Compare `packages/broadcast/src/json.ts:54-63` (labelled error). **Decision (2026-10-20):** auth failures go to the channel `.error()` callback, matching Echo; malformed frames are dropped with a dev-mode log. Filed as #221. |

## Proposed implementation tickets

Filed on 2026-10-20 as the issues below, each with a failing regression test first through the public interface, as the #98 definition of done requires. Rejected items have no issue.

| Package | Items | Shape | Issue |
| --- | --- | --- | --- |
| auth-workos | 2, 5 | state-cookie Secure = configured OR https (https via `resolveRequestUrl`); remove both session-id fallbacks; fail closed when WorkOS returns no session id (contract unchanged) | #212 |
| session | 3 | per-session Redis keys, no hash tag; ADR-0012 update; upgrade note | #213 |
| db-mysql, db | 13, 16, 18 | URL keeps `ssl`; `sync` dedupes ids; model-query `update`, `updateJson`, `increment`, `decrement` set `updated_at`; `upsert` sets `created_at` and `updated_at` (upgrade note) | #214 |
| media | 20 | remote-fetch address classification hardening; ADR-0016 hardening record | #215 |
| storage-s3 | 21 | `Content-Type` on PUT and multipart create | #216 |
| mail | 23 | href escaped once | #217 |
| mail | 24 | one persistent SMTP transporter per mailer per process (internal Nodemailer `pool: true`); no public pool option | #225 |
| cli | 28, 29, 30 | non-zero exit and port name on every conflict (no automatic stop; PID named for this project's own `next dev`); dead `force` branch deleted; `process.execPath`; payload off the environment | #218 |
| security | 11 | CSRF enabled by default (upgrade note) | #219 |
| config | 31 | bounded dev cache for `.js`/`.mjs`/`.cjs` | #220 |
| flux | 37 | malformed frames dropped with a dev log; auth failures via `.error()` | #221 |
| adapter-nuxt, storage | 22 (folded), follow-up | forwarded proto only from trusted proxies; temporary URLs behind a trusted TLS proxy use https | #222 |
| auth | 1 | scrypt N=2^15, r=8, p=3 (about 32 MiB per operation); rehash on login; explicit `maxmem`; internal bound of 4 concurrent operations; ADR-0016 hardening record | #224 |
| tests | 35 (follow-up) | sleep-based waits replaced with polling | #223 |
| rejected (no issue) | 7, 15, 25, 26, 34 | closed with decision 2026-10-20 | none |
| wontfix (no issue) | 32, 33 | maintainability only | none |

## Resolution (2026-10-20)

Audit-time dispositions above are kept as recorded. This table lists only the items with a separate resolution: a decision, a filed issue, or an open or wontfix outcome. Items 4, 6, 8, 9, 12 and 19 are already-fixed and items 10, 14, 17, 27 and 36 are rejected-by-decision; neither group has a row here or an issue. Rule applied: follow Laravel; keep hardening only where it is security.

| Item | Audit disposition | Resolution | Issue |
| --- | --- | --- | --- |
| 2 | reproduced | Implement: state cookie Secure = configured OR https, with https decided by the trusted-proxy-aware `resolveRequestUrl` (decision-free) | #212 |
| 3 | insufficient-information | Implement: per-session Redis keys, no hash tag (Laravel) | #213 |
| 5 | reproduced | Implement: remove the access-token and authorization-code session-id fallbacks; fail closed when WorkOS returns no session id (`WorkosVerifiedSession.sessionId` unchanged) | #212 |
| 7 | reproduced | Rejected: no per-request upstream revocation check (not Laravel) | closed with decision |
| 11 | insufficient-information | Implement: CSRF enabled by default, with upgrade note | #219 |
| 13 | reproduced | Implement: URL branch keeps ssl | #214 |
| 15 | reproduced | Rejected: no bulk-insert splitting (Laravel does not split) | closed with decision |
| 16 | reproduced | Implement: sync dedupes ids; attach unchanged | #214 |
| 18 | reproduced | Implement: model-query `update`, `updateJson`, `increment` and `decrement` set `updated_at`; `upsert` sets `created_at` and `updated_at`; upgrade note | #214 |
| 20 | reproduced | Implement: keep the remote-fetch guard, record it in ADR-0016 as hardening, harden address classification (details in private advisory GHSA-h2jh-r2v8-m68q) | #215 |
| 21 | reproduced | Implement: store Content-Type on S3 PUT (Flysystem parity) | #216 |
| 23 | reproduced | Implement: single-escape the markdown href | #217 |
| 24 | insufficient-information | Implement: reuse one persistent SMTP transporter per mailer per process (internal Nodemailer `pool: true`; Laravel parity); public pooling option rejected | #225 |
| 25 | insufficient-information | Rejected: no Origin requirement; allowed-origins stays optional (Reverb parity) | closed with decision |
| 26 | insufficient-information | Rejected: no publish nonce cache; the 300 s Pusher window is parity | closed with decision |
| 28 | reproduced | Implement: every port conflict exits non-zero and names the port; a conflict with this project's own `next dev` names the other `holo dev` PID; no process is stopped automatically; dead `force` branch deleted | #218 |
| 29 | insufficient-information | Implement: runtime worker via process.execPath | #218 |
| 30 | reproduced | Implement: payload via stdin or temp file (decision-free) | #218 |
| 31 | reproduced | Implement: bounded retention for `.js`/`.mjs`/`.cjs` config loads | #220 |
| 34 | insufficient-information | Rejected: no pre-0.3 Svelte upgrade support (0.x policy) | closed with decision |
| 35 | insufficient-information | Follow-up: replace sleep-based waits (test-only) | #223 |
| 37 | reproduced | Implement: auth failures via the channel .error() callback; malformed frames dropped with a dev-mode log | #221 |
| 22 (Nuxt sub-finding) | follow-up | Follow-up: storage route honors X-Forwarded-Proto only from trusted proxies (security) | #222 |
| 1 | insufficient-information | Implement: raise scrypt to N=2^15, r=8, p=3 (about 32 MiB per operation), rehash on login, explicit `maxmem`, internal bound of 4 concurrent scrypt operations per process (16-concurrent-hash test), record as ADR-0016 hardening | #224 |
| 22 (publicStorage trusted-proxy) | insufficient-information | Folded into #222 as an acceptance criterion: temporary URLs behind a trusted TLS proxy use https | #222 |
| 32 | insufficient-information | Wontfix: maintainability only, no behavior defect (closed 2026-10-20) | wontfix |
| 33 | insufficient-information | Wontfix: maintainability only, no behavior defect (closed 2026-10-20) | wontfix |

Items 4, 6, 8, 9, 12 and 19 keep their audit disposition (already-fixed), and items 10, 14, 17, 27 and 36 keep theirs (rejected-by-decision). None needs an issue.

## Decisions needed

Resolved 2026-10-20 (see Resolution). The list below is the question as it was asked.

1. **#3** Redis single hash tag vs per-session keys. Outcome: per-session keys (#213).
2. **#5** Remove the authorization-code session-id fallback (changes a pinned test). Outcome: remove both fallbacks; fail closed when WorkOS returns no session id (#212).
3. **#7** Per-request upstream revocation check for Clerk/WorkOS sessions (new departure). Outcome: rejected.
4. **#11** CSRF enabled by default (app-facing). Outcome: enabled, with upgrade note (#219).
5. **#15** Split bulk inserts under the bind limit, with transaction atomicity. Outcome: rejected.
6. **#18** Stored-data change for `update()` timestamps; upgrade note. Outcome: implement across model-query `update`, `updateJson`, `increment`, `decrement` (`updated_at`) and `upsert` (`created_at`, `updated_at`) (#214).
7. **#24** Opt-in SMTP pooling (new config key, app-facing) or accept parity. Outcome: public pooling rejected; transport reuse → #225.
8. **#28** `holo dev` exit code on port conflict. Outcome: every port conflict exits non-zero and names the port; no process is stopped automatically; a conflict with this project's own `next dev` names the other `holo dev` PID; dead `force` branch deleted (#218).
9. **#29** Runtime worker launches via `process.execPath`. Outcome: implement (#218).
10. **#37** Surfacing malformed frames and auth failures to the app. Outcome: auth failures via `.error()`; malformed frames dropped with a dev log (#221).
11. **#20** Record the remote-fetch guard in ADR-0016 if kept as hardening. Outcome: keep and record (#215; details in private advisory GHSA-h2jh-r2v8-m68q).
12. **#21** Confirm S3 metadata scope (stored Content-Type). Outcome: store Content-Type (#216).
13. **#34** Optional: keep pre-0.3 Svelte project upgrades supported. Outcome: rejected (0.x policy).
14. **#25** Require an Origin header on Broadcast connections. Outcome: rejected (allowed-origins stays optional; Reverb parity).
15. **#26** Add a publish nonce cache beyond the Pusher-style 300 s window. Outcome: rejected (Pusher parity).
16. **#1** scrypt cost. Outcome: N=2^15, r=8, p=3 (about 32 MiB per operation), rehash on login, explicit `maxmem`, and an internal bound of 4 concurrent scrypt operations per process; rejected alternative N=2^17, r=8, p=1 (about 128 MiB per operation) (#224).

## Follow-ups outside this inventory

- Nuxt storage route trusts `X-Forwarded-Proto` regardless of `trustedProxies`, unlike the realtime and broadcast-auth routes (`packages/adapter-nuxt/src/runtime/server/routes/storage.ts`, observed under #22). Filed as #222.
- Sleep-based test waits (#35): 87 sites, starting with cli and db. Filed as #223.
- Publish-replay nonce (#26) was rejected on 2026-10-20 (Pusher's 300 s window is parity).
