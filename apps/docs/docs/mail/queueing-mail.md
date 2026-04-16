# Queueing Mail

## Basic Queueing

When using the queue feature, mails can be delayed and processed asynchronously:

```ts
await sendMail(invoicePaidMail)
  .onQueue('mail')
  .delay(300) // 5 minutes delay
  .afterCommit()
```

This requires the `@holo-js/queue` package to be installed.

## Queue Configuration

You can configure default queue settings in your mail configuration:

```ts
// config/mail.ts
export default defineMailConfig({
  default: 'smtp',
  queue: {
    connection: 'default',
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

You can set queue defaults per mailer:

```ts
// config/mail.ts
export default defineMailConfig({
  mailers: {
    smtp: {
      driver: 'smtp',
      queue: {
        connection: 'smtp-queue',
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