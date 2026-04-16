# Notifications

## Mail Integration with Notifications

When both the mail and notifications packages are installed, Holo-JS automatically bridges notifications email delivery through the mail system.

### How It Works

1. When a notification is sent via the email channel
2. Holo-JS checks if the mail package is installed
3. If mail is available, the notification is converted to a mail message
4. The mail is sent using your configured mail drivers

### Configuration

No additional configuration is needed - the integration happens automatically when both packages are installed.

### Customizing Notification Emails

You can customize how notifications are converted to mails by defining a custom mail builder in your notification:

```ts
import { defineNotification } from '@holo-js/notifications'

const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email'] as const
  },
  build: {
    email() {
      return {
        subject: 'Invoice Paid',
        markdown: `# Invoice Paid\n\nYour invoice has been successfully paid.`,
        // You can also specify mail-specific options here
        // like attachments, cc/bcc, etc.
      }
    }
  }
})
```