# Queueing Mail

## Basic Queueing

When using the queue feature, mails can be delayed and processed asynchronously:

```ts
await sendMail(invoicePaidMail)
  .onConnection('database')
  .onQueue('mail')
  .delay(300) // 5 minutes delay
  .afterCommit()
```

This requires the `@holo-js/queue` package to be installed.
If the configured queue connection uses an async driver, production also needs a supervised queue worker.
See [Deployment](/deployment) for host selection and [Queue Workers](/queue/workers) for worker commands.

## Queue Configuration

You can configure default queue settings in your mail configuration:

```ts
import { defineMailConfig } from '@holo-js/mail'

export default defineMailConfig({
  default: 'smtp',
  queue: {
    connection: 'database',
    queue: 'mail',
    // Whether to delay dispatch until after database commits
    afterCommit: true
  },
  mailers: {
    smtp: {
      driver: 'smtp'
      // ... smtp config
    }
  }
})
```

Queue connections are declared in `config/queue.ts`, independently of the selected mailer. Start a
worker for the selected connection and queue:

```bash
holo queue:work --connection database --queue mail
```

Holo registers mail delivery jobs when the worker boots; application code does not register them manually.

## Queue Options

### Delayed Delivery

```ts
// Delay delivery by 1 hour
await sendMail(invoicePaidMail)
  .delay(60 * 60)

// Delay using a Date object
await sendMail(invoicePaidMail)
  .delay(new Date(Date.now() + 3600000))
```

### Per-Mailer Queue Settings

Set `queued: true` on a mailer to queue its deliveries by default. The connection and queue identify
where its worker receives those jobs:

```ts
import { defineMailConfig } from '@holo-js/mail'

export default defineMailConfig({
  mailers: {
    smtp: {
      driver: 'smtp',
      queue: {
        queued: true,
        connection: 'database',
        queue: 'mail-high-priority'
      }
    }
  }
})
```

## How Queueing Works

1. When `.onQueue()` is called, the mail is serialized and placed on a queue
2. A queue worker processes the job by:
   - Reconstructing the mail from the serialized data
   - Sending it using the configured mailer
3. If `.afterCommit()` is used, the mail is only queued after database transactions commit
