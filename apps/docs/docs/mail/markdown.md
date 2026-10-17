# Markdown Mail

Write the body of an email in Markdown and Holo turns it into HTML and a plain-text version. This is the quickest way to write transactional email that reads well in every client.

```ts [server/mail/password-changed.ts]
import { defineMail } from '@holo-js/mail'

function PasswordChangedMail(input: { readonly to: string, readonly name: string }) {
  return defineMail({
    to: input.to,
    subject: 'Your password was changed',
    markdown: [
      '# Password changed',
      '',
      `Hi ${input.name},`,
      'your password was changed **just now**.',
      '',
      'If this wasn\'t you:',
      '',
      '- [Reset your password](https://app.example.com/forgot-password)',
      '- Contact support at [help@example.com](mailto:help@example.com)',
    ].join('\n'),
  })
}

export default PasswordChangedMail
```

## Supported syntax

Holo uses a small, safe Markdown subset built for email. Separate blocks with a blank line.

| Markdown | Result |
| --- | --- |
| `# Heading` to `###### Heading` | `<h1>` to `<h6>`. The heading must be on its own block. |
| Lines of text | A paragraph. Single line breaks inside a paragraph become `<br />`. |
| Lines starting with `- ` or `* ` | A bulleted list, when every line in the block is a list item. |
| `**bold**` | `<strong>` |
| `*italic*` | `<em>` |
| `` `code` `` | `<code>` |
| `[label](url)` | A link. |

Other Markdown, such as numbered lists, tables, images, and block quotes, is not converted and shows as plain text. Use `html` when you need more control.

## Safety

Holo escapes any HTML in your Markdown, so it's safe to interpolate user-provided values like names. Links only render for `http:`, `https:`, and `mailto:` URLs, plus relative paths (`/`, `./`, `../`, `#`). Any other link, such as `javascript:`, renders as its label text only.

## Plain-text version

Holo builds the plain-text part by stripping the Markdown syntax: headings and bullets lose their markers, and links become `label (url)`. To write your own plain-text version, pass `text` as well:

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Welcome',
  markdown: '# Welcome\n\nThanks for joining.',
  text: 'Welcome! Thanks for joining.',
})
```

## Wrap Markdown in a layout

To put every Markdown email inside a shared layout, such as a header with your logo and a footer, set a wrapper view globally or per mail:

```ts [config/mail.ts]
import { defineMailConfig } from '@holo-js/mail'

export default defineMailConfig({
  markdown: {
    wrapper: 'layouts/transactional',
  },
})
```

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Welcome',
  markdown: '# Welcome',
  markdownWrapper: 'layouts/marketing',
})
```

The wrapper view receives the converted `html`, the original `markdown`, the `text`, and the `subject`, `from`, `replyTo`, `to`, `cc`, `bcc`, `headers`, `tags`, `metadata`, and `priority`. `markdownWrapper` only works on Markdown mail.

::: warning
Wrappers are rendered through a view renderer, which the default Next.js, Nuxt, and SvelteKit setups don't provide. Without one, sending a wrapped mail throws. Leave `wrapper` unset unless you have configured a renderer.
:::

## Next steps

- [Writing mail](/mail/writing-mail)
- [Previewing mail](/mail/previewing)
