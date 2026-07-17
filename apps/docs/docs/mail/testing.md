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
import { listFakeSentMails, resetFakeSentMails } from '@holo-js/mail'

test('sends welcome email when user registers', async () => {
  // Perform user registration
  await registerUser({ email: 'test@example.com' })
  
  // Get the sent emails
  const sentMails = listFakeSentMails()
  
  // Assert emails were sent
  expect(sentMails).toHaveLength(1)
  expect(sentMails[0].mail.to).toContainEqual({
    email: 'test@example.com'
  })
  expect(sentMails[0].mail.subject).toBe('Welcome!')

  resetFakeSentMails()
})
```

## Fake Mail Data Structure

`listFakeSentMails()` returns immutable delivery records. The normalized message is available through each record's
`mail` property, while `context` and `result` describe the driver execution.

```ts
type FakeSentMail = {
  messageId: string
  createdAt: Date
  mail: ResolvedMail
  context: MailDriverExecutionContext
  result: MailSendResult
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
