# Follow Laravel behavior unless Node cannot provide equal safety

Holo adopts Laravel's behavior, defaults, and failure semantics for equivalent capabilities, so Laravel developers can predict how an application behaves. A Holo capability departs from Laravel only where JavaScript or Node cannot provide the safety PHP provides, and each departure is recorded with that reason. We chose behavioral parity over case-by-case redesign because familiar semantics reduce surprise and give one tie-breaker for future decisions; it rejects opinionated hardening that Laravel itself does not apply.

Recorded departures:

- Request input is bounded at 1,000 input variables, and array indexes must fall within the submitted entries, because Node lacks PHP's `max_input_vars` and JavaScript arrays are sparse rather than hash maps.
- Path segments that reach object prototypes are rejected, because PHP arrays have no prototype chain.
- Request, subscription, and capability state must be isolated per request or subscription, because a Node process outlives requests while PHP shares nothing between them.
- A malformed typed environment value fails instead of returning the raw string, because a typed fallback cannot represent Laravel's string result.
- `APP_ENV` must be `development`, `production`, or `test`, and any other value fails, because Holo's environment is a typed value that selects a fixed env-file order and production safeguards; an unknown name would otherwise fall back silently.
- `APP_ENV` in `.env` also selects the environment's env files, loaded on top of `.env`, because Node has no process-wide `putenv` step before the framework boots, so `.env` is the only file an operator can rely on to name the environment for every Holo entry point.
- Holo encrypts only the cookies it owns (session, remember, and `XSRF-TOKEN`), because it cannot intercept cookies written through each framework's native cookie interfaces as Laravel's `EncryptCookies` does.
- Model primary keys and `created_at`/`updated_at` columns are guarded unless named in `fillable`, even with `fillable: ['*']` or a `guarded` list, because Holo applies mass-assignment rules to query updates and upserts that receive request payloads, where Laravel applies none.
- Password and sensitive fields are stripped from validation failures at every depth, including arrays, because Holo echoes submitted values in 422 response bodies and exception payloads, while Laravel flashes input only into the server-side session.
- The Nuxt form-failure cookie carries errors but no submitted values, because it is a client-readable cookie rather than Laravel's server-side session.
- Social sign-in links an existing local user only when that user's email is verified, because Laravel core defines no social account-linking behavior.
- With `trustedProxies: '*'`, forwarded headers are trusted when the framework does not expose the connection address, and with a list of proxies they are ignored, because Next.js gives Holo no equivalent of PHP's always-present `REMOTE_ADDR`.
- A malformed trusted `X-Forwarded-Port` or `X-Forwarded-Prefix` is answered with `400 Bad Request`, as a malformed forwarded host is in Laravel, because a URL object cannot hold the non-numeric port PHP casts to an integer, and Holo places the prefix in the public request path, where a prefix such as `//host` would read as another origin.
- The memory rate-limit store keeps at most 10,000 keys per process, dropping expired keys and then the least recently used key, and the file store deletes expired keys on a sweep, because Node processes and disks grow without bound under a flood of distinct keys, which PHP's per-request arrays never reach. A key evicted under flood pressure restarts its window. Laravel's array driver has no bound.
