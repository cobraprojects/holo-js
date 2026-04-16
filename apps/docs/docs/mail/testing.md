# Testing Mails

When testing your application, you can use the fake mail driver to inspect sent emails:

## Configuration

```ts
// config/mail.ts (test environment)
export default defineMailConfig({
  default: 'fake'
})
```

## Inspecting Sent Emails

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

## Fake Mail Data Structure

The `sentMailData()` function returns an array of sent mail objects with the following structure:

```ts
{
  to: Array<{ email: string, name?: string }>,
  cc: Array<{ email: string, name?: string }>,
  bcc: Array<{ email: string, name?: string }>,
  from: { email: string, name?: string },
  replyTo: { email: string, name?: string },
  subject: string,
  text?: string,
  html?: string,
  attachments: Array<{
    name: string,
    contentType: string,
    disposition: 'attachment' | 'inline',
    contentId?: string
  }>,
  headers: Record<string, string>,
  tags: string[],
  metadata: Record<string, unknown>
}
```

## Testing with Different Drivers

You can also test with other drivers by changing your test configuration:

```ts
// For logging emails during test
export default defineMailConfig({
  default: 'log'
})
```