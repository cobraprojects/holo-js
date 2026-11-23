# Markdown Mail

Write the content of an email in a Mail template, a Markdown file with placeholders, and Holo turns it into HTML and a plain-text version. Holo wraps the result in a Mail layout and styles it with a Mail theme, so it looks finished without extra work. This is the quickest way to write transactional email that reads well in every client.

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

`holo prepare` compiles every template into the generated registry, so your app doesn't read template files when it sends mail. `holo dev` recompiles a template when you save it. After adding or changing a template outside `holo dev`, run `npx holo prepare`. A template with a syntax error, such as an unclosed `{{` or `@if`, an unknown directive, or an include cycle, fails `holo prepare` with the template name and line.

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

## Conditions, loops, and includes

Templates support Blade-style directives. Each takes a dot path or a template name and nothing else.

| Directive | Output |
| --- | --- |
| `@if (path)` … `@else` … `@endif` | The first block when the value at `path` is truthy, otherwise the `@else` block. `@else` is optional. |
| `@foreach (path as name)` … `@endforeach` | The block once for each item of the list at `path`. Inside the block, `name` is the current item. |
| `@include (name)` | Another Mail template, which sees the same `data`. |

```md [server/mail/templates/orders/shipped.md]
# Order {{ order.number }} shipped

@if (order.isGift)
This order is wrapped as a gift.
@else
Thanks for your order!
@endif

| Item | Qty |
| :--- | ---: |
@foreach (order.lines as line)
| {{ line.name }} | {{ line.quantity }} |
@endforeach

@include (partials/support)
```

```md [server/mail/templates/partials/support.md]
Questions? Contact us at {{ support.email }}.
```

`@if` only tests whether a value is truthy. A missing value, `null`, `false`, `0`, and `''` are false; every other value, including an empty list, is true. There are no operators, comparisons, or function calls, so compute flags such as `isOverdue` before you pass them.

A line that holds only a directive leaves no blank line behind, so `@foreach` can produce the rows of a Markdown table. Directives also work inside a line, as long as the `@` doesn't follow a letter, digit, or `_`. Write `@@` to output a literal `@` before a word, as in `@@holo`. Email addresses such as `help@example.com` need no escaping.

A loop item's name hides a `data` value with the same name inside the loop. An included template always sees the mail's `data`, even inside a loop. An included template can include others, but a template that includes itself, directly or through other templates, fails `holo prepare`.

## Typed data

`holo prepare` generates a type for each template's `data` from the placeholders and directives it uses:

- A value used in `{{ }}` or `{!! !!}` must be a `string` or `number`.
- A value used only in `@if` is optional and can be any JSON value.
- A value used in `@foreach` must be a list. The shape of its items comes from how the loop uses them: `line.name` in the example above requires items with a `name`.
- The values an included template uses are required by every template that includes it.

An unknown template name, a missing value, or a value of the wrong type is a type error, and your editor autocompletes template names and `data`.

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

`data` must be JSON-serializable. A `Date`, a class instance, or a function is a type error; format such values first, as `shippedOn` does above. A template without placeholders, or with only `@if` values, needs no `data`.

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

Holo builds the plain-text body from the same filled-in template with the syntax removed: headings, emphasis, and code lose their markers, links become `label (url)`, images become their alt text, lists keep a `-` or number per item, table rows become cells separated by `|`, and HTML tags are dropped. The plain-text [Mail layout](/mail/layouts-and-themes#plain-text-layout) then adds its header and footer. To write your own plain-text version, pass `text` as well. Holo sends it exactly as given, without the layout:

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

- [Layouts and themes](/mail/layouts-and-themes)
- [Writing mail](/mail/writing-mail)
- [Previewing mail](/mail/previewing)
