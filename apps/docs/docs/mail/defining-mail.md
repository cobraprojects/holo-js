# Defining Mail

Mail definitions are plain normalized values built with `defineMail(...)`.

## Markdown mail

Markdown is the simplest authoring path:

```ts
import { defineMail } from '@holo-js/mail'

export type WelcomeMailInput = {
  readonly to: string
  readonly name: string
}

function WelcomeMail(input: WelcomeMailInput) {
  return defineMail({
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
}

export default WelcomeMail
```

## View-backed mail

Use `render: { view, props }` when the mail should render through the framework-backed server-view contract:

```ts
import { defineMail } from '@holo-js/mail'

export type VerifyEmailMailInput = {
  readonly to: string
  readonly name: string
}

function VerifyEmailMail(input: VerifyEmailMailInput) {
  return defineMail({
    to: input.to,
    subject: `Welcome, ${input.name}`,
    render: {
      view: 'auth/verify-email',
      props: input,
    },
  })
}

export default VerifyEmailMail
```

The view identifier is a path-style string under `server/mail`, not an absolute path.

## Content rules

Exactly one primary content source is allowed:

- `text`
- `html`
- `markdown`
- `render`

Optional explicit `text` can accompany `html`, `markdown`, or `render` when the app wants a plain-text fallback.

## Mail metadata

Mail definitions also support:

- `from`
- `replyTo`
- `cc`
- `bcc`
- `headers`
- `tags`
- `metadata`
- `priority`
- `queue`
- `delay`

## Markdown wrappers

Markdown mail can use a configured wrapper view globally or per mail:

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Welcome',
  markdown: '# Welcome',
  markdownWrapper: 'layouts/transactional',
})
```

## Continue

- [Sending And Preview](/mail/sending-and-preview)
- [Attachments And Drivers](/mail/attachments-and-drivers)
