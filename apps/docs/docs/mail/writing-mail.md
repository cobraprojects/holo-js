# Writing Mail

A mail in Holo is a plain value built by `defineMail()`. It holds the recipients, the subject, and the body. Wrap it in a function so callers can pass in the data each email needs.

```ts [server/mail/order-shipped.ts]
import { defineMail } from '@holo-js/mail'

export type OrderShippedMailInput = {
  readonly to: string
  readonly orderNumber: string
  readonly trackingUrl: string
}

function OrderShippedMail(input: OrderShippedMailInput) {
  return defineMail({
    to: input.to,
    subject: `Order ${input.orderNumber} has shipped`,
    markdown: [
      '# Your order is on its way',
      '',
      `Track it here: [${input.trackingUrl}](${input.trackingUrl})`,
    ].join('\n'),
  })
}

export default OrderShippedMail
```

## Generate a mail file

```bash
npx holo make:mail order-shipped
```

This creates `server/mail/order-shipped.ts` with an `OrderShippedMail` function and an `OrderShippedMailInput` type. Use a path to group mail into folders:

```bash
npx holo make:mail auth/verify-email
```

That creates `server/mail/auth/verify-email.ts` exporting `VerifyEmailMail`. The generated file uses a Markdown body. `--markdown` is accepted but is already the default.

## Recipients

`to` is required. `cc` and `bcc` are optional. Each accepts an email string, an object with `email` and an optional `name`, or an array mixing both:

```ts
defineMail({
  to: [
    'ava@example.com',
    { email: 'ben@example.com', name: 'Ben Carter' },
  ],
  cc: 'accounts@example.com',
  bcc: { email: 'audit@example.com', name: 'Audit' },
  subject: 'Invoice INV-100',
  text: 'Your invoice is attached.',
})
```

Holo lowercases addresses and removes duplicates within each list. An address that isn't a valid email throws when you call `defineMail()`.

## Sender and reply-to

Most apps set one sender in `config/mail.ts`. Override it for a single mail with `from` and `replyTo`:

```ts
defineMail({
  to: 'ava@example.com',
  from: { email: 'support@example.com', name: 'Acme Support' },
  replyTo: 'help@example.com',
  subject: 'We received your request',
  text: 'A support agent will reply within one business day.',
})
```

Holo picks the sender in this order: the mail's `from`, then the mailer's `from`, then the top-level `from` in `config/mail.ts`. Reply-to follows the same order and falls back to the sender. Sending fails if no sender is set anywhere.

## Content

Give each mail exactly one main body. Holo throws if you set none or more than one.

| Option | Use it for |
| --- | --- |
| `markdown` | Most transactional email. Holo converts it to HTML and builds a plain-text version for you. See [Markdown mail](/mail/markdown). |
| `html` | A full HTML body you wrote or generated yourself. |
| `text` | Plain-text-only email. |
| `render` | HTML rendered from a view: `{ view: 'emails/welcome', props: { ... } }`. |

You can add `text` next to `html`, `markdown`, or `render` to supply your own plain-text version:

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Password changed',
  html: '<p>Your password was changed. If this wasn\'t you, contact support.</p>',
  text: 'Your password was changed. If this wasn\'t you, contact support.',
})
```

::: warning
`render` (and Markdown wrappers) need a view renderer, and the default Next.js, Nuxt, and SvelteKit setups don't provide one. Sending a `render` mail without one throws `Mail view rendering requires a renderView runtime binding`. Use `markdown` or `html` unless you have set up a renderer. `npx holo make:mail` doesn't support `--view` for the same reason.
:::

`html` is sent exactly as you pass it. If it includes user input, escape that input first.

## Headers, tags, and priority

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Your weekly report',
  markdown: '# Weekly report',
  headers: { 'X-Campaign': 'weekly-report' },
  tags: ['reports', 'weekly'],
  metadata: { userId: 42 },
  priority: 'high',
})
```

- `headers`: extra email headers. Values must be strings.
- `tags`: labels for your own tracking. Duplicates are removed.
- `metadata`: any JSON-serializable object.
- `priority`: `'high'`, `'normal'`, or `'low'`.

The SMTP driver sends tags as an `X-Holo-Tags` header, metadata as an `X-Holo-Metadata` header, and priority as the standard `X-Priority`, `Importance`, and `Priority` headers.

## Pick a mailer, queue, or delay in the definition

A mail can carry its own delivery defaults. Callers can still override them when sending.

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Your export is ready',
  markdown: 'Download it from your dashboard.',
  mailer: 'smtp',
  queue: { connection: 'redis', queue: 'mail' },
  delay: 60,
})
```

See [Sending mail](/mail/sending) and [Queueing mail](/mail/queueing).

## Available options

Every option you can pass to `defineMail()`, grouped by what it controls.

**Recipients**

- [to](#to)
- [cc](#cc)
- [bcc](#bcc)

**Sender**

- [from](#from)
- [replyTo](#replyto)

**Content**

<div class="method-list">

- [subject](#subject)
- [text](#text)
- [html](#html)
- [markdown](#markdown)
- [render](#render)
- [markdownWrapper](#markdownwrapper)

</div>

**Attachments**

- [attachments](#attachments)

**Headers and tracking**

- [headers](#headers)
- [tags](#tags)
- [metadata](#metadata)
- [priority](#priority)

**Delivery**

- [mailer](#mailer)
- [queue](#queue)
- [delay](#delay)

**Helpers**

- [defineMail()](#definemail)
- [isMailDefinition()](#ismaildefinition)

### to

Required. Who the mail is for. Pass one address or an array. Each address is a string or an object with `email` and an optional `name`. Addresses are lowercased and duplicates are removed. An empty list or an invalid address throws.

```ts
to: [
  'ava@example.com',
  { email: 'ben@example.com', name: 'Ben Carter' },
]
```

### cc

Optional. Copies sent to the same address formats as `to`.

```ts
cc: 'accounts@example.com'
```

### bcc

Optional. Hidden copies sent to the same address formats as `to`.

```ts
bcc: { email: 'audit@example.com', name: 'Audit' }
```

### from

Optional. The sender for this mail. If you leave it out, Holo uses the mailer's `from`, then the top-level `from` in `config/mail.ts`. If none is set, sending throws.

```ts
from: { email: 'support@example.com', name: 'Acme Support' }
```

### replyTo

Optional. Where replies go. If you leave it out, Holo uses the same order as `from`, and falls back to the sender.

```ts
replyTo: 'help@example.com'
```

### subject

Required. The subject line. It must be a non-empty string.

```ts
subject: `Order ${input.orderNumber} has shipped`
```

### text

A plain-text body. On its own it's the whole email. With `html`, `markdown`, or `render`, it replaces the plain-text version Holo would build.

```ts
text: 'Your invoice is attached.'
```

### html

A full HTML body. Holo sends it exactly as you pass it, so escape any user input first.

```ts
html: '<p>Your password was changed.</p>'
```

### markdown

A Markdown body. Holo converts it to HTML and builds a plain-text version by stripping the syntax. See [Markdown mail](/mail/markdown) for the supported syntax.

```ts
markdown: '# Welcome to Acme\n\nYour account is ready.'
```

### render

HTML rendered from a view. Pass the view name and optional `props`, which must be JSON-serializable. This needs a view renderer, which the default framework setups don't provide.

```ts
render: { view: 'emails/welcome', props: { name: 'Ava' } }
```

### markdownWrapper

The view that wraps the HTML of a Markdown mail, such as a shared header and footer. It only works on `markdown` mails and overrides the global `markdown.wrapper` setting.

```ts
markdownWrapper: 'layouts/marketing'
```

### attachments

Files to attach. Use `attachFromStorage()`, `attachFromPath()`, `attachContent()`, or an object with a `resolve()` function. See [Attachments](/mail/attachments).

```ts
attachments: [attachFromStorage('invoices/A-1001.pdf')]
```

### headers

Extra email headers as string values. Overrides merge with these headers, and a key in an override replaces the one here.

```ts
headers: { 'X-Campaign': 'weekly-report' }
```

### tags

Labels for your own tracking, such as `['reports', 'weekly']`. Blank tags throw, and duplicates are removed. The SMTP driver sends them in the `X-Holo-Tags` header.

```ts
tags: ['reports', 'weekly']
```

### metadata

A JSON-serializable object you can use to identify the mail later. Overrides merge with it key by key. The SMTP driver sends it in the `X-Holo-Metadata` header.

```ts
metadata: { userId: 42 }
```

### priority

How urgent the mail is: `'high'`, `'normal'`, or `'low'`. The SMTP driver sets the matching `X-Priority`, `Importance`, and `Priority` headers.

```ts
priority: 'high'
```

### mailer

The name of a mailer from `config/mail.ts`. Callers can still override it with `.using()`.

```ts
mailer: 'smtp'
```

### queue

Whether the mail goes through the queue. Pass `true`, or an object with `queued`, `connection`, `queue`, and `afterCommit`. A `connection` or `queue` name also queues the mail. See [Queueing mail](/mail/queueing).

```ts
queue: { connection: 'redis', queue: 'mail' }
```

### delay

Holds a queued mail for a number of seconds, or until a `Date`. It only applies when the mail is queued. Callers can override it with `.delay()`.

```ts
delay: 60
```

### defineMail()

Checks a mail definition, fills in the defaults, and returns a mail value you can send or preview. It throws when the definition is invalid, such as a missing subject or more than one body type.

```ts
export default function WelcomeMail(input: { readonly to: string }) {
  return defineMail({
    to: input.to,
    subject: 'Welcome',
    text: 'Your account is ready.',
  })
}
```

### isMailDefinition()

Returns `true` when a value came from `defineMail()`. Use it to tell a finished mail from a plain options object.

```ts
import { defineMail, isMailDefinition, type MailDefinitionInput } from '@holo-js/mail'

function prepareMail(input: MailDefinitionInput) {
  return isMailDefinition(input) ? input : defineMail(input)
}
```

## Next steps

- [Markdown mail](/mail/markdown)
- [Sending mail](/mail/sending)
- [Attachments](/mail/attachments)
