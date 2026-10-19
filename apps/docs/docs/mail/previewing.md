# Previewing Mail

Check what an email looks like without sending it. Holo can return the rendered email as data, serve it from a route in your browser, or save every sent email as a preview file.

```ts
import { previewMail } from '@holo-js/mail'
import WelcomeMail from '../mail/welcome'

const preview = await previewMail(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))

preview.subject
preview.html
preview.text
```

## Preview in code

`previewMail(mail, overrides?)` renders the mail and resolves the sender, but doesn't send anything. The result includes:

| Field | Contents |
| --- | --- |
| `from`, `replyTo`, `to`, `cc`, `bcc` | Resolved addresses, including defaults from `config/mail.ts`. |
| `subject` | The subject. |
| `html`, `text` | The rendered bodies, when present. |
| `attachments` | Name, content type, disposition, and source of each attachment. Files are not read. |
| `headers`, `tags`, `metadata`, `priority` | As defined on the mail. |
| `source` | Which body type was used (`markdown`, `html`, `text`, or `render`). |

This is useful in tests and admin tools. Like sending, it throws if no sender address can be found.

## Preview in the browser

`renderMailPreview(mail, overrides?, format?)` returns a standard `Response`. Return it from a development route:

::: code-group

```ts [Next.js]
// app/dev/mail/welcome/route.ts
import { renderMailPreview } from '@holo-js/mail'
import WelcomeMail from '@/server/mail/welcome'

export async function GET(): Promise<Response> {
  return renderMailPreview(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))
}
```

```ts [Nuxt]
// server/routes/dev/mail/welcome.get.ts
import { renderMailPreview } from '@holo-js/mail'
import WelcomeMail from '../../../mail/welcome'

export default defineEventHandler(async () => {
  return renderMailPreview(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))
})
```

```ts [SvelteKit]
// src/routes/dev/mail/welcome/+server.ts
import { renderMailPreview } from '@holo-js/mail'
import WelcomeMail from '../../../../../server/mail/welcome'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async () => {
  return renderMailPreview(WelcomeMail({ to: 'ava@example.com', name: 'Ava' }))
}
```

:::

The third argument picks the format:

| Format | Response |
| --- | --- |
| `'html'` (default) | A page listing the subject, sender, recipients, and the email's HTML source. |
| `'json'` | The full preview result as JSON. |
| `'text'` | The plain-text body. Returns `422` if the mail has no text version. |

```ts
return renderMailPreview(WelcomeMail(input), undefined, 'json')
```

::: warning
Browser previews only work in the environments listed in `preview.allowedEnvironments` in `config/mail.ts`, which defaults to `['development']`. In any other environment, `renderMailPreview()` returns `403`. Holo checks the [application environment](/reference/environment#env-files-and-loading-order), which comes from `APP_ENV`. Don't add `'production'` unless the route is protected, because previews can expose recipient addresses.
:::

## Save every sent email

The `preview` driver doesn't deliver mail. It records each message instead, which makes it a good default for local development:

```ini [.env]
MAIL_MAILER=preview
```

Each sent mail is written as a JSON file to `.holo-js/runtime/mail-preview/<messageId>.json`. Change the folder with the mailer's `path` option. In the same process, you can also read the recorded messages:

```ts
import { listPreviewMailArtifacts, resetPreviewMailArtifacts } from '@holo-js/mail'

const latest = listPreviewMailArtifacts().at(-1)
latest?.mail.subject

resetPreviewMailArtifacts()
```

`resetPreviewMailArtifacts()` clears the in-memory list. It doesn't delete the files.

## Preview errors

Two errors describe why a preview can't be shown. Both extend `MailError`, and both are exported so you can check for them.

- `MailPreviewDisabledError`: the current environment isn't in `preview.allowedEnvironments`. Its `policy` property shows the environment and the allowed list. `renderMailPreview()` turns it into a `403` response.
- `MailPreviewFormatUnavailableError`: the requested format doesn't exist for this mail, such as `'text'` on a mail with no text body. Its `format` property holds the format name. `renderMailPreview()` turns it into a `422` response.

You usually don't catch these yourself, because `renderMailPreview()` already returns the right response. `previewMail()` doesn't throw either error.

## Next steps

- [Drivers](/mail/drivers)
- [Testing mail](/mail/testing)
