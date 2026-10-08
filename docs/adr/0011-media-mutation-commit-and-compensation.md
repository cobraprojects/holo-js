# Retain committed Media outcomes after cleanup failure

Media mutation ownership will compensate file changes when an operation fails before record commitment, while preserving a committed record and its new files if obsolete-file cleanup or post-commit queued dispatch fails. These later failures must be reported clearly, and compensation failures must remain visible. We chose this distinction because stored files and queued delivery cannot join a database transaction, and undoing an already committed result would misrepresent the operation's outcome.

Record commitment means the enclosing database transaction has committed, not merely that a record save returned. Existing transaction hooks determine when rollback compensation and post-commit effects run.

Successful return types remain unchanged. A single failure uses a native error with its cause preserved, while primary and compensation failures use `AggregateError`; post-commit errors explicitly report that the Media result remains committed. A new exported error type is deferred unless callers need to branch programmatically on commitment.

Attachment, replacement, regeneration, and deletion are implemented through the private Media mutation module. It starts a
write transaction, retains rollback compensation until the enclosing transaction completes, and
defers obsolete-file cleanup and queued dispatch until commit. A failed post-commit effect retains
the durable attachment; cleanup continues across obsolete files and dispatch is attempted even when
cleanup fails. Native causes retain the failures. Database rollback callback failures preserve the
original transaction failure alongside compensation failures through `AggregateError`.

Regeneration snapshots overwritten conversion files before writing and restores them on operation
failure or enclosing rollback. Obsolete conversions are removed only after commitment. Explicit
deletion commits the record removal before removing its stored files; a cleanup failure retains the
deletion and reports commitment. These paths use the same private mutation owner and compensation
policy, including visible failed restoration. Queued regeneration dispatch runs after commitment.

Rollback callbacks run in reverse registration order so repeated writes unwind to the enclosing
transaction's original files. Each Media rollback callback restores its files before refreshing
its record and invalidating its owner relation, and preserves both failures if restoration and
refresh fail. Commit callbacks retain registration order. Applications using database rollback
callbacks must account for their reverse ordering.
