# Markdown Mail

Write the content of an email in a Mail template, a Markdown file with placeholders, and Holo turns it into HTML and a plain-text version. This is the quickest way to write transactional email that reads well in every client.

```md [server/mail/templates/password-changed.md]
# Password changed

Hi {{ user.name }},

your password was changed **just now**.

If this wasn't you:

- [Reset your password]({{ resetUrl }})
- Contact support at [help@example.com](mailto:help@example.com)
```

```ts [server/mail/password-changed.ts]
import { defineMail } from '@holo-js/mail'

function PasswordChangedMail(input: { readonly to: string, readonly name: string }) {
  return defineMail({
    to: input.to,
    subject: 'Your password was changed',
    markdown: 'password-changed',
    data: {
      user: { name: input.name },
      resetUrl: 'https://app.example.com/forgot-password',
    },
  })
}

export default PasswordChangedMail
```

## Mail templates

Mail templates are `.md` files under `server/mail/templates`. A template's name is its path inside that folder without the extension, so `server/mail/templates/orders/shipped.md` is `orders/shipped`. A mail names its template with `markdown` and passes the values the template uses as `data`.

`npx holo make:mail` creates a mail definition together with its template. See [Writing mail](/mail/writing-mail#generate-a-mail-file).

`holo prepare` compiles every template into the generated registry, so your app doesn't read template files when it sends mail. `holo dev` recompiles a template when you save it. After adding or changing a template outside `holo dev`, run `npx holo prepare`. A template with a syntax error, such as an unclosed `{{`, fails `holo prepare` with the template name and line.

## Placeholders

| Syntax | Output |
| --- | --- |
| `{{ name }}` | The value of `name`, with HTML escaped. |
| `{!! name !!}` | The value of `name` exactly as given. |
| `{{ customer.address.city }}` | A nested value, reached with a dot path. |

A placeholder holds a dot path and nothing else. Templates never run JavaScript: there are no operators, function calls, or filters, so format values before you pass them.

::: danger
`{!! !!}` outputs HTML exactly as given. Never use it for values that come from users, or they can inject HTML into your email. Use it only for HTML you built yourself.
:::

HTML you write in the template itself is output as written, so you can add elements Markdown can't express:

```md
<p align="center">Thanks for your order, {{ customer.name }}!</p>
```

Placeholders are filled before the Markdown is parsed, so a value can still contain Markdown syntax such as `*`. `{{ }}` only escapes HTML.

## Typed data

`holo prepare` generates a type for each template's `data` from the placeholders it uses. Each value used in `{{ }}` or `{!! !!}` must be a `string` or `number`. An unknown template name, a missing value, or a value of the wrong type is a type error, and your editor autocompletes template names and `data`.

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Your order shipped',
  markdown: 'orders/shipped',
  data: {
    order: { number: 'A-1001' },
    shippedOn: new Date().toLocaleDateString('en-US'),
  },
})
```

`data` must be JSON-serializable. A `Date`, a class instance, or a function is a type error; format such values first, as `shippedOn` does above. A template without placeholders needs no `data`.

## Mail components

Mail components add email-ready blocks to a template. Write a component as a tag with the `mail::` prefix, its attributes, and its content:

```md [server/mail/templates/orders/shipped.md]
# Your order shipped

<mail::panel>
Order **{{ order.number }}** is on its way.
</mail::panel>

<mail::button url="{{ order.url }}" color="success">
Track Order
</mail::button>

<mail::table>
| Item | Qty | Price |
| :--- | :---: | ---: |
| Notebook | 2 | $10 |
</mail::table>

<mail::subcopy>
Questions? [Contact support](https://example.com/support).
</mail::subcopy>
```

| Component | Attributes | Renders |
| --- | --- | --- |
| `<mail::button>` | `url` (required), `color`: `primary` (default), `success`, or `error` | A call-to-action button. The content is the button label. |
| `<mail::panel>` | None | A highlighted block. |
| `<mail::table>` | None | A Markdown table with the theme's table styling. |
| `<mail::subcopy>` | None | Small print, such as a footnote below the main content. |

The content of a component is Markdown, so you can use bold text, links, and tables inside it. Put each opening and closing tag on its own line with a blank line before and after the component, as in the example above.

Attribute values are strings and can contain placeholders. A component escapes attribute values when it outputs them, so `url="{{ order.url }}"` is safe for values that come from users.

A button's `url` must be an absolute `http:` or `https:` URL. Sending a mail whose button has a missing, relative, `javascript:`, or `mailto:` URL throws an error, so a broken button is never sent. Plain Markdown links such as `[Track order](https://example.com)` stay normal links.

Components are part of the template, not of `data`: a value that contains `<mail::button>` is output as escaped text and never creates a component. An unknown component tag, such as `<mail::buton>`, fails `holo prepare` with the template name and line.

## Supported syntax

Holo renders Markdown with [CommonMark](https://commonmark.org) plus GitHub-style tables.

| Markdown | Result |
| --- | --- |
| `# Heading` to `###### Heading` | `<h1>` to `<h6>` |
| Lines of text | A paragraph. A single line break stays inside the paragraph; end a line with two spaces or `\` to force a `<br />`. |
| Lines starting with `- `, `* `, or `+ ` | A bulleted list. Indent items to nest lists. |
| Lines starting with `1. ` or `1) ` | A numbered list. |
| `> Quote` | A block quote. |
| ```` ``` ```` fences or four-space indentation | A code block. A language after the opening fence adds a `language-*` class. |
| `---`, `***`, or `___` | A horizontal rule. |
| `**bold**` | `<strong>` |
| `*italic*` | `<em>` |
| `` `code` `` | `<code>` |
| `[label](url)` or `<https://example.com>` | A link. |
| `![alt](url "title")` | An image. |
| Pipe tables with a `\| --- \|` separator row | A table. Use `:---`, `:---:`, or `---:` to align a column. |
| HTML tags | Output as written. |

```md
| Item | Price |
| :--- | ---: |
| Pro plan | $10 |
```

## Safety

`{{ }}` escapes HTML in values, so it's safe for values that come from users, like names. Markdown links and images only render for `http:`, `https:`, and `mailto:` URLs, plus relative paths (`/`, `./`, `../`, `#`). Any other link, such as `javascript:`, renders as its label text only, and any other image renders as its alt text only.

## Plain-text version

Holo builds the plain-text part from the same filled-in template with the syntax removed: headings, emphasis, and code lose their markers, links become `label (url)`, buttons become `Label: URL`, images become their alt text, lists keep a `-` or number per item, table rows become cells separated by `|`, and HTML tags are dropped. To write your own plain-text version, pass `text` as well:

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Welcome',
  markdown: 'welcome',
  text: 'Welcome! Thanks for joining.',
})
```

## Queued mail

A queued Markdown mail stores its template name and `data`. The worker renders the template when it sends the mail, so a queued mail renders the same as one sent immediately. See [Queueing mail](/mail/queueing).

## Next steps

- [Writing mail](/mail/writing-mail)
- [Previewing mail](/mail/previewing)
