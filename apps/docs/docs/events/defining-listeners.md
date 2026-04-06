# Defining Listeners

Define listeners with `defineListener(...)` from `@holo-js/events`.

## Single-event listener

```ts
import { defineListener } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  async handle(event) {
    await analytics.track('user.registered', {
      userId: event.payload.userId,
    })
  },
})
```

`handle(event)` receives an envelope with:

- `event.name`
- `event.payload`
- `event.occurredAt`

## Listener identity

Listeners can have an explicit `name`:

```ts
export default defineListener({
  name: 'users.send-welcome-email',
  listensTo: [UserRegistered],
  async handle(event) {
    await mailer.sendWelcome(event.payload.email)
  },
})
```

If `name` is omitted for discovered app listeners, Holo-JS derives an id from the file path under
`server/listeners`.

## Queued listener options

Set `queue: true` for queued execution:

```ts
export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  connection: 'redis',
  queueName: 'emails',
  delay: 30,
  async handle(event) {
    await mailer.sendWelcome(event.payload.email)
  },
})
```

Queued metadata fields:

- `connection`
- `queueName`
- `delay`

These require `queue: true`.

## Listener-level `afterCommit`

Listener-level deferral:

```ts
export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  afterCommit: true,
  async handle(event) {
    await projections.syncUser(event.payload.userId)
  },
})
```

This defers only this listener when a transaction is active.

## Continue

- [Multi-Event Listeners](/events/multi-event-listeners)
- [Queued Listeners](/events/queued-listeners)
