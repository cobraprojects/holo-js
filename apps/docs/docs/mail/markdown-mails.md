# Markdown Mails

## Basic Markdown

```ts
{
  to: 'user@example.com',
  subject: 'Meeting Notes',
  markdown: '# Meeting Notes\n\n- Discussed project timeline\n- Reviewed budget allocations\n- Assigned action items'
}
```

Markdown is automatically converted to HTML for email delivery.

## View-Based Mail

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