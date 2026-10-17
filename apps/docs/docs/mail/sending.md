# Sending Mail

`sendMail()` delivers a mail through your default mailer. Chain methods onto it to pick another mailer, delay delivery, or wait for a database transaction to commit.

```ts
import { sendMail } from '@holo-js/mail'
import OrderShippedMail from '../mail/order-shipped'

await sendMail(OrderShippedMail({
  to: 'ava@example.com',
  orderNumber: 'A-1001',
  trackingUrl: 'https://track.example.com/A-1001',
}))
```

Nothing is sent until you `await` the result (or call `.then()`).

## Send without a mail file

`sendMail()` also accepts the options object directly. This is handy for one-off messages:

```ts
await sendMail({
  to: 'ops@example.com',
  subject: 'Nightly import finished',
  text: 'Imported 1,204 orders.',
})
```

## Override fields at send time

Pass a second argument to change fields of an existing mail for this send only. Headers and metadata are merged; other fields replace the original value.

```ts
await sendMail(OrderShippedMail(input), {
  cc: 'warehouse@example.com',
  replyTo: 'orders@example.com',
})
```

## Recipients, sender, and reply-to

Set `to`, `cc`, `bcc`, `from`, and `replyTo` when you write the mail, or override them as shown above. See [Writing mail](/mail/writing-mail#recipients) for the accepted formats.

## Choose a mailer

`.using()` sends through a named mailer from `config/mail.ts` instead of the default:

```ts
await sendMail(OrderShippedMail(input)).using('smtp')
```

You can also set `mailer: 'smtp'` in `defineMail()`. `.using()` wins over both. Using a name that isn't configured throws `Mailer "..." is not configured`.

## Delay delivery

`.delay()` takes a number of seconds or a `Date`:

```ts
await sendMail(OrderShippedMail(input)).delay(10 * 60)

await sendMail(OrderShippedMail(input)).delay(new Date('2026-12-01T09:00:00Z'))
```

A delayed mail is always queued, so it needs `@holo-js/queue` and a running worker for async queue drivers. See [Queueing mail](/mail/queueing).

## Send after a transaction commits

Inside a [database transaction](/database/transactions), `.afterCommit()` holds the mail until the transaction commits. If the transaction rolls back, nothing is sent.

```ts
import { DB } from '@holo-js/db'
import { sendMail } from '@holo-js/mail'

await DB.transaction(async () => {
  const order = await createOrder(input)

  await sendMail(OrderConfirmationMail({ to: input.email, orderNumber: order.number }))
    .afterCommit()
})
```

Outside a transaction, `.afterCommit()` sends right away.

## Combine options

The methods can be chained in any order:

```ts
await sendMail(InvoiceMail(invoice))
  .using('smtp')
  .onConnection('redis')
  .onQueue('mail')
  .delay(300)
  .afterCommit()
```

| Method | Effect |
| --- | --- |
| `.using(name)` | Send through this mailer. |
| `.onConnection(name)` | Queue on this connection from `config/queue.ts`. |
| `.onQueue(name)` | Queue on this queue name. |
| `.delay(value)` | Queue and wait this many seconds, or until this `Date`. |
| `.afterCommit()` | Wait for the current transaction to commit. |

Calling `.onConnection()`, `.onQueue()`, or `.delay()` always queues the mail.

## The send result

The awaited value tells you what happened:

```ts
const result = await sendMail(OrderShippedMail(input))

result.messageId
result.mailer
result.driver
result.queued
result.providerMessageId
```

| Field | Meaning |
| --- | --- |
| `messageId` | ID Holo generated for this send. |
| `mailer`, `driver` | The mailer and driver that handled it. |
| `queued` | `true` if the mail was put on the queue instead of sent now. |
| `deferred` | `true` if delivery is waiting for a transaction to commit. |
| `providerMessageId` | The ID returned by the SMTP server, when available. |
| `provider` | Extra details from the driver. For SMTP, `response` holds the server's reply. |

## Handle failures

If the driver fails, `sendMail()` rejects with a `MailSendError`. The original error is on `cause`:

```ts
import { MailSendError, sendMail } from '@holo-js/mail'

try {
  await sendMail(OrderShippedMail(input))
} catch (error) {
  if (error instanceof MailSendError) {
    console.error('Mail delivery failed', error.cause)
  }
  throw error
}
```

## Available methods

Call `sendMail()` first, then chain any of these methods before you `await` the result.

**Sending**

- [sendMail()](#sendmail)
- [mail (default export)](#mail-default-export)

**Chain methods**

- [using()](#using)
- [onConnection()](#onconnection)
- [onQueue()](#onqueue)
- [delay()](#delay)
- [afterCommit()](#aftercommit)

**Promise methods**

- [then(), catch(), and finally()](#then-catch-and-finally)

**Errors**

- [MailError](#mailerror)
- [MailSendError](#mailsenderror)

### sendMail()

Starts a send and returns a pending send you can chain on. Pass a mail from `defineMail()` or a plain options object. The optional second argument overrides fields for this send only.

```ts
await sendMail(OrderShippedMail(input), { cc: 'warehouse@example.com' })
```

Headers and metadata are merged with the mail's own values. Other overrides replace the mail's value.

### mail (default export)

The package's default export groups `sendMail`, `previewMail`, and `renderMailPreview` in one object.

```ts
import mail from '@holo-js/mail'

await mail.sendMail({ to: 'ops@example.com', subject: 'Import finished', text: 'Done.' })
```

### using()

Sends through the named mailer from `config/mail.ts`. It overrides the `mailer` option in `defineMail()`. An empty name throws, and so does a name that isn't configured.

```ts
await sendMail(OrderShippedMail(input)).using('smtp')
```

### onConnection()

Queues the mail on the named connection from `config/queue.ts`. Calling it always queues the mail.

```ts
await sendMail(OrderShippedMail(input)).onConnection('redis')
```

### onQueue()

Queues the mail on the named queue. Calling it always queues the mail.

```ts
await sendMail(OrderShippedMail(input)).onQueue('mail')
```

### delay()

Queues the mail and holds it until a number of seconds have passed, or until a `Date`. This overrides a `delay` set in `defineMail()`. Negative numbers and invalid dates throw.

```ts
await sendMail(OrderShippedMail(input)).delay(300)
```

### afterCommit()

Holds the send until the current database transaction commits. If the transaction rolls back, nothing is sent. Outside a transaction, the mail sends right away.

```ts
await DB.transaction(async () => {
  await sendMail(OrderShippedMail(input)).afterCommit()
})
```

### then(), catch(), and finally()

A pending send is promise-like. `await` it, or call these methods directly. Sending starts on the first call, and later calls reuse the same result, so the mail is never sent twice.

```ts
await sendMail(OrderShippedMail(input))
  .catch(error => console.error('Mail failed', error))
```

### MailError

The base class for errors raised by this package. Each error has a `code` string you can check, such as `MAILER_NOT_CONFIGURED`, `MAIL_DRIVER_NOT_REGISTERED`, `MAIL_FROM_MISSING`, or `MAIL_ATTACHMENT_UNSAFE_PATH`.

```ts
import { MailError } from '@holo-js/mail'

if (error instanceof MailError && error.code === 'MAIL_FROM_MISSING') {
  console.error('Set a default sender in config/mail.ts')
}
```

### MailSendError

Thrown when a driver fails to deliver a mail. It extends `MailError` and adds `messageId`, `mailer`, and `driver`. The original error is on `cause`.

```ts
import { MailSendError } from '@holo-js/mail'

if (error instanceof MailSendError) {
  console.error(error.mailer, error.driver, error.cause)
}
```

## Next steps

- [Queueing mail](/mail/queueing)
- [Attachments](/mail/attachments)
- [Drivers](/mail/drivers)
