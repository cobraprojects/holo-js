# Queueing Mail

Sending email over SMTP can take a second or more. Queue it so your route responds right away and a background worker delivers the mail.

```ts
import { sendMail } from '@holo-js/mail'
import WelcomeMail from '../mail/welcome'

await sendMail(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))
  .onQueue('mail')
```

## Before you start

Queued mail runs through [Holo queues](/queue/). Install them if you haven't:

```bash
npx holo install queue
```

Without `@holo-js/queue`, queueing or delaying a mail throws `Queued or delayed mail delivery requires @holo-js/queue to be installed`.

With the `sync` queue driver, queued mail is still delivered immediately in the same process. With an async driver such as `redis` or `database`, run a worker for the connection and queue you send to:

```bash
npx holo queue:work --connection redis --queue mail
```

Holo registers the mail delivery job for you. You don't write a job class for mail. See [Running workers](/queue/workers).

## Queue one send

Any of these queue the mail:

```ts
await sendMail(mail).onQueue('mail')
await sendMail(mail).onConnection('redis')
await sendMail(mail).delay(300)
```

`.delay()` takes seconds or a `Date`. See [Sending mail](/mail/sending#combine-options) for chaining.

## Queue a mail every time it's sent

Set `queue` in the definition. Use `true` to queue on the default connection, or an object to pick where:

```ts [server/mail/weekly-digest.ts]
import { defineMail } from '@holo-js/mail'

function WeeklyDigestMail(input: { readonly to: string }) {
  return defineMail({
    to: input.to,
    subject: 'Your weekly digest',
    markdown: '# This week',
    queue: { connection: 'redis', queue: 'digests' },
  })
}

export default WeeklyDigestMail
```

Set `queue: false` to force a mail to send immediately even when its mailer queues by default.

## Queue everything sent through a mailer

Set `queue` on a mailer, or at the top level of `config/mail.ts` for all mailers:

```ts [config/mail.ts]
import { defineMailConfig } from '@holo-js/mail'

export default defineMailConfig({
  default: 'smtp',
  queue: {
    connection: 'redis',
    queue: 'mail',
  },
  mailers: {
    smtp: {
      driver: 'smtp',
      queue: {
        queued: true,
        queue: 'mail-transactional',
      },
    },
  },
})
```

Setting `connection` or `queue` turns queueing on. Use `queued: true` to queue on the default connection and queue.

## Which setting wins

For each send, Holo decides whether to queue, and where, in this order:

1. Methods on the send: `.onConnection()`, `.onQueue()`, `.delay()`, `.afterCommit()`.
2. The mail's own `queue` and `delay`.
3. The mailer's `queue` in `config/mail.ts`.
4. The top-level `queue` in `config/mail.ts`.

## Wait for a transaction

Add `afterCommit` so a queued mail is only dispatched once the surrounding [transaction](/database/transactions) commits:

```ts
await sendMail(mail).onQueue('mail').afterCommit()
```

You can also set `afterCommit: true` in any `queue` option above.

## Retry a failed queued mail

Set `tries` to the total number of attempts, and `backoff` to the seconds to wait before each retry:

```ts
const mail = defineMail({
  to: 'ava@example.com',
  subject: 'Your invoice',
  markdown: '# Invoice',
  queue: { queue: 'mail', tries: 3, backoff: [10, 60] },
})
```

The first retry waits 10 seconds and the second waits 60. A single number such as `backoff: 30` waits that long before every retry. If `backoff` is not set, the worker's `--backoff` option applies. Mail that still fails after its last attempt goes to [failed jobs](/queue/failed-jobs).

## What the worker receives

Holo renders the mail before it goes on the queue. The worker sends the stored subject, HTML, text, recipients, and attachments; it doesn't call your mail function again. Changes you deploy to a mail file only affect mail queued after the deploy.

See [Attachments and queues](/mail/attachments#attachments-and-queues) for how files are stored with the job. Failed deliveries show up in [failed jobs](/queue/failed-jobs).

## Queue option reference

These keys work in `defineMail({ queue })`, on a mailer's `queue`, and on the top-level `queue`:

| Key | Type | Meaning |
| --- | --- | --- |
| `queued` | `boolean` | Queue even without a connection or queue name. |
| `connection` | `string` | Connection name from `config/queue.ts`. |
| `queue` | `string` | Queue name on that connection. |
| `afterCommit` | `boolean` | Wait for the current transaction to commit. |
| `tries` | `number` | Total attempts before the mail fails. Must be 1 or more. Defaults to 1. |
| `backoff` | `number` or `number[]` | Seconds to wait before each retry. Must be 0 or more. |

## Next steps

- [Running workers](/queue/workers)
- [Failed jobs](/queue/failed-jobs)
- [Sending mail](/mail/sending)
