# Defining Events

An event is a named signal with a typed payload. You define it once with `defineEvent()` and then dispatch it from anywhere in your server code.

## Create an event

```bash
npx holo make:event billing/invoice-paid
```

This creates `server/events/billing/invoice-paid.ts`:

```ts [server/events/billing/invoice-paid.ts]
import { defineEvent } from '@holo-js/events'

export default defineEvent<Record<string, unknown>>({
  name: 'billing.invoice-paid',
})
```

Replace `Record<string, unknown>` with the shape of your payload:

```ts [server/events/billing/invoice-paid.ts]
import { defineEvent } from '@holo-js/events'

export default defineEvent<{
  invoiceId: string
  amountCents: number
}>({
  name: 'billing.invoice-paid',
})
```

The type parameter is the payload type. Every dispatch and every listener for this event uses it.

## Named and default exports

An event file can use a default export, a named export, or both:

```ts [server/events/blog/post-saved.ts]
import { defineEvent } from '@holo-js/events'

export const PostSaved = defineEvent<{
  action: 'created' | 'updated' | 'deleted'
  postId: number
}>({
  name: 'blog.post.saved',
})

export default PostSaved
```

## Naming events

Give every event an explicit `name`. Use domain-style names that describe what happened:

- `user.registered`
- `billing.invoice-paid`
- `subscription.canceled`

The name identifies the event in listeners, in queued jobs, and in failed-job records. Keep it stable even if you move the file. Surrounding whitespace is trimmed.

### Literal name types for multi-event listeners

To let TypeScript narrow on `event.name` in a [listener that handles several events](/events/listeners#listen-to-several-events), pass the name as a second type parameter:

```ts [server/events/user/deleted.ts]
import { defineEvent } from '@holo-js/events'

export default defineEvent<{ userId: string }, 'user.deleted'>({
  name: 'user.deleted',
})
```

Without it, `event.name` is typed as `string`.

## Names derived from the file path

If you leave out `name`, Holo derives one from the file path under `server/events`. Folders and the file name are joined with dots:

| File | Event name |
| --- | --- |
| `server/events/billing/invoice-paid.ts` | `billing.invoice-paid` |
| `server/events/user/registered.ts` | `user.registered` |

::: warning
An event without an explicit `name` can't be dispatched through its definition. `InvoicePaid.dispatch(...)` throws `Dispatching an event definition requires an explicit event name.` You would have to dispatch it by string with `dispatchEvent('billing.invoice-paid', payload)`. Set `name` to avoid this.
:::

## Duplicate names

Each event name must be unique. If two files resolve to the same name, whether explicit or derived from the path, discovery fails with a duplicate event error. Rename one of them.

## Payloads

Keep payloads small and made of plain data: IDs, strings, numbers, booleans, arrays, and plain objects. Sync listeners accept any value, but as soon as one listener for the event is [queued](/events/queued-listeners), the payload must be JSON-serializable.

Pass a model's ID rather than the model itself, and load fresh data in the listener.

## Next steps

- [Listeners](/events/listeners)
- [Dispatching Events](/events/dispatching)
- [API Reference](/events/api-reference)
