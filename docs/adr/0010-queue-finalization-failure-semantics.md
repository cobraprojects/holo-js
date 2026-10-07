# Separate Queue adapter finalization failures from job retries

A reserved job's acknowledgement, release, or terminal failure will have one finalization path, and a failure in that adapter operation will be reported without re-entering handler retry logic or blindly repeating the mutation. We chose this distinction because an adapter failure can leave delivery uncertain even after a successful handler, while job retry rules describe handler outcomes. Existing handler retries, lifecycle hooks, and adapter reservation semantics remain in force; delivery may repeat according to those reservation semantics.

Finalization failure stops the worker and rejects `runQueueWorker` with the original adapter error through its existing interface. Job completion hooks retain their position before acknowledgement, and worker processed hooks run only after successful acknowledgement.
