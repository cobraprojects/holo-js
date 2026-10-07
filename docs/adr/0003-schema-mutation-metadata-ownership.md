# Pair schema mutation and metadata outcomes

The schema mutation module will own execution and metadata consistency, including nested transaction rollback and dialect-specific DDL outcomes. A failed operation restores the preceding metadata state rather than deleting a definition explicitly registered before the operation; subsequent operations inside a transaction see its changes. This preserves declared schemas while preventing failed mutations from leaving metadata changes that the database did not retain.

Where a dialect retains earlier DDL after a later operation fails, metadata retains those successful changes. Restoring preceding metadata applies only to mutations the database actually rolled back; the failure must not imply that the whole mutation was undone. Existing schema mutation interfaces remain unchanged.
