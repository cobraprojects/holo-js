# Testing Mail

Use the `fake` mailer in tests. It records every mail in memory instead of sending it, so you can assert who got what.

```ts [tests/registration.test.ts]
import { afterEach, expect, it } from 'vitest'
import { listFakeSentMails, resetFakeSentMails } from '@holo-js/mail'
import { registerUser } from '../server/lib/registration'

afterEach(() => {
  resetFakeSentMails()
})

it('sends a welcome email after registration', async () => {
  await registerUser({ email: 'ava@example.com', name: 'Ava' })

  const sent = listFakeSentMails()

  expect(sent).toHaveLength(1)
  expect(sent[0]?.mail.subject).toBe('Welcome, Ava')
  expect(sent[0]?.mail.to).toEqual([{ email: 'ava@example.com' }])
})
```

## Use the fake mailer in tests

Set the default mailer to `fake` in your test environment. With the scaffolded `config/mail.ts`, that's one variable:

```ini [.env.test]
MAIL_MAILER=fake
```

See [Testing your app](/testing/) for how test environments and env files are loaded.

## Inspect sent mail

`listFakeSentMails()` returns one record per sent mail, oldest first:

| Field | Contents |
| --- | --- |
| `mail` | The rendered mail: `from`, `replyTo`, `to`, `cc`, `bcc`, `subject`, `html`, `text`, `attachments`, `headers`, `tags`, `metadata`, `priority`. |
| `messageId` | The ID Holo generated for the send. |
| `createdAt` | When the fake received it. |
| `context` | The `mailer` and `driver` used, and whether it was `queued`. |
| `result` | The value `sendMail()` resolved with. |

Addresses are normalized: lowercased, with `name` only present when you set one.

```ts
const [welcome] = listFakeSentMails()

expect(welcome?.mail.html).toContain('<h1>Welcome</h1>')
expect(welcome?.mail.text).toContain('Your account is ready.')
expect(welcome?.mail.attachments.map(file => file.name)).toEqual(['invoice.pdf'])
```

Call `resetFakeSentMails()` between tests so records from one test don't leak into the next.

## Test a mail on its own

To check a mail's content without running the code that sends it, render it with [`previewMail()`](/mail/previewing#preview-in-code):

```ts
import { expect, it } from 'vitest'
import { previewMail } from '@holo-js/mail'
import OrderShippedMail from '../server/mail/order-shipped'

it('links to the tracking page', async () => {
  const preview = await previewMail(OrderShippedMail({
    to: 'ava@example.com',
    orderNumber: 'A-1001',
    trackingUrl: 'https://track.example.com/A-1001',
  }))

  expect(preview.subject).toBe('Order A-1001 has shipped')
  expect(preview.html).toContain('href="https://track.example.com/A-1001"')
})
```

## Queued mail in tests

The fake records mail in the process that actually delivers it. Use the `sync` queue driver in tests so queued mail is delivered right away and shows up in `listFakeSentMails()`. With an async queue driver, the mail would be delivered later by a worker process and never reach the test's fake.

## Notification emails

Email [notifications](/notifications/) are delivered through mail, so they also appear in `listFakeSentMails()`. See [Testing notifications](/notifications/testing).

## Helper reference

| Helper | What it does |
| --- | --- |
| `listFakeSentMails()` | Returns every mail the `fake` mailer recorded, oldest first. |
| `resetFakeSentMails()` | Clears the `fake` mailer's records. |
| `listPreviewMailArtifacts()` | Returns every mail the `preview` mailer recorded in this process. See [Previewing mail](/mail/previewing#save-every-sent-email). |
| `resetPreviewMailArtifacts()` | Clears the in-memory preview records. It doesn't delete the files. |

## Next steps

- [Faking services](/testing/fakes)
- [Previewing mail](/mail/previewing)
