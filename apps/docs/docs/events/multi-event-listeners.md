# Multi-Event Listeners

A listener can subscribe to one event or many events.

## Example

```ts
import { defineListener } from '@holo-js/events'
import UserRegistered from '../events/user/registered'
import UserDeleted from '../events/user/deleted'

export default defineListener({
  listensTo: [UserRegistered, UserDeleted] as const,
  async handle(event) {
    if (event.name === 'user.registered') {
      await audit.log('registered', event.payload.userId)
      return
    }

    if (event.name === 'user.deleted') {
      await audit.log('deleted', event.payload.userId)
    }
  },
})
```

## Notes

- listener registration expands to both event names internally
- one listener id, many event index entries
- listener execution order is deterministic by registration order per event

## Event references

`listensTo` accepts:

- event definitions (`defineEvent(...)` return values)
- explicit event name strings

String references must be non-empty normalized event names.

## Continue

- [Defining Listeners](/events/defining-listeners)
- [Dispatching Events](/events/dispatching-events)
