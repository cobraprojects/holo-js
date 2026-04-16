# Creating Mails

## Basic Mail Structure

Every mail definition requires:
- `to` - Recipient email address(es)
- `subject` - Email subject line
- One of: `text`, `html`, `markdown`, or `render` for the email body

```ts
import { defineMail } from '@holo-js/mail'

const invoicePaidMail = defineMail({
  to: 'user@example.com',
  subject: 'Invoice Paid',
  markdown: `# Invoice Paid\n\nYour invoice has been successfully paid.`
})
```

## Address Formats

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

## CC and BCC

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

## From and Reply-To

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