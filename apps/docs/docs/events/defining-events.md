# Defining Events

Define events with `defineEvent(...)` from `@holo-js/events`.

## Recommended: explicit event names

Use explicit `name` values for stability:

```ts
import { defineEvent } from '@holo-js/events'

export default defineEvent<{
  userId: string
  email: string
}>({
  name: 'user.registered',
})
```

Event names are normalized by trimming surrounding whitespace.

## Path-derived fallback names

Discovered app events can omit `name`. In that case, Holo-JS derives the name from the file path under
`server/events`.

Example:

- `server/events/billing/invoice-paid.ts` -> `billing.invoice-paid`

```ts
import { defineEvent } from '@holo-js/events'

export default defineEvent<{
  invoiceId: string
}>({})
```

Fallback names are convenience only. Explicit names are preferred for long-term contracts.

## Name collisions

Event registration identity is the final normalized event name. If two discovered events resolve to the
same final name, discovery fails with a duplicate event error.

This includes collisions between:

- explicit names
- path-derived names
- explicit and path-derived names

## Naming guidance

- use domain-style names: `user.registered`, `invoice.paid`, `subscription.canceled`
- avoid implementation or path-only names
- keep names stable even if files move

## Continue

- [Defining Listeners](/events/defining-listeners)
- [Dispatching Events](/events/dispatching-events)
