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

These are the four dispositions the ticket permits; "not-reproduced" is not one of them. Items 2, 5 and 18 are partly reproduced or partly decision-gated; each row says which part. A reproduced item whose fix needs a choice is also listed under Decisions needed.

Decisions were resolved on 2026-10-20 by the orchestrator (see Resolution). Implementation issues are filed as #212–#224 and linked as sub-issues of #98. Every item now has an outcome: 32 and 33 are wontfix, 1 is #224, and 22 is carried by #222.

## Dispositions

### Auth / Session

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 1 | scrypt cost N=2^14 | insufficient-information | `packages/auth/src/runtime/scryptPasswordHasher.ts:5-7,19` uses N=16384, r=8, p=1 and is pinned by `packages/auth/tests/package.test.ts`. Laravel core has no scrypt hasher, and its bcrypt default (12 rounds) does not establish that N=2^14 is adequate, so ADR-0016 does not settle the strength question. Open question: is N=2^14 accepted as equivalent safety, or should a higher cost be proposed as a decision? |
| 2 | Secure cookie defaults; state-cookie Secure follows protocol | reproduced (state-cookie half) | `packages/auth-workos/src/index.ts:501-516` sets `secure` from the request scheme, which overrides `cookie.secure` config (`packages/session/src/runtime.ts:151`). A configured `secure: true` app served over http gets a non-Secure state cookie. The session default (`packages/session/src/config.ts:99`, `secure: false`) matches Laravel's `SESSION_SECURE_COOKIE` default and is not a defect. **Proposed ticket:** auth-workos — state cookie Secure = configured session cookie secure OR https request. Not app-facing. Config-only Secure would drop the flag on default https sites and must not be used. |
| 3 | Redis session keys in one hash slot | insufficient-information | `packages/session/src/drivers/redis-adapter.ts:327-329` uses a constant `{holo-session}` hash tag so the two-key ROTATE script stays atomic under Cluster (`:52-67`). Every session key shares one slot and node. Not recorded in ADR-0016. Laravel uses one key per session with no hash tag and non-atomic rotation. **Decision:** accept and record the tag as a departure, or switch to per-session keys with copy-then-delete rotation. |
| 4 | File sessions have no GC | already-fixed | `packages/session/src/drivers/file.ts:473-531` (bounded expired-session sweeper, wired at `:535` and `:629`), lottery `packages/session/src/runtime.ts:313-325` (2/100, as Laravel's `session.lottery`). `packages/session/tests/session-gc.test.ts` passes 7/7. |
| 5 | WorkOS session identifier falls back to the token | reproduced (access-token half); code half awaits Decision 2 | `packages/auth-workos/src/index.ts:949-953` falls back to the access token, then the authorization code. The access token is stored as `workos.sessionId` and sent as the upstream logout `session_id` (`:547-551`, `:1140`). An opaque access token (no `sid` claim) therefore lands in the session payload and in a redirect URL. The authorization-code fallback is pinned by `packages/auth-workos/tests/package.test.ts:1186-1200`. **Proposed ticket:** auth-workos — remove the access-token fallback; with no `sid`, store no upstream session id and skip upstream logout. Not app-facing. **Decision:** remove the code fallback too (changes the pinned test), or keep it. Rejecting login with no `sid` would be app-facing. Reachability is low because WorkOS access tokens normally carry `sid`. |
| 6 | WorkOS trusts forwarded client addresses | already-fixed | WorkOS calls the shared resolver (`packages/auth-workos/src/index.ts:922` → `packages/kernel/src/requestUrl.ts:181-183`, forwarded headers only when configured). Fixed by #118 / PR #158. `packages/auth-workos/tests/package.test.ts:1055-1075` ("never a spoofed forwarded address") passes. |
| 7 | Holo session outlives Clerk/WorkOS revocation | reproduced (remediation needs a decision) | `packages/auth-workos/src/index.ts:857-868` and `:1026-1040` re-verify upstream only on hosted `authenticate()`; the guard resolves from the Holo record. Clerk has the same shape (`packages/auth-clerk/src/index.ts:885-931`). ADR-0015 scopes these sessions to Holo and treats upstream sessions as separate, and Laravel's session guard never consults upstream state. A per-request upstream check would be a new recorded departure. **Decision:** orchestrator/user call. |

### Security

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 8 | CSRF header comparison not constant-time | already-fixed | `packages/security/src/csrf.ts:74-81` uses `timingSafeEqual` after a length check, which leaks only the fixed token length. |
| 9 | Browser client hardcodes X-CSRF-TOKEN | already-fixed | Superseded by #120 / PR #164. `packages/security/src/client-config.ts:109-113` sends the encrypted `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`; the custom header is configurable through `csrf.header`. `packages/security` client suite passes 6/6. |
| 10 | Broadcast auth CSRF exemption fixed, not configurable | rejected-by-decision | `packages/security/src/csrf.ts:48-51,259` exempts `/broadcasting/auth` unless `csrf: true`, and the docs say so (`apps/docs/docs/basics/security/csrf.md:139`). Laravel also exempts the broadcast auth route from `VerifyCsrfToken` and does not make that configurable. A throwaway probe confirmed the exemption and the `csrf: true` override (deleted). |
| 11 | CSRF disabled by default in configuration | insufficient-information | `packages/security/src/config.ts:185,426` defaults `csrf.enabled` to `false`; the scaffold sets `true` (`packages/cli/src/project/scaffold/config-renderers.ts:326`). Laravel's `web` group always validates CSRF. The default is not in ADR-0016. **Decision:** default to enabled (Laravel parity; apps that register `csrfProtection()` without a `csrf` block start receiving 419 on unsafe requests — app-facing), or record the default-off as a departure. |
| 25 | Connections without Origin are allowed | insufficient-information | `packages/broadcast/src/worker.ts:217-227` allows an absent Origin, on both upgrade paths (`:2230`, `:2412`). Cross-site WebSocket hijacking needs a browser, and browsers always send Origin on the upgrade, so an Origin-less connection cannot carry ambient cookies. Private channels still require credentials via the auth endpoint (`:924`). The behavior is real (a throwaway probe passed and was deleted), so the open question is whether to require Origin at all; that is a product choice, not a disproved claim. |
| 26 | Publish authentication has a replay window | insufficient-information | `packages/broadcast/src/worker.ts:349` allows 300 s of skew and `:1905` signs method, path, sorted params and a body MD5. An identical signed publish is accepted twice within the window (probe passed, deleted). The window is inherent to the Pusher-style protocol (Pusher allows 600 s, no nonce) and Holo's is tighter. A nonce cache would be Holo-only hardening. |

### Database / ORM

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 12 | MySQL DDL default/index identifier escaping | already-fixed | Identifiers pass `assertValidIdentifierSegment` before quoting (`packages/db/src/schema/SQLSchemaCompiler.ts:236-240,287-296`; index names via `generatedNames.ts`). Defaults with quote, backslash, newline, NUL and JSON round-tripped exactly on live MySQL (`packages/db/src/core/mysqlStringLiteral.ts:1-12` switches to a hex literal). Probe deleted. |
| 13 | MySQL URL handling drops ssl | reproduced | `packages/db-mysql/src/index.ts:378-379` (URL branch passes only `{ uri }`) versus `:380-387` (structured branch passes `ssl`). Live MySQL: structured `ssl` gives a TLS cipher, the URL path gives plaintext. Laravel's URL parser merges query and primary config, so configured options survive. **Proposed ticket:** db-mysql — pass `ssl` into the URI branch. Not app-facing. The other dropped pool options (`max`, timeouts, `application_name`) are a separate decision. |
| 14 | chunk/cursor fallback loads the full result | rejected-by-decision | ADR-0002: joined, grouped, distinct and union shapes keep full-result fallback. |
| 15 | Bulk insert is not chunked | reproduced (fix shape needs a decision) | `packages/db/src/query/TableQueryBuilder.ts:2134-2160` builds one statement for all rows. Pivot inserts are batched (`packages/db/src/model/PivotMutation.ts:108`, budget 900). Probes: SQLite 3,300 × 10 (33,000 binds) fails with zero rows written; MySQL 7,000 × 10 fails the same way. Laravel's `insert` is also one call with no chunking. **Decision:** split under the driver bind limit (SQLite 32,766; PostgreSQL and MySQL 65,535), accepting multiple statements, and run them in one transaction to keep atomicity? |
| 16 | Pivot `sync([1,1])` may duplicate associations | reproduced | `packages/db/src/model/PivotMutation.ts:133-141` keeps duplicate ids and `:43-69` snapshots `current`, so each duplicate becomes an insert. Without a unique key it writes two rows; with the usual unique key it throws and rolls back. Laravel's `formatRecordsList` keys by id, so duplicates collapse. `attach` is deliberately different and matches Laravel's `formatAttachRecords` (`packages/db/tests/pivot-mutations-integration.test.ts:153-169`). **Proposed ticket:** packages/db — dedupe ids in `sync` only (last attributes win). Not app-facing. |
| 17 | Observers instantiated again for each dispatch | rejected-by-decision (ADR-0016 parity: the construction is real, but Laravel also builds a fresh observer per dispatch and no state differs; closed wontfix as performance-only) | `packages/db/src/model/ModelEventDispatcher.ts` `resolveHandlers` constructs a class observer per dispatch. Probe: one `create()` built each observer four times. Per-event state does not survive in Laravel either (fresh instance per dispatch), so there is no observable state difference. |
| 18 | Query `update()` skips `updated_at` | reproduced (model builder); awaits Decision 6 | `packages/db/src/model/ModelQueryBuilder.ts:1381-1383` does not apply timestamps; the save path does (`packages/db/src/model/ModelRepository.ts:1774`). Probe: `Note.query().where(...).update()` leaves `updated_at` unchanged. Laravel's `Eloquent\Builder::update` adds `updated_at` when the model uses timestamps. The table builder (`packages/db/src/query/TableQueryBuilder.ts:2249-2252`) matches Laravel's base builder and is correct. **Proposed ticket:** packages/db — add `updated_at` in `ModelQueryBuilder.update`/`updateJson` when the caller omits it. **Decision:** changes stored data for existing query updates; confirm and add an upgrade note. |
| 19 | forceFill behaves like fill | already-fixed | `packages/db/src/model/Entity.ts:170-174` (`fill` asserts mass assignable) and `:181-184` (`forceFill` assigns directly). Commit `055cb658` (#153). `packages/db/tests/model-mass-assignment.test.ts` passes 8/8. |

### Storage / Mail

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 20 | NAT64/6to4 gaps in SSRF protection | reproduced | `packages/media/src/model/adder.ts:621-650` blocks IPv4-mapped (`::ffff:`) and local IPv6 ranges, but not IPv4 embedded in `64:ff9b::/96` or `2002::/16`. Probe: `64:ff9b::7f00:1`, `64:ff9b::a9fe:a9fe`, `64:ff9b::c0a8:1`, `2002:7f00:1::`, `2002:a9fe:a9fe::` all resolve as allowed (deleted). Laravel core has no remote-media fetch, so this guard is Holo-only; the fix closes a gap in the guard's own stated scope and does not change the API. **Proposed ticket:** media — classify embedded IPv4 in `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16` (and IPv4-compatible `::/96`) with the same private-range rules as `::ffff:`. Not app-facing. Proceeds only if Decision 11 keeps the guard as approved hardening, since ADR-0016 rejects hardening Laravel does not apply. |
| 21 | S3 PUT omits Content-Type | reproduced | `packages/storage-s3/src/index.ts:220-292` signs no content type; `setItem`/`setItemRaw` (`:699-705`) and multipart create (`:720-745`) send none. A real local HTTP endpoint received a PUT with no content-type header (deleted probe). Flysystem's S3 adapter sets a MIME type when none is given. **Proposed ticket:** storage-s3 — set `Content-Type` from `inspectFileContent`/MIME inference before signing, on PUT and multipart create. Changes stored metadata and the default type S3 serves; confirm that scope. |
| 22 | Temporary URLs behind a TLS proxy | insufficient-information | The signature covers the origin from configured `appUrl` (`packages/storage/src/temporaryLocalStorage.ts:22-80`). A signed `https://` URL serves 200 when the request is https and 404 when it reaches the app as http. The probe shows only this scheme-mismatch rejection. Behind a configured trusted TLS proxy, the correct result is not reproduced: `createPublicStorageResponse` (`packages/storage/src/publicStorage.ts:203-215`) takes the scheme from the raw `request.url` and does not use the shared trusted-proxy resolver, while Laravel's TrustProxies accepts a trusted forwarded scheme. Open question: reproduce through the adapter with proxy trust configured, then decide the fix. **Separate observation (follow-up, needs a ticket):** the Nuxt storage route (`packages/adapter-nuxt/src/runtime/server/routes/storage.ts`) builds its request URL with h3's default `toWebRequest`, which honors `X-Forwarded-Proto`. The realtime and broadcast-auth routes (`realtime-request.ts:12`, `broadcast-auth.post.ts:42`) pass `xForwardedProto: false`. The storage route therefore accepts a forwarded scheme even when `trustedProxies` is a list, which departs from ADR-0016's forwarded-header rule. No bearer escalation, because the signature covers the origin. |
| 23 | Markdown href is double-escaped | reproduced | `packages/mail/src/markdown.ts:1-57` escapes the whole input and then escapes the href again. `[Search](https://example.test/?a=1&b=2)` renders `&amp;amp;`, which is a broken link. The label is escaped once and is correct. No test pins the double escape (`packages/mail/tests/native-delivery.test.ts:295` checks a plain href). **Proposed ticket:** mail — escape the href once from raw markdown, keep `isSafeMailHref`. Not app-facing. |
| 24 | No SMTP connection pooling | insufficient-information | `packages/mail/src/runtime.ts:850-866` creates a transport per send with no `pool` option. Laravel's `smtp` mailer config has no pool key and reuses one mailer per process. **Decision:** add an opt-in pooled or persistent SMTP option (new config key, app-facing), or accept per-message connections as parity. |

### Realtime / Broadcast

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 27 | Broadcast afterCommit defaults to false | rejected-by-decision | `packages/broadcast/src/runtime.ts:296` falls back to `queueDefaults?.afterCommit ?? false`. Laravel's queue connections default `after_commit` to false (`config/queue.php`), and broadcast jobs follow the queue connection. Docs already tell users to call `.afterCommit()` (`apps/docs/docs/broadcasting/events-and-channels.md:218`). Default unchanged; no proposed change. |

### CLI / Adapters

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 28 | Next dev conflict exits zero; dead branch | reproduced (fix shape needs a decision) | `packages/cli/src/project/scaffold/framework-renderers.ts:1276,1285-1289` gates the stop-and-restart branch behind `force` (default false, no caller passes it), and `:1402-1404` exits 0. Probe: the runner exits 0 and leaves an owned stale `next dev` running (deleted). Commit `35ae82e5` added the gate without a recorded reason. **Decision:** should `holo dev` exit non-zero when another dev server owns the port, and should the owned-stale auto-stop be re-enabled? |
| 29 | Worker processes launch via bare node | insufficient-information | `packages/cli/src/runtime.ts:389,397,408` spawns `node`; other launches use `process.execPath` (`packages/cli/src/dev.ts:28,106`, `packages/cli/src/queue.ts:651`). Probe: with `node` missing from PATH, the runtime launch fails with ENOENT while `process.execPath` runs. Pinned by `packages/cli/tests/cli.test.ts:7137-7140`. **Decision:** switch to `process.execPath`? Recommended, but it interacts with the `--experimental-strip-types` choice, which is made from `process.versions`. |
| 30 | Environment payload has a 128 KB limit | reproduced (Linux; low priority) | `packages/cli/src/runtime.ts:514-537` sends the whole migrate/seed payload as `HOLO_RUNTIME_PAYLOAD`. Linux `E2BIG` at 131072 bytes (checked in a `node:22-alpine` container; macOS allows far more). Reachable only with roughly 700+ bundled files. **Proposed ticket:** packages/cli — pass the payload on stdin or as a temp file path. Not app-facing. |
| 31 | Development module-import cache can grow | reproduced (low severity) | `packages/config/src/loader.ts:81` (jiti, `moduleCache: false`) and `:84-96` (`?t=` nonce ESM import for `.js`/`.mjs`). Each `.mjs` load retains about 4.6 KB for the life of the process (1000 loads ≈ 4.6 MB); `.ts` via jiti retains about 430 B. Scaffolded configs are `.ts`, so only `.js`/`.mjs` apps grow. **Proposed ticket:** packages/config — route `.js`/`.mjs` configs through a non-retaining loader or bound retention, after confirming evaluation semantics are unchanged. Internal. |
| 32 | cli.ts has a 1,763-line function | insufficient-information | `packages/cli/src/cli.ts:418-2211` (`createInternalCommands`) measures 1,794 lines inclusive by AST. It is a single `return [...]` of 51 declarative command definitions, not hidden behavior. The ticket's 1,763 does not match this count, and the method behind it is unknown. |
| 33 | Generated run.mjs assembled from string arrays | insufficient-information | Only TypeScript-side interpolations, each `JSON.stringify`d (`packages/cli/src/project/scaffold/framework-renderers.ts:1052-1054`); the project root is computed at runtime from `import.meta.url`. Probes: the runner works from a path with spaces, an apostrophe and a double quote; a command name with quotes, backslashes, U+2028 and `${…}` passes `node --check` and round-trips. |
| 34 | Svelte legacy shims | insufficient-information (optional retirement; see Decision 13) | `packages/adapter-sveltekit/src/preprocess.ts:33-240` is live, tested and documented (`apps/docs/docs/basics/forms/frameworks.md:331`). `packages/cli/src/project/registry-svelte.ts:438-455,509-557,602-622,640-660,750-821` migrates pre-0.3 generated projects on every `holo prepare`; it is undocumented and has no ADR. **Optional decision:** whether in-place upgrades from pre-0.3 projects stay supported; if not, that migration code can be retired. `packages/flux-svelte` has no shim. |

### Tests / Flux

| # | Candidate | Disposition | Evidence and notes |
| --- | --- | --- | --- |
| 35 | Sleep-based waits | insufficient-information (not a product defect; test-quality follow-up needs scoping) | 87 awaited sleep waits in 43 test files out of 468, by package: cli 17, db 11, security 7, queue 7, queue-redis 6, core 6, config 6, session 3, queue-db 3, cache-redis 3, mail 2, events 2, cache-db 2, cache 2, broadcast 2, auth 2, storage-s3 1, realtime 1, notifications 1, db-sqlite 1, db-postgres 1, adapter-next 1. 176 call sites already use `expect.poll`/`vi.waitFor`. This is test-speed and flake risk only; a follow-up can start with cli and db. |
| 36 | Thin coverage in queue-redis, cache-redis, adapter-shared, flux | rejected-by-decision | Maintainer decision of 2026-10-20: coverage gaps and percentages are not work items. TDD for concrete behaviors and regressions only. |
| 37 | Flux client parses JSON without error handling | reproduced (low severity) | `packages/flux/src/index.ts:300-306` (raw `JSON.parse`), `:540` (every WebSocket frame), `:543` and `:315` (string re-parse). A non-JSON frame throws out of the message listener; later valid frames still deliver and status stays `connected`. Auth-response handling is safe. Compare `packages/broadcast/src/json.ts:54-63` (labelled error). **Proposed ticket:** flux — drop malformed frames without throwing. Not app-facing. **Decision:** should malformed frames or auth failures (silently dropped at `:529-530`) be surfaced to the app through a status or error callback? That is an API question. |

## Proposed implementation tickets

Reproduced items. Rows marked "decision" or "confirm scope" need approval (see Decisions needed) before implementation. Each implementation starts with a failing regression test through the public interface, as the #98 definition of done requires.

| Package | Items | Shape | App-facing |
| --- | --- | --- | --- |
| auth-workos | 2, 5 (access-token half) | state-cookie Secure = configured OR https; drop access-token session-id fallback | no |
| db-mysql | 13 | URL branch passes `ssl` | no |
| db | 16 | `sync` dedupes ids | no |
| db | 18 | query `update()` sets `updated_at` when omitted | decision (stored data) |
| media | 20 | classify IPv4 inside NAT64/6to4 | no; gated on Decision 11 |
| storage-s3 | 21 | `Content-Type` on PUT and multipart create | confirm scope (Decision 12) |
| mail | 23 | single-escape markdown href | no |
| cli | 30 | payload by stdin or temp file | no |
| config | 31 | non-retaining loader for `.js`/`.mjs` in dev | no |
| flux | 37 | non-throwing frame parse | no (drop-only); surfacing needs Decision 10 |
| auth-workos / auth-clerk | 7 | per-request upstream revocation check | new departure (Decision 3) |
| db | 15 | split bulk inserts under the driver bind limit | decision (Decision 5) |
| cli | 28 | `holo dev` exit code on port conflict; owned-stale auto-stop | decision (Decision 8) |

## Resolution (2026-10-20)

Audit-time dispositions above are kept as recorded. This table gives the orchestrator's outcome for each item and the issue that carries it. Rule applied: follow Laravel; keep hardening only where it is security.

| Item | Audit disposition | Resolution | Issue |
| --- | --- | --- | --- |
| 2 | reproduced | Implement: state cookie Secure = configured OR https (decision-free) | #212 |
| 3 | insufficient-information | Implement: per-session Redis keys, no hash tag (Laravel) | #213 |
| 5 | reproduced | Implement: remove the access-token and authorization-code session-id fallbacks | #212 |
| 7 | reproduced | Rejected: no per-request upstream revocation check (not Laravel) | closed with decision |
| 11 | insufficient-information | Implement: CSRF enabled by default, with upgrade note | #219 |
| 13 | reproduced | Implement: URL branch keeps ssl | #214 |
| 15 | reproduced | Rejected: no bulk-insert splitting (Laravel does not split) | closed with decision |
| 16 | reproduced | Implement: sync dedupes ids; attach unchanged | #214 |
| 18 | reproduced | Implement: query update() sets updated_at, with upgrade note | #214 |
| 20 | reproduced | Implement: keep the media SSRF guard, record it in ADR-0016 as hardening, cover the embedded-IPv4 ranges | #215 |
| 21 | reproduced | Implement: store Content-Type on S3 PUT (Flysystem parity) | #216 |
| 23 | reproduced | Implement: single-escape the markdown href | #217 |
| 24 | insufficient-information | Rejected: no SMTP connection pooling (Laravel parity) | closed with decision |
| 25 | insufficient-information | Rejected: no Origin requirement; allowed-origins stays optional (Reverb parity) | closed with decision |
| 26 | insufficient-information | Rejected: no publish nonce cache; the 300 s Pusher window is parity | closed with decision |
| 28 | reproduced | Implement: non-zero exit on an unowned port conflict; re-enable owned-stale auto-stop | #218 |
| 29 | insufficient-information | Implement: runtime worker via process.execPath | #218 |
| 30 | reproduced | Implement: payload via stdin or temp file (decision-free) | #218 |
| 31 | reproduced | Implement: bounded retention for .js/.mjs config loads | #220 |
| 34 | insufficient-information | Rejected: no pre-0.3 Svelte upgrade support (0.x policy) | closed with decision |
| 35 | insufficient-information | Follow-up: replace sleep-based waits (test-only) | #223 |
| 37 | reproduced | Implement: auth failures via the channel .error() callback; malformed frames dropped with a dev-mode log | #221 |
| 22 (Nuxt sub-finding) | follow-up | Follow-up: storage route honors X-Forwarded-Proto only from trusted proxies (security) | #222 |
| 1 | insufficient-information | Implement: raise scrypt N to 2^17 (r=8, p=1), rehash on login, record as ADR-0016 hardening | #224 |
| 22 (publicStorage trusted-proxy) | insufficient-information | Folded into #222 as an acceptance criterion: temporary URLs behind a trusted TLS proxy use https | #222 |
| 32 | insufficient-information | Wontfix: maintainability only, no behavior defect (closed 2026-10-20) | wontfix |
| 33 | insufficient-information | Wontfix: maintainability only, no behavior defect (closed 2026-10-20) | wontfix |

Items 10, 14, 17, 27 and 36 keep their audit dispositions (rejected-by-decision) and need no issue.

## Decisions needed

Resolved 2026-10-20 (see Resolution). The list below is the question as it was asked.

1. **#3** Redis single hash tag vs per-session keys.
2. **#5** Remove the authorization-code session-id fallback (changes a pinned test).
3. **#7** Per-request upstream revocation check for Clerk/WorkOS sessions (new departure).
4. **#11** CSRF enabled by default (app-facing).
5. **#15** Split bulk inserts under the bind limit, with transaction atomicity.
6. **#18** Stored-data change for `update()` timestamps; upgrade note.
7. **#24** Opt-in SMTP pooling (new config key, app-facing) or accept parity.
8. **#28** `holo dev` exit code on port conflict; re-enable owned-stale auto-stop.
9. **#29** Runtime worker launches via `process.execPath`.
10. **#37** Surfacing malformed frames and auth failures to the app.
11. **#20** Record the media SSRF guard in ADR-0016 if kept as hardening.
12. **#21** Confirm S3 metadata scope (stored Content-Type).
13. **#34** Optional: keep pre-0.3 Svelte project upgrades supported.
14. **#25** Require an Origin header on Broadcast connections (product choice; the behavior is real but not exploitable as cookie-riding).
15. **#26** Add a publish nonce cache beyond the Pusher-style 300 s window (Holo-only hardening if chosen; product choice).

## Follow-ups outside this inventory

- Nuxt storage route trusts `X-Forwarded-Proto` regardless of `trustedProxies`, unlike the realtime and broadcast-auth routes (`packages/adapter-nuxt/src/runtime/server/routes/storage.ts`, observed under #22). Filed as #222.
- Sleep-based test waits (#35): 87 sites, starting with cli and db. Filed as #223.
- Publish-replay nonce (#26) was rejected on 2026-10-20 (Pusher's 300 s window is parity).
