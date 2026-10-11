---
'@holo-js/db-postgres': patch
'@holo-js/db-sqlite': patch
'@holo-js/db': patch
'@holo-js/cache-db': patch
'@holo-js/cache': patch
'@holo-js/cli': patch
'@holo-js/validation': patch
'@holo-js/auth': patch
'@holo-js/core': patch
---

Handle PostgreSQL multi-statement migration results, hydrate numeric identifiers consistently, expire PostgreSQL database cache entries correctly, release native database cache connections during runtime shutdown, shut down the realtime runtime when broadcast workers stop, compile valid MySQL JSON and text defaults, and preserve the native database context when hydrating migration schemas during app builds.

Allow empty validation schemas for CSRF-only forms without accepting submitted transport fields as application data.

Cancel automatic Next auth refreshes when navigating or unmounting, avoiding stale updates and unhandled refresh failures while preserving explicit refresh errors.

Compile paginated locking reads with LIMIT and OFFSET before the locking clause so native MySQL database sessions and OAuth state writes execute correctly.

Reuse the validated request actor in authorization policy checks to avoid repeated database session writes and realtime dependency self-deadlocks. Direct auth lookups and new requests continue to validate sessions.

Open native SQLite databases in WAL mode so application and worker connections can commit writes while readers retain their transaction snapshots, and serialize writes by database file across connections in the same process.

Serialize database session timestamps using the native dialect so MySQL accepts session creation, activity updates, and rotation.
