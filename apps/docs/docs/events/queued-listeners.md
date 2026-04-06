# Queued Listeners

Queued listeners are listener definitions with `queue: true`.

```ts
import { defineListener } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  queueName: 'emails',
  async handle(event) {
    await mailer.sendWelcome(event.payload.email)
  },
})
```

## Internal model

Queued listeners run through queue using one internal job:

- `holo.events.invoke-listener`

Queue payload includes:

- listener id
- event name
- event payload
- `occurredAt`

This keeps events listener-first while reusing queue runtime, retries, and failure behavior.

## Connection and queue resolution

Priority order:

1. dispatch overrides (`.onConnection(...)`, `.onQueue(...)`, `.delay(...)`)
2. listener defaults (`connection`, `queueName`, `delay`)
3. queue connection defaults from `config/queue.ts`

## Serialization requirements

If any queued listeners are selected for a dispatch, event payload must be JSON-serializable.

Good payloads:

- ids
- strings
- numbers
- booleans
- arrays
- plain objects

Avoid:

- class instances
- functions
- symbols
- circular references
- model instances

## Retry and failure behavior

Queued listeners inherit queue retry/failure behavior because they run inside queue jobs.

- retries follow queue driver and worker behavior
- failures are treated as queue job failures
- failed-job tooling (`queue:failed`, `queue:retry`, `queue:forget`, `queue:flush`) applies to queued listeners too

## Relation to queue jobs

Use queue jobs when you are modeling an executable job explicitly.

Use queued listeners when work is a reaction to events and you want event fan-out semantics.

## Continue

- [Queue Getting Started](/queue/)
- [Queue Jobs](/queue/jobs)
- [Transactions And After Commit](/events/transactions-after-commit)
