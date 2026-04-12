# Attachments And Drivers

Attachments are part of the core mail model. Drivers stay behind the normalized runtime contract.

## Attachment helpers

Use the helper builders for the common attachment sources:

```ts
import {
  attachContent,
  attachFromPath,
  attachFromStorage,
  defineMail,
} from '@holo-js/mail'

const invoiceMail = defineMail({
  to: 'ava@example.com',
  subject: 'Invoice ready',
  markdown: '# Invoice ready',
  attachments: [
    attachFromPath('/tmp/invoice.pdf'),
    attachFromStorage('reports/invoice-100.pdf', { disk: 'public' }),
    attachContent('hello', { name: 'welcome.txt' }),
  ],
})
```

Storage-backed attachments align with normal `Storage` usage patterns. When a safe local path is available, mail
can use it directly. Otherwise the runtime falls back to bytes.

## Inline attachments

Inline attachments use `disposition: 'inline'` and require `contentId`:

```ts
attachFromPath('/tmp/logo.png', {
  disposition: 'inline',
  contentId: 'logo',
})
```

## Driver behavior

Built-in driver summary:

- `preview`: stores append-only preview artifacts
- `log`: writes summary output and can optionally include bodies
- `fake`: captures sent mail in memory for tests
- `smtp`: delivers mail through SMTP

## SMTP sending

Select the SMTP mailer explicitly when needed:

```ts
await sendMail(invoiceMail).using('smtp')
```

SMTP maps:

- resolved recipients and sender fields
- rendered `html` and `text`
- headers, tags, metadata, and priority where supported
- path, content, and storage-backed attachments

## Queueing and delay

Mail definitions may declare `queue` and `delay`, and send-time overrides can still change them:

```ts
await sendMail(invoiceMail)
  .using('smtp')
  .onQueue('mail')
  .delay(new Date('2026-05-01T09:00:00.000Z'))
```

Queued mail keeps rendered content stable and resolves queue-safe attachments in the worker.

## Notifications and auth

- notifications email delivery routes into mail when both packages are installed
- auth uses mail directly when notifications are absent and mail is installed

That keeps one mail subsystem for direct mail, auth delivery, and notification email transport.
