# Setup And CLI

Mail is optional. Add it during scaffold if the project needs outbound email immediately, or install it later into
an existing app.

## Scaffold during project creation

Use the optional package flag during `create`:

```bash
npm create holo-js@latest my-app -- --package mail
```

Optional packages still compose normally:

```bash
npm create holo-js@latest my-app -- --package forms,validation,mail
```

## Existing projects

Install mail into an existing Holo-JS app with:

```bash
npx holo install mail
```

This adds the `@holo-js/mail` package dependency when needed and scaffolds:

- `config/mail.ts`
- `server/mail/`

## Generated mail files

Generate a mail definition with:

```bash
npx holo make:mail auth/verify-email
```

Use `--markdown` to skip the default markdown scaffold explicitly:

```bash
npx holo make:mail auth/verify-email --markdown
```

If the app has a custom `renderView` runtime binding, author `render: { view, props }` mails manually as shown in
[Defining Mail](/mail/defining-mail). The first-party app scaffolds do not wire view rendering automatically yet.

## Built-in drivers

Built-in drivers are available immediately:

- `preview`
- `log`
- `fake`
- `smtp`

`preview`, `log`, and `fake` work from config alone. `smtp` uses the configured SMTP settings.

## SMTP and local development

The default scaffold keeps `preview` as the default mailer and includes an `smtp` mailer entry:

```ts
import { defineMailConfig, env } from '@holo-js/config'

export default defineMailConfig({
  default: env('MAIL_MAILER', 'preview'),
  from: {
    email: env('MAIL_FROM_ADDRESS', 'hello@app.test'),
    name: env('MAIL_FROM_NAME', 'Holo App'),
  },
  mailers: {
    preview: {
      driver: 'preview',
    },
    smtp: {
      driver: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: env('MAIL_PORT', 1025),
      secure: env<boolean>('MAIL_SECURE', false),
      user: env('MAIL_USERNAME'),
      password: env('MAIL_PASSWORD'),
    },
  },
})
```

For a richer local SMTP inbox, Holo-JS recommends using [Mailpit](https://mailpit.axllent.org/).

## Auth and notifications integration

When `@holo-js/mail` is installed, core can use it automatically:

- auth falls back to direct mail delivery when notifications are absent
- notifications email delivery routes into mail when both packages are installed

## Continue

- [Mail Overview](/mail/)
- [Sending And Preview](/mail/sending-and-preview)
