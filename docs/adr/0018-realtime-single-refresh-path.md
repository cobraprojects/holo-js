# Realtime refreshes re-run the handler and diff the result

Realtime has one refresh path. A relevant write schedules the subscription, the original handler runs again through native query execution, and Holo delivers the difference from the previous value as a patch or a snapshot. The server no longer prepares patches from write rows or backfill queries, so that engine and its metadata are removed. Coverage of the realtime and broadcast suites, with PostgreSQL and MySQL enabled, showed no delivery through it. This supersedes the patch-preparation and mutation-orchestration parts of [0013](0013-realtime-row-window-orchestration-ownership.md).

Realtime has no write-level refresh skip. A write to a table a subscription reads re-runs its handler once, even when the write's rows appear to contradict the subscription's predicates. The engine this replaces skipped some of those re-runs for handlers whose results it could not bind, and a rule that decides from write rows alone was added in its place and then removed.

We chose soundness over avoided re-runs. Deciding from write rows that a subscription is unaffected requires modelling every way a row can match a query, including joins, subqueries, full-text matching, NaN, column-name case, generated columns, non-atomic captures and float rounding. Six independent reviews found false skips in that rule, each leaving subscribers with stale data, and a rule strict enough to be sound also broke existing behavior for string table names. [0013](0013-realtime-row-window-orchestration-ownership.md) already decided that correctness of arbitrary handler return values takes precedence over avoided reruns.

The exact-invalidation check in `subscription-index.ts` predates this decision and is unchanged. It rules out some writes from exact row values before any subscription is collected, and it is not a write-level skip.

Consequences:

- Each relevant write costs one handler run per affected subscription. The SQL cost guards pin the query count of a refresh.
- The `@holo-js/db` hook that asked the database to capture previous rows for realtime is removed, because no realtime path reads previous rows now.
