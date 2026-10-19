# Retain committed Media outcomes after cleanup failure

Media mutation ownership will compensate file changes when an operation fails before record commitment, while preserving a committed record and its new files if obsolete-file cleanup or post-commit queued dispatch fails. These later failures must be reported clearly, and compensation failures must remain visible. We chose this distinction because stored files and queued delivery cannot join a database transaction, and undoing an already committed result would misrepresent the operation's outcome.

Record commitment means the enclosing database transaction has committed, not merely that a record save returned. Existing transaction hooks determine when rollback compensation and post-commit effects run.

Successful return types remain unchanged. A single failure uses a native error with its cause preserved, while primary and compensation failures use `AggregateError`; post-commit errors explicitly report that the Media result remains committed. A new exported error type is deferred unless callers need to branch programmatically on commitment.

Attachment, replacement, regeneration, and deletion are implemented through the private Media mutation module. It starts a
write transaction, retains rollback compensation until the enclosing transaction completes, and
defers obsolete-file cleanup and queued dispatch until commit. Stored files are written before the write transaction starts: the original, then each conversion as it is generated, so only one conversion's output is held at a time. The transaction only records rows. Compensation for files a call creates is registered with the same mutation owner, so a failure before commit, in the transaction, or in an enclosing rollback deletes every file that call created. A failed post-commit effect retains
the durable attachment; cleanup continues across obsolete files and dispatch is attempted even when
cleanup fails. Native causes retain the failures. Database rollback callback failures preserve the
original transaction failure alongside compensation failures through `AggregateError`.

Regeneration overwrites conversion files at their deterministic paths and never snapshots or restores them. Conversions derive from the same original, so a failed or rolled-back regeneration leaves its newly written output in place, and the next regeneration rewrites it. Regeneration never deletes a conversion path that existed before the call. Obsolete conversions are removed only after commitment. Explicit deletion commits the record removal before removing its stored files; a cleanup failure retains the deletion and reports commitment. These paths use the same private mutation owner, and deletion keeps its compensation policy. Queued regeneration dispatch runs after commitment.

Overlapping regenerations of one media item each write their output before their transaction, and whichever commits last determines the row. Because nothing is restored, a failed regeneration can't roll the file back over a committed one. Writes are atomic on the local disk (a temporary file renamed into place) and on S3 (one PUT per object), so readers never see a torn conversion.

Rollback callbacks run in reverse registration order so created files are deleted in reverse. Each Media rollback callback deletes the files its call created before refreshing its record and invalidating its owner relation, and preserves both failures if deletion and refresh fail. Commit callbacks retain registration order. Applications using database rollback
callbacks must account for their reverse ordering.
