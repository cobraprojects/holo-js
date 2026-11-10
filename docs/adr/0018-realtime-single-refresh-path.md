# Realtime refreshes re-run the handler and diff the result

Realtime has one refresh path. A relevant write schedules the subscription, the original handler runs again through native query execution, and Holo delivers the difference from the previous value as a patch or a snapshot. The server no longer prepares patches from write rows or backfill queries, so that engine and its metadata are removed. Coverage of the realtime and broadcast suites, with PostgreSQL and MySQL enabled, showed no delivery through it. This supersedes the patch-preparation and mutation-orchestration parts of [0013](0013-realtime-row-window-orchestration-ownership.md).

We chose one path because the engine ran its backfill queries and metadata work before every re-run, and in the suites it never delivered a patch. Its only effect was to skip re-runs for writes that contradicted every predicate of a subscription. [0013](0013-realtime-row-window-orchestration-ownership.md) already decided that correctness of arbitrary handler return values takes precedence over avoided reruns.

That skip is kept on purpose, in the invalidation layer. A subscription is not re-run when every read it makes is contradicted by the rows of the batch's writes, so those writes issue no query. Inserts and deletes are checked by their rows. An update that changes no predicate column is checked by its new rows, because no row can move across a predicate. An update that changes a predicate column also needs its previous rows. Subscriptions that read several database contexts still re-run.

Consequences:

- The `@holo-js/db` hook that asked the database to capture previous rows for realtime is removed, because nothing else used it. MySQL still captures previous rows for every write, so its updates of predicate columns keep the skip. PostgreSQL and SQLite return written rows from the statement and no longer capture previous rows, so an update of a predicate column there re-runs the handler. Updates of other columns skip on every dialect.
