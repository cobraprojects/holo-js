# Previewing Mails

Before sending emails, you can preview them to verify their content.

## Simple Preview

```ts
import { previewMail } from '@holo-js/mail'

const preview = await previewMail(invoicePaidMail)
// Returns: { html: string, text: string, envelope: object }
```

## Browser Preview

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