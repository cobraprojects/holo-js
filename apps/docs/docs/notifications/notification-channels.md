# Notification Channels

## Email Channel

For the email channel, your builder function should return an object with email-specific properties:

```ts
build: {
  email() {
    return {
      subject: 'Welcome to our service',
      lines: [
        'Thanks for joining our platform!',
        'We\'re excited to have you on board.'
      ],
      // Optional: Add action buttons
      actionText: 'Get Started',
      actionUrl: 'https://example.com/get-started'
    }
  }
}
```

Available email properties:
- `subject` (required) - The email subject line
- `lines` (required) - Array of text lines for the email body
- `actionText` (optional) - Text for a call-to-action button
- `actionUrl` (optional) - URL for the call-to-action button
- `introLines` (optional) - Introductory lines before the main content
- `outroLines` (optional) - Concluding lines after the main content

## Database Channel

For the database channel, your builder function should return an object that will be serialized and stored in the notifications table:

```ts
build: {
  database() {
    return {
      amount: 100.00,
      transactionId: 'txn_123abc',
      status: 'completed'
    }
  }
}
```

All properties in the database payload will be stored as JSON in the `data` column of the notifications table.

## Broadcast Channel

For the broadcast channel, your builder function should return an object containing the event name and data to broadcast:

```ts
build: {
  broadcast() {
    return {
      event: 'notification.sent',
      data: {
        message: 'You have a new notification',
        timestamp: new Date().toISOString()
      }
    }
  }
}
```

The `event` property determines the websocket event name, and `data` contains the payload that will be sent to subscribers.