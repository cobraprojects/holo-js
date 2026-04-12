# Sending And Preview

`sendMail(...)` is lazy and fluent. `previewMail(...)` is immediate. `renderMailPreview(...)` returns a `Response`
for explicit browser preview routes.

## Sending mail

```ts
import { sendMail } from '@holo-js/mail'
import welcomeMail from '../../server/mail/welcome'

await sendMail(welcomeMail({
  to: 'ava@example.com',
  name: 'Ava',
}))
  .using('smtp')
  .onQueue('mail')
  .delay(300)
  .afterCommit()
```

The fluent send API supports:

- `.using(name)`
- `.onConnection(name)`
- `.onQueue(name)`
- `.delay(value)`
- `.afterCommit()`

## Previewing mail in code

Use `previewMail(...)` when tests or tooling need the normalized preview result:

```ts
import { previewMail } from '@holo-js/mail'
import welcomeMail from '../../server/mail/welcome'

const preview = await previewMail(welcomeMail({
  to: 'ava@example.com',
  name: 'Ava',
}))
```

The preview result includes:

- resolved sender and recipients
- rendered `html`
- rendered `text` when present
- attachment metadata
- source metadata

## Browser preview routes

Use `renderMailPreview(...)` inside a normal route handler:

```ts
import { renderMailPreview } from '@holo-js/mail'
import welcomeMail from '../../../server/mail/welcome'

export async function GET() {
  return renderMailPreview(welcomeMail({
    to: 'ava@example.com',
    name: 'Ava',
  }))
}
```

Preview formats:

- `html`
- `json`
- `text`

Example:

```ts
return renderMailPreview(welcomeMail({
  to: 'ava@example.com',
  name: 'Ava',
}), {
  format: 'json',
})
```

Browser preview is development-only by default. `renderMailPreview(...)` returns `403` when preview is disabled.

## Fake, preview, and log drivers

- `fake` captures sent mail in memory for tests
- `preview` stores preview artifacts locally
- `log` writes a summary to logs

These drivers are normal selectable mailers:

```ts
await sendMail(welcomeMail({
  to: 'ava@example.com',
  name: 'Ava',
})).using('preview')
```

## Continue

- [Defining Mail](/mail/defining-mail)
- [Attachments And Drivers](/mail/attachments-and-drivers)
