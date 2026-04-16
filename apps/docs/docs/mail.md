# Mail

## Introduction

Holo-JS mail provides a simple, expressive way to send emails with support for markdown, views, attachments, and various delivery drivers. The mail system is designed to be flexible and easy to use while providing powerful features for email composition and delivery.

## Creating Mails

Mails are defined using the `defineMail` function. Each mail consists of recipient information, subject, and content that can be plain text, HTML, markdown, or rendered from a view.

```ts
import { defineMail } from '@holo-js/mail'

const invoicePaidMail = defineMail({
  to: 'user@example.com',
  subject: 'Invoice Paid',
  markdown: `# Invoice Paid\n\nYour invoice has been successfully paid.`
})
```

### Basic Mail Structure

Every mail definition requires:
- `to` - Recipient email address(es)
- `subject` - Email subject line
- One of: `text`, `html`, `markdown`, or `render` for the email body

### Address Formats

Addresses can be specified in multiple formats:

```ts
// Simple string
to: 'user@example.com'

// Object with name
to: { email: 'user@example.com', name: 'User Name' }

// Array of recipients
to: [
  'user1@example.com',
  { email: 'user2@example.com', name: 'User Two' }
]
```

### CC and BCC

You can also specify CC and BCC recipients:

```ts
{
  to: 'user@example.com',
  cc: 'admin@example.com',
  bcc: 'manager@example.com',
  subject: 'Notification',
  markdown: 'Please review the attached document.'
}
```

### From and Reply-To

You can override the default from and reply-to addresses:

```ts
{
  to: 'user@example.com',
  from: 'support@example.com',
  replyTo: 'help@example.com',
  subject: 'Support Request',
  markdown: 'How can we help you today?'
}
```

## Mail Content Types

### Plain Text

```ts
{
  to: 'user@example.com',
  subject: 'Update',
  text: 'Your account has been updated successfully.'
}
```

### HTML

```ts
{
  to: 'user@example.com',
  subject: 'Newsletter',
  html: '<h1>Monthly Newsletter</h1><p>Here are this month\'s updates.</p>'
}
```

### Markdown

```ts
{
  to: 'user@example.com',
  subject: 'Meeting Notes',
  markdown: '# Meeting Notes\n\n- Discussed project timeline\n- Reviewed budget allocations\n- Assigned action items'
}
```

Markdown is automatically converted to HTML for email delivery.

### View-Based Mail

For more complex emails, you can use views:

```ts
{
  to: 'user@example.com',
  subject: 'Welcome',
  render: {
    view: 'emails/welcome',
    props: {
      userName: 'John',
      company: 'Acme Corp'
    }
  }
}
```

Views are stored in the `server/mail` directory and can use any templating system supported by your framework adapter.

## Attachments

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

### Attachment Sources

#### Storage Attachments

```ts
attachFromStorage('path/to/file.pdf')
```

#### Path Attachments

```ts
attachFromPath('/absolute/path/to/file.jpg')
```

#### Content Attachments

```ts
attachContent(Buffer.from('Hello World', 'utf8'), {
  name: 'hello.txt',
  contentType: 'text/plain'
})
```

### Inline Attachments

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

## Sending Mails

Mails are sent using the `sendMail` function, which returns a fluent API for configuring delivery options.

### Basic Usage

```ts
import { sendMail } from '@holo-js/mail'
import { invoicePaidMail } from './mails'

await sendMail(invoicePaidMail)
```

### Fluent Configuration Options

The `sendMail` function returns a fluent builder that allows you to configure various aspects of the mail delivery:

#### Choosing a Mailer

```ts
await sendMail(invoicePaidMail)
  .using('smtp')
```

#### Specifying a Connection

```ts
await sendMail(invoicePaidMail)
  .onConnection('smtp-production')
```

#### Queueing

```ts
await sendMail(invoicePaidMail)
  .onQueue('mail')
```

#### Delayed Delivery

```ts
// Delay delivery by 1 hour
await sendMail(invoicePaidMail)
  .delay(60 * 60)

// Delay using a Date object
await sendMail(invoicePaidMail)
  .delay(new Date(Date.now() + 3600000))
```

#### Transaction Awareness

```ts
await sendMail(invoicePaidMail)
  .afterCommit()
```

## Previewing Mails

Before sending emails, you can preview them to verify their content.

### Simple Preview

```ts
import { previewMail } from '@holo-js/mail'

const preview = await previewMail(invoicePaidMail)
// Returns: { html: string, text: string, envelope: object }
```

### Browser Preview

For development, you can render mail previews as HTTP responses:

```ts
import { renderMailPreview } from '@holo-js/mail'
// In your route handler:
return await renderMailPreview(invoicePaidMail, { format: 'html' })
```

Preview formats:
- `html` - Returns HTML response
- `text` - Returns plain text response  
- `json` - Returns JSON with mail data

## Mail Drivers

Holo-JS includes several built-in mail drivers for different delivery methods.

### SMTP Driver

For sending emails via SMTP:

```ts
// config/mail.ts
export default defineMailConfig({
  default: 'smtp',
  mailers: {
    smtp: {
      driver: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      encryption: 'tls',
      username: 'your-username',
      password: 'your-password'
    }
  }
})
```

### Log Driver

For development, logs emails to the console:

```ts
{
  driver: 'log',
  // Optional: log full email bodies
  // logBody: true
}
```

### Fake Driver

For testing, captures emails without sending:

```ts
{
  driver: 'fake'
}
```

### Preview Driver

For viewing emails in the browser during development:

```ts
{
  driver: 'preview'
}
```

## Markdown Wrapper

You can customize how markdown emails are wrapped:

```ts
// config/mail.ts
export default defineMailConfig({
  default: 'smtp',
  markdown: {
    // Global wrapper for all markdown emails
    wrapper: 'emails/markdown-wrapper'
  },
  mailers: {
    smtp: {
      driver: 'smtp'
      // ... smtp config
    }
  }
})
```

Then create a wrapper view in `server/mail/markdown-wrapper.view.*`:
```html
<div class="email-wrapper">
  <div class="email-body">
    <!-- Markdown content will be inserted here -->
    {!@body!}
  </div>
  <div class="email-footer">
    Sent from your application
  </div>
</div>
```

## Queueing

When using the queue feature, mails can be delayed and processed asynchronously:

```ts
await sendMail(invoicePaidMail)
  .onQueue('mail')
  .delay(300) // 5 minutes delay
  .afterCommit()
```

This requires the `@holo-js/queue` package to be installed.

## Testing Mails

When testing your application, you can use the fake mail driver to inspect sent emails:

```ts
// config/mail.ts (test environment)
export default defineMailConfig({
  default: 'fake'
})
```

Then in your tests:

```ts
import { sentMailData } from '@holo-js/mail'

test('sends welcome email when user registers', async () => {
  // Perform user registration
  await registerUser({ email: 'test@example.com' })
  
  // Get the sent emails
  const sentMails = sentMailData()
  
  // Assert emails were sent
  expect(sentMails).toHaveLength(1)
  expect(sentMails[0].to).toContainEqual({
    email: 'test@example.com'
  })
  expect(sentMails[0].subject).toBe('Welcome!')
})
```

## Configuration

Mail configuration is stored in `config/mail.ts`. Here's an example configuration:

```ts
import { defineMailConfig } from '@holo-js/mail'

export default defineMailConfig({
  // Default mailer to use
  default: 'smtp',
  
  // Default sender address
  from: { address: 'hello@example.com', name: 'Holo JS App' },
  
  // Default reply-to address
  replyTo: { address: 'support@example.com', name: 'Support Team' },
  
  // Queue configuration
  queue: {
    connection: 'default',
    queue: 'mail',
    // Whether to delay dispatch until after database commits
    afterCommit: true
  },
  
  // Markdown configuration
  markdown: {
    // Default view wrapper for markdown emails
    wrapper: 'emails/wrapper'
  },
  
  // Mailer configurations
  mailers: {
    smtp: {
      driver: 'smtp',
      host: 'smtp.mailtrap.io',
      port: 2525,
      encryption: 'tls',
      username: process.env.MAILTRAP_USERNAME,
      password: process.env.MAILTRAP_PASSWORD
    },
    
    log: {
      driver: 'log'
    },
    
    fake: {
      driver: 'fake'
    },
    
    preview: {
      driver: 'preview'
    }
  }
})
```

### Environment Variables

You can override configuration values using environment variables:

```
MAIL_DEFAULT=smtp
MAIL_FROM_ADDRESS=hello@example.com
MAIL_FROM_NAME="Holo JS App"
MAIL_SMTP_HOST=smtp.example.com
MAIL_SMTP_PORT=587
MAIL_SMTP_ENCRYPTION=tls
MAIL_SMTP_USERNAME=your_username
MAIL_SMTP_PASSWORD=your_password
MAIL_QUEUE_CONNECTION=redis
MAIL_QUEUE_QUEUE=mail
```