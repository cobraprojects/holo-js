# Sending Mails

## Basic Usage

Mails are sent using the `sendMail` function, which returns a fluent API for configuring delivery options.

```ts
import { sendMail } from '@holo-js/mail'
import { invoicePaidMail } from './mails'

await sendMail(invoicePaidMail)
```

## Fluent Configuration Options

The `sendMail` function returns a fluent builder that allows you to configure various aspects of the mail delivery:

### Choosing a Mailer

```ts
await sendMail(invoicePaidMail)
  .using('smtp')
```

### Specifying a Connection

```ts
await sendMail(invoicePaidMail)
  .onConnection('smtp-production')
```

### Queueing

```ts
await sendMail(invoicePaidMail)
  .onQueue('mail')
```

### Delayed Delivery

```ts
// Delay delivery by 1 hour
await sendMail(invoicePaidMail)
  .delay(60 * 60)

// Delay using a Date object
await sendMail(invoicePaidMail)
  .delay(new Date(Date.now() + 3600000))
```

### Transaction Awareness

```ts
await sendMail(invoicePaidMail)
  .afterCommit()
```