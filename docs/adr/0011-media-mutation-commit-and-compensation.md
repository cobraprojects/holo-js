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

Regeneration never overwrites a stored file. Each regeneration writes its conversions to new, unique paths (the planned path with a random suffix, such as `thumb.3f9a1c0e.webp`), before its transaction starts. Compensation deletes those files on any failure before commit, the same as for an attachment. Inside the transaction, Holo locks the media row (`SELECT … FOR UPDATE` on MySQL and Postgres; SQLite root write transactions already run as `BEGIN IMMEDIATE`), reads the current `generated_conversions`, and swaps in this call's entries. The row then names exactly the bytes this call wrote. After commit, Holo deletes the paths it read under the lock that the new entries replaced, and never a path read outside it. Explicit deletion commits the record removal before removing its stored files; a cleanup failure retains the deletion and reports commitment. Queued regeneration dispatch runs after commitment.

Overlapping regenerations of one media item each write to their own paths. Whichever commits last reads the other's entries under the lock, so the row always names the files of the last commit, and the files it replaced are deleted after that commit. A regeneration that fails leaves the committed row and its files untouched. Writes are atomic on the local disk (a temporary file renamed into place) and on S3 (one PUT per object), so readers never see a torn file. The file name stored in the row is what URLs and paths resolve, so a regenerated conversion gets a new URL.

Rollback callbacks run in reverse registration order so created files are deleted in reverse. Each Media rollback callback deletes the files its call created before refreshing its record and invalidating its owner relation, and preserves both failures if deletion and refresh fail. Commit callbacks retain registration order. Applications using database rollback
callbacks must account for their reverse ordering.
