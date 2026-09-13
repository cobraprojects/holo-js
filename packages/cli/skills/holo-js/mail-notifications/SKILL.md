---
name: holo-mail-notifications
description: Implement Holo-JS mail definitions, templates, attachments, previews, queueing, notification channels, stored notifications, and notification events.
metadata:
  type: focused
  source: https://docs.holo-js.com/notifications/
---

# Mail and notifications

Use [defining mail](https://docs.holo-js.com/mail/defining-mail), [sending and preview](https://docs.holo-js.com/mail/sending-and-preview), [attachments and drivers](https://docs.holo-js.com/mail/attachments-and-drivers), [mail queueing](https://docs.holo-js.com/mail/queueing-mail), [defining notifications](https://docs.holo-js.com/notifications/defining-notifications), [notification channels](https://docs.holo-js.com/notifications/notification-channels), [stored notifications](https://docs.holo-js.com/notifications/notification-storage), and [queued notifications](https://docs.holo-js.com/notifications/queueing-notifications).

## Choose the abstraction

- A mail object owns one email's subject, recipients, content, and attachments.
- A notification describes one user-facing fact and can fan out to mail, database, broadcast, or a custom channel.
- Use on-demand notifications when the recipient is not a persisted notifiable model.
- Queue delivery when the transport is slow or unreliable, after the source transaction commits.

```ts
await notify(user, invoicePaid).afterCommit()
```

## Delivery rules

- Pass durable identifiers to queued mail and notification work.
- Treat provider acceptance as different from user delivery.
- Avoid leaking sensitive data through subject lines, preview text, logs, or broadcast payloads.
- Make retryable delivery idempotent and record provider identifiers where reconciliation matters.
- Preview templates and verify attachment streams before enabling the real driver.

## Completion check

- Channel selection, queue behavior, templates, and recipient routing are explicit.
- Tests use Holo fakes and assert the message or notification contract, not provider internals.
- Failure, retry, duplicate delivery, and unsubscribe preferences are covered where applicable.
