# Mail Drivers

A driver decides what happens to a mail when you send it: deliver it over SMTP, save it as a preview, log it, or keep it in memory for tests. You choose drivers by defining mailers in `config/mail.ts`.

```ts [config/mail.ts]
import { defineMailConfig } from '@holo-js/mail'
import { env } from '@holo-js/config'

export default defineMailConfig({
  default: env('MAIL_MAILER', 'preview'),
  from: { email: 'hello@example.com', name: 'Acme' },
  mailers: {
    smtp: {
      driver: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: env('MAIL_PORT', 1025),
    },
  },
})
```

Holo always has four mailers available, named after their drivers: `preview`, `log`, `fake`, and `smtp`. Entries in `mailers` override those defaults or add new mailers. You can define several mailers with the same driver, for example a `transactional` and a `marketing` SMTP mailer:

```ts
mailers: {
  transactional: {
    driver: 'smtp',
    host: 'smtp.postmarkapp.com',
    port: 587,
    user: env('POSTMARK_TOKEN'),
    password: env('POSTMARK_TOKEN'),
    from: { email: 'orders@example.com', name: 'Acme Orders' },
  },
  marketing: {
    driver: 'smtp',
    host: 'smtp.sendgrid.net',
    port: 587,
    user: 'apikey',
    password: env('SENDGRID_API_KEY'),
    from: { email: 'news@example.com', name: 'Acme News' },
  },
},
```

Send through a specific mailer with `.using('marketing')` or `mailer: 'marketing'` in `defineMail()`.

## Config options

`defineMailConfig()` takes these top-level options. It returns a frozen copy of the config, so it's mainly there for type checking.

| Option | Type | Description |
| --- | --- | --- |
| `default` | `string` | Mailer used when a mail doesn't name one. Defaults to `'preview'`. |
| `from`, `replyTo` | `{ email, name? }` | Default sender and reply-to for every mailer. |
| `queue` | `{ queued?, connection?, queue?, afterCommit? }` | Default queue settings for every mailer. |
| `preview.allowedEnvironments` | `('development' \| 'production' \| 'test')[]` | Environments where [browser previews](/mail/previewing) work. Defaults to `['development']`. |
| `markdown.wrapper` | `string` | Layout view that wraps every Markdown mail. See [Markdown mail](/mail/markdown#wrap-markdown-in-a-layout). |
| `mailers` | object | Named mailers. Each entry is described below. |

## Options for every mailer

| Option | Type | Description |
| --- | --- | --- |
| `driver` | `string` | Required. `smtp`, `preview`, `log`, `fake`, or a custom driver name. |
| `from` | `{ email, name? }` | Default sender for this mailer. Overrides the top-level `from`. |
| `replyTo` | `{ email, name? }` | Default reply-to for this mailer. |
| `queue` | `{ queued?, connection?, queue?, afterCommit? }` | Queue mail sent through this mailer. See [Queueing mail](/mail/queueing). |

## smtp

Delivers mail to an SMTP server. Use it for real email: your provider's SMTP endpoint in production, or [Mailpit](https://mailpit.axllent.org/) locally.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | `'127.0.0.1'` | SMTP server host. |
| `port` | `number \| string` | `1025` | SMTP port. Strings from `.env` are converted to numbers. |
| `secure` | `boolean` | `false` | Use TLS from the start of the connection. Usually `true` for port 465 and `false` for 587 or 25. |
| `user` | `string` | none | SMTP username. Holo only sends credentials when `user` is set. |
| `password` | `string` | none | SMTP password. |

The scaffolded config reads these from `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USERNAME`, and `MAIL_PASSWORD`.

### Connection reuse

Holo keeps one SMTP connection open for each mailer and sends later messages over it. A connection that stays idle for 5 seconds closes, and the next message opens a new one.

Shutting down the Holo runtime closes the connection right away. A script that sends mail and never calls `shutdown()` on the runtime from `initializeHolo()` exits up to 5 seconds after its last send.

## preview

Saves each sent mail as a JSON file instead of delivering it. This is the default mailer in new projects, so nothing reaches real inboxes during development.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `'.holo-js/runtime/mail-preview'` | Folder for the preview files. A relative path resolves against the directory Holo runs from. |

See [Previewing mail](/mail/previewing#save-every-sent-email).

## log

Writes a summary of each mail to the console with `console.warn` instead of delivering it. The summary includes the message ID, mailer, recipients, subject, attachment names, tags, and priority.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `logBodies` | `boolean` | `false` | Also log the HTML and text bodies. |

::: warning
Logs often end up in third-party services. Keep `logBodies` off anywhere real user data is sent, because email bodies can contain password-reset links and other secrets.
:::

## fake

Keeps sent mail in memory so tests can inspect it. It has no options. See [Testing mail](/mail/testing).

## Custom drivers

To send through a provider's HTTP API instead of SMTP, register a driver with a `send()` method. It receives the fully rendered mail and returns a result:

```ts [server/mail/drivers/postmark.ts]
import { registerMailDriver } from '@holo-js/mail'

registerMailDriver('postmark', {
  async send(mail, context) {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-postmark-server-token': process.env.POSTMARK_TOKEN ?? '',
      },
      body: JSON.stringify({
        From: mail.from.email,
        To: mail.to.map(address => address.email).join(','),
        Subject: mail.subject,
        HtmlBody: mail.html,
        TextBody: mail.text,
      }),
    })
    const body = await response.json() as { MessageID?: string }

    return {
      messageId: context.messageId,
      mailer: context.mailer,
      driver: context.driver,
      queued: context.queued,
      providerMessageId: body.MessageID,
    }
  },
})
```

Then point a mailer at it:

```ts [config/mail.ts]
mailers: {
  postmark: {
    driver: 'postmark',
  },
},
```

The `mail` argument has `from`, `replyTo`, `to`, `cc`, `bcc`, `subject`, `html`, `text`, `attachments`, `headers`, `tags`, `metadata`, and `priority`. The `context` argument has `messageId`, `mailer`, `driver`, and `queued`. If `send()` throws, `sendMail()` rejects with a `MailSendError`.

Registering the same name twice throws. Pass `{ replaceExisting: true }` as the third argument to replace a driver.

::: info
`registerMailDriver()` must run in every process that delivers mail, including [queue workers](/queue/workers). To ship a driver as a reusable package, contribute it from a [plugin](/advanced/plugins) with `contributes: { mail: { drivers: { postmark: { runtime: './dist/postmark.mjs' } } } }`. The module's default export must have a `send()` method. Holo loads plugin drivers automatically the first time a mailer needs them.
:::

### Look up and reset custom drivers

Three helpers manage the drivers you registered. They don't include the four built-in drivers.

- `getRegisteredMailDriver(name)` returns `{ name, driver }`, or `undefined` if no driver has that name.
- `listRegisteredMailDrivers()` returns every custom driver registered in this process.
- `resetMailDriverRegistry()` removes all custom drivers. Use it in tests that register their own drivers.

```ts
import { afterEach } from 'vitest'
import { getRegisteredMailDriver, resetMailDriverRegistry } from '@holo-js/mail'

const postmark = getRegisteredMailDriver('postmark')

afterEach(() => {
  resetMailDriverRegistry()
})
```

## Next steps

- [Queueing mail](/mail/queueing)
- [Previewing mail](/mail/previewing)
- [Testing mail](/mail/testing)
