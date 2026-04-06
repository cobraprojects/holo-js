# Transactions And After Commit

Events support commit-aware deferral at two levels:

- dispatch-level `.afterCommit()`
- listener-level `afterCommit: true`

`afterCommit` is opt-in.

## Dispatch-level deferral

Defer the full dispatch fan-out:

```ts
import { DB } from '@holo-js/db'
import { Event } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await DB.transaction(async () => {
  await Event.dispatch(UserRegistered, {
    userId: 'user_1',
    email: 'ava@example.com',
  }).afterCommit()
})
```

All listeners for that dispatch are scheduled for post-commit execution.

## Listener-level deferral

Defer only selected listeners:

```ts
export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  afterCommit: true,
  async handle(event) {
    await readModelProjections.refresh(event.payload.userId)
  },
})
```

Other listeners for the same event can still run immediately.

## Behavior matrix

- active transaction + `afterCommit`: execution is deferred until commit
- rollback: deferred listener work is discarded
- no active transaction: dispatch proceeds immediately

## Nested transactions

Deferral follows DB transaction lifecycle and waits for root commit. Nested transactions or savepoints do
not prematurely run deferred listeners.

## Why this exists

Use `afterCommit` when listeners must observe committed state:

- queue workers loading fresh DB records by id
- read-model projection updates
- external side effects that should not happen if the transaction rolls back

## Continue

- [Dispatching Events](/events/dispatching-events)
- [Queued Listeners](/events/queued-listeners)
- [Database Transactions](/database/transactions)
