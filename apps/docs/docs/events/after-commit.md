# After-Commit Events

When you dispatch an event inside a database transaction, listeners normally run right away, before the transaction commits. If the transaction then rolls back, those listeners have already acted on data that doesn't exist. After-commit dispatch waits until the transaction commits, and drops the work if it rolls back.

```ts [server/lib/users.ts]
import { DB } from '@holo-js/db'
import UserRegistered from '../events/user/registered'

await DB.transaction(async () => {
  await DB.table('users').insert({ id: 'user_1', email: 'ava@example.com' })

  await UserRegistered.dispatch({
    userId: 'user_1',
    email: 'ava@example.com',
  }).afterCommit()
})
```

The listeners for `user.registered` run after the `users` row is committed.

## When to use it

Use after-commit when a listener needs to see committed data or must not run if the save fails:

- A queued listener loads the record by ID. Without after-commit, a fast worker can run before the row is visible.
- A listener sends email, charges a card, or calls another service.
- A listener updates a search index or a cached projection.

## Defer one dispatch

Chain `.afterCommit()` on a dispatch to defer **every** listener for that dispatch, sync and queued:

```ts [server/lib/orders.ts]
import { DB } from '@holo-js/db'
import OrderPlaced from '../events/orders/placed'

await DB.transaction(async () => {
  await OrderPlaced.dispatch({ orderId: 'ord_1' }).afterCommit()
})
```

## Defer one listener

Set `afterCommit: true` on a listener to defer only that listener, every time its event is dispatched:

```ts [server/listeners/search/index-user.ts]
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  afterCommit: true,
  async handle(event) {
    console.log(`Index user ${event.payload.userId}`)
  },
})
```

Other listeners for the same event still run immediately. This works for both sync and queued listeners.

## How it behaves

| Situation | Result |
| --- | --- |
| Inside a transaction that commits | Deferred listeners run after the commit. |
| Inside a transaction that rolls back | Deferred listeners never run. |
| Outside any transaction | Listeners run immediately, as if `afterCommit` wasn't set. |

You can check the dispatch result: `deferred` is `true` when some or all listeners are waiting for a commit.

```ts [server/lib/users.ts]
import { DB } from '@holo-js/db'
import UserRegistered from '../events/user/registered'

await DB.transaction(async () => {
  const result = await UserRegistered.dispatch({
    userId: 'user_1',
    email: 'ava@example.com',
  }).afterCommit()

  console.log(result.deferred)
})
```

## Nested transactions

Deferred work waits for the outermost transaction to commit. Committing an inner transaction doesn't run it early.

If an inner transaction rolls back, work deferred inside it is dropped, even if the outer transaction goes on to commit. Work deferred in the outer transaction is not affected.

::: warning
Payload checks still happen at dispatch time. If an event has queued listeners and the payload isn't JSON-serializable, `dispatch()` throws inside the transaction, before anything is deferred.
:::

## Next steps

- [Database Transactions](/database/transactions)
- [Queued Listeners](/events/queued-listeners)
- [Dispatching Events](/events/dispatching)
