# Mail

Holo-JS mail is a first-class outbound mail subsystem. It owns mail definitions, browser preview helpers,
built-in drivers, attachments, and fluent delivery orchestration.

Use `@holo-js/mail` when the application needs direct email delivery, browser preview routes, queued mail, or
storage-backed attachments.

## What mail owns

The `@holo-js/mail` package owns:

- mail definitions through `defineMail(...)`
- fluent sending through `sendMail(...)`
- browser preview helpers through `previewMail(...)` and `renderMailPreview(...)`
- built-in `preview`, `log`, `fake`, and `smtp` drivers
- Markdown mail and view-backed mail
- attachment modeling and resolution
- delayed and queued delivery orchestration

Mail does not own application notifications. Notifications stay in `@holo-js/notifications`, and core bridges
notification email delivery into mail only when both packages are installed.

## Quick start

```ts
import { defineMail, sendMail } from '@holo-js/mail'

const welcomeMail = (input: { to: string, name: string }) => defineMail({
  to: input.to,
  subject: `Welcome, ${input.name}`,
  markdown: [
    '# Welcome',
    '',
    `Hello ${input.name},`,
    '',
    'Your account is ready.',
  ].join('\n'),
})

await sendMail(welcomeMail({
  to: 'ava@example.com',
  name: 'Ava',
})).using('preview')
```

## Package boundaries

- `@holo-js/mail` owns mail contracts, rendering, preview helpers, drivers, and send orchestration.
- `@holo-js/queue` owns queue runtime and worker behavior when mail is queued.
- `@holo-js/storage` owns storage-backed file resolution for attachments.
- `@holo-js/core` owns optional runtime boot, server-view rendering integration, and auth/notifications bridges.

## Continue

- [Setup And CLI](/mail/setup-and-cli)
- [Defining Mail](/mail/defining-mail)
- [Sending And Preview](/mail/sending-and-preview)
- [Attachments And Drivers](/mail/attachments-and-drivers)
