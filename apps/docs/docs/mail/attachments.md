# Attachments

You can add attachments to your emails using attachment helper functions:

```ts
import { defineMail, attachFromStorage, attachFromPath } from '@holo-js/mail'

const invoiceMail = defineMail({
  to: 'customer@example.com',
  subject: 'Invoice #1234',
  markdown: 'Please find your invoice attached.',
  attachments: [
    attachFromStorage('invoices/1234.pdf'),
    attachFromPath('/tmp/receipt.png', {
      name: 'receipt.png'
    })
  ]
})
```

## Attachment Sources

### Storage Attachments

```ts
attachFromStorage('path/to/file.pdf')
```

### Path Attachments

```ts
attachFromPath('/absolute/path/to/file.jpg')
```

### Content Attachments

```ts
attachContent(Buffer.from('Hello World', 'utf8'), {
  name: 'hello.txt',
  contentType: 'text/plain'
})
```

## Inline Attachments

For embedding images directly in your email HTML:

```ts
{
  to: 'user@example.com',
  subject: 'Newsletter with Logo',
  html: '<h1>Welcome</h1><img src="cid:logo" alt="Logo">',
  attachments: [
    attachFromPath('/path/to/logo.png', {
      name: 'logo.png',
      contentId: 'logo' // This makes it inline and referenceable by cid:logo
    })
  ]
}
```

## Attachment Options

### Custom Filename

```ts
attachFromPath('/tmp/file.pdf', {
  name: 'custom-name.pdf'
})
```

### Custom Content Type

```ts
attachFromPath('/tmp/data.json', {
  contentType: 'application/json'
})
```

### Inline Attachments with Content ID

```ts
attachFromPath('/path/to/image.png', {
  name: 'image.png',
  contentId: 'header-image' // References as cid:header-image in HTML
})
```

## Queue-Safe Attachments

When using queues, some attachment types may not be serializable:

- `attachContent()` with Buffer/stream content is NOT queue-safe
- `attachFromPath()` and `attachFromStorage()` ARE queue-safe (resolved at send time)

To make content attachments queue-safe, convert them to base64:

```ts
// Queue-safe version
attachContent(Buffer.from('Hello World').toString('base64'), {
  name: 'hello.txt',
  contentType: 'text/plain'
})
```