# Realtime refreshes re-run the handler and diff the result

Realtime has one refresh path. A relevant write schedules the subscription, the original handler runs again through native query execution, and Holo delivers the difference from the previous value as a patch or a snapshot. The server no longer prepares patches from write rows or backfill queries, so that engine and its metadata are removed. Coverage of the realtime and broadcast suites, with PostgreSQL and MySQL enabled, showed no delivery through it. This supersedes the patch-preparation and mutation-orchestration parts of [0013](0013-realtime-row-window-orchestration-ownership.md).

We chose one path because the engine ran its backfill queries and metadata work before every re-run, and in the suites it never delivered a patch. Its only effect was to skip re-runs for writes that contradicted every predicate of a subscription. [0013](0013-realtime-row-window-orchestration-ownership.md) already decided that correctness of arbitrary handler return values takes precedence over avoided reruns.

That skip is kept on purpose, in the invalidation layer. A subscription whose query results the handler transforms, so they are not bound to its returned value, is not re-run when every read it makes is contradicted by the write's rows. The write then issues no query. The check covers inserts and deletes, and updates and upserts whose previous rows are known. Bound results, and reads that span several database contexts, always re-run.

Consequences:

- The `@holo-js/db` hook that asked the database to capture previous rows for realtime is removed, because nothing else used it. On PostgreSQL and SQLite, which return written rows from the statement, updates no longer capture previous rows. An update to a predicate column of an aggregate subscription there re-runs the handler, where it could previously be skipped. On MySQL, previous rows are always captured, so updates keep the skip.
