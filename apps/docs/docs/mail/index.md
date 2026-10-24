# Mail

Holo's mail package sends email from your server code. You describe an email with `defineMail()`, send it with `sendMail()`, and choose how it is delivered (SMTP, a local preview, a log line, or an in-memory fake for tests) in `config/mail.ts`.

## Quick example

```ts [server/mail/welcome.ts]
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

```ts [server/lib/onboarding.ts]
import { sendMail } from '@holo-js/mail'
import WelcomeMail from '../mail/welcome'

export async function sendWelcomeEmail(email: string, name: string) {
  await sendMail(WelcomeMail({ to: email, name }))
}
```

With the default config, this email isn't sent anywhere. It is saved as a preview file so you can check it during development. Switch to SMTP when you're ready to deliver real email.

## Install

Add mail to an existing project:

```bash
npx holo install mail
```

This adds `@holo-js/mail` to `package.json`, creates `config/mail.ts` and an empty `server/mail/` folder, and adds the `MAIL_*` variables to `.env` and `.env.example`.

## Configure mail

`config/mail.ts` picks the default mailer, the default sender, and lists the mailers you can send through:

```ts [config/mail.ts]
import { defineMailConfig } from '@holo-js/mail'
import { env } from '@holo-js/config'

export default defineMailConfig({
  default: env('MAIL_MAILER', 'preview'),
  from: {
    email: env('MAIL_FROM_ADDRESS', 'hello@app.test'),
    name: env('MAIL_FROM_NAME', 'Holo App'),
  },
  preview: {
    allowedEnvironments: ['development'],
  },
  mailers: {
    preview: {
      driver: 'preview',
    },
    log: {
      driver: 'log',
      logBodies: env('MAIL_LOG_BODIES', false),
    },
    fake: {
      driver: 'fake',
    },
    smtp: {
      driver: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: env('MAIL_PORT', 1025),
      secure: env('MAIL_SECURE', false),
      user: env('MAIL_USERNAME') || undefined,
      password: env('MAIL_PASSWORD') || undefined,
    },
  },
})
```

A **mailer** is a named delivery setup. Its `driver` decides how mail leaves your app. Change `MAIL_MAILER` in `.env` to switch the default without touching code:

```ini [.env]
MAIL_MAILER=smtp
MAIL_HOST=smtp.example.com
MAIL_PORT=587
MAIL_USERNAME=apikey
MAIL_PASSWORD=secret
MAIL_FROM_ADDRESS=hello@example.com
MAIL_FROM_NAME="Acme"
```

::: tip
For local development, run [Mailpit](https://mailpit.axllent.org/) and point the `smtp` mailer at it. The scaffolded defaults (`127.0.0.1:1025`) already match Mailpit, so setting `MAIL_MAILER=smtp` is enough.
:::

See [Drivers](/mail/drivers) for every driver and option.

## Send your first email

Generate a mail file:

```bash
npx holo make:mail welcome
```

This creates `server/mail/welcome.ts` with a `WelcomeMail` function like the one above. Call it from any server code, such as a route handler:

::: code-group

```ts [Next.js]
// app/api/welcome/route.ts
import { sendMail } from '@holo-js/mail'
import WelcomeMail from '@/server/mail/welcome'

export async function POST(): Promise<Response> {
  await sendMail(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))

  return Response.json({ sent: true })
}
```

```ts [Nuxt]
// server/api/welcome.post.ts
import { sendMail } from '@holo-js/mail'
import WelcomeMail from '../mail/welcome'

export default defineEventHandler(async () => {
  await sendMail(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))

  return { sent: true }
})
```

```ts [SvelteKit]
// src/routes/api/welcome/+server.ts

import { sendMail } from '@holo-js/mail'
import WelcomeMail from '../../../../server/mail/welcome'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async () => {
  await sendMail(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))

  return Response.json({ sent: true })
}
```

:::

Holo configures mail from `config/mail.ts` when the app boots, so there is no setup call. `sendMail()` is server-only; don't import it in client code.

## Mail and notifications

If you send the same message through email and other channels (a database inbox, realtime broadcast), use [notifications](/notifications/) instead. When both packages are installed, a notification's `email` channel is delivered through your mail config. See [Notification channels](/notifications/channels#email).

Holo's auth features (email verification, password reset) also send through mail when it is installed.

## Next steps

- [Writing mail](/mail/writing-mail): recipients, subjects, and content
- [Sending mail](/mail/sending): choose a mailer, delay, and send after a transaction
- [Queueing mail](/mail/queueing): send in the background
- [Previewing mail](/mail/previewing): check emails in the browser
- [Testing mail](/mail/testing): assert what was sent
