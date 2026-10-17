# Attachments

Attach files to a mail with the `attachments` option. Holo has helpers for the three common sources: a file in [storage](/storage/), a file on disk, and content you already have in memory.

```ts [server/mail/invoice.ts]
import { attachFromStorage, defineMail } from '@holo-js/mail'

function InvoiceMail(input: { readonly to: string, readonly invoiceNumber: string }) {
  return defineMail({
    to: input.to,
    subject: `Invoice ${input.invoiceNumber}`,
    markdown: 'Your invoice is attached.',
    attachments: [
      attachFromStorage(`invoices/${input.invoiceNumber}.pdf`),
    ],
  })
}

export default InvoiceMail
```

## Attach a file from storage

`attachFromStorage(path, options?)` reads from a storage disk. It uses your default disk unless you pass `disk`:

```ts
attachFromStorage('reports/2026-q3.pdf', { disk: 'public' })
```

Local disks are attached from their file path. S3 disks are downloaded and attached as bytes. Storage attachments need `@holo-js/storage` installed.

## Attach a file from disk

`attachFromPath(path, options?)` attaches a file by its path:

```ts
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachFromPath } from '@holo-js/mail'

attachFromPath(join(tmpdir(), 'export-42.csv'), { name: 'orders.csv' })
```

::: warning
For safety, the SMTP driver only sends path attachments that live inside your project's `storage/` folder or the operating system's temp directory. Other paths fail with `Path attachments must resolve inside an allowed attachment directory`. Never build a path from user input.
:::

## Attach content from memory

`attachContent(content, options)` attaches a string or bytes (`Uint8Array`, which includes Node's `Buffer`). A `name` is required:

```ts
import { attachContent } from '@holo-js/mail'

attachContent('id,total\n1,99.00\n', { name: 'orders.csv' })

attachContent(pdfBytes, { name: 'receipt.pdf', contentType: 'application/pdf' })
```

## File name and content type

Every helper accepts `name` and `contentType`. If you leave them out:

- `name` defaults to the last segment of the path.
- `contentType` is guessed from the file extension for common types: `avif`, `css`, `csv`, `gif`, `html`/`htm`, `jpg`/`jpeg`, `json`, `md`, `mp3`, `pdf`, `png`, `svg`, `txt`, `webp`, `woff`, `woff2`, and `xml`.

```ts
attachFromStorage('exports/a8f3.bin', {
  name: 'monthly-report.xlsx',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})
```

## Inline images

To show an image inside the email body instead of as a download, set `disposition: 'inline'` and a `contentId`, then reference it with `cid:` in your HTML:

```ts
import { attachFromStorage, defineMail } from '@holo-js/mail'

defineMail({
  to: 'ava@example.com',
  subject: 'Welcome to Acme',
  html: '<img src="cid:logo" alt="Acme"><p>Thanks for joining.</p>',
  attachments: [
    attachFromStorage('brand/logo.png', {
      disposition: 'inline',
      contentId: 'logo',
    }),
  ],
})
```

An inline attachment without a `contentId` throws when you call `defineMail()`.

## Resolve an attachment when sending

If the file only exists once you send (for example, you generate a PDF), pass an object with a `resolve` function. It runs at send time and returns a `path`, `storage`, or `content` attachment:

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Your statement',
  text: 'Your statement is attached.',
  attachments: [
    {
      name: 'statement.pdf',
      async resolve() {
        return { content: await renderStatementPdf(), name: 'statement.pdf' }
      },
    },
  ],
})
```

Resolver attachments can't be queued. Sending a mail that has one while queueing throws `Resolver attachments are not queue-safe`.

## Attachments and queues

When a mail is [queued](/mail/queueing), Holo stores the attachments with the job:

- Storage and path attachments are stored as their path and read again by the worker. Make sure the worker can reach the same file.
- Content attachments are stored with the job. Bytes are base64-encoded, so keep queued attachments small.
- Resolver attachments are rejected, as described above.

## Helper reference

| Helper | Options |
| --- | --- |
| `attachFromStorage(path, options?)` | `disk`, `name`, `contentType`, `disposition`, `contentId` |
| `attachFromPath(path, options?)` | `name`, `contentType`, `disposition`, `contentId` |
| `attachContent(content, options)` | `name` (required), `contentType`, `disposition`, `contentId` |

`disposition` is `'attachment'` (the default) or `'inline'`.

`inferMimeTypeFromName(name)` returns the content type for a file name using the same extension list, or `undefined` when the extension isn't known. You rarely need it, because the helpers already call it.

```ts
inferMimeTypeFromName('invoice.pdf') // 'application/pdf'
inferMimeTypeFromName('data.bin') // undefined
```

## Next steps

- [File storage](/storage/)
- [Queueing mail](/mail/queueing)
