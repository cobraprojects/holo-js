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

Mail templates are `.md` files under `server/mail/templates`. A template's name is its path inside that folder without the extension, so `server/mail/templates/orders/shipped.md` is `orders/shipped`. Each part of the name starts with a letter or number and uses only letters, numbers, `-`, and `_`; `holo prepare` fails for a template file with any other name, such as `shipped.v2.md`. A mail names its template with `markdown` and passes the values the template uses as `data`.

`npx holo make:mail` creates a mail definition together with its template. See [Writing mail](/mail/writing-mail#generate-a-mail-file).

`holo prepare` compiles every template into the generated registry, so your app doesn't read template files when it sends mail. `holo dev` recompiles a template when you save it, and `holo` commands such as `holo queue:work` recompile changed mail files before they run. Otherwise, run `npx holo prepare` after adding or changing a template. A template with a syntax error, such as an unclosed `{{` or `@if`, or an include cycle, fails `holo prepare` with the template name and line.

## Placeholders

| Syntax | Output |
| --- | --- |
| `{{ name }}` | The value of `name`, with HTML escaped. |
| `{!! name !!}` | The value of `name` exactly as given. |
| `{{ customer.address.city }}` | A nested value, reached with a dot path. |

A placeholder holds a dot path and nothing else. Templates never run JavaScript: there are no operators, function calls, or filters, so format values before you pass them. The names `__proto__`, `constructor`, and `prototype` can't appear in a dot path, a loop item name, or a component attribute name; a template that uses them fails `holo prepare`.

::: danger
`{!! !!}` outputs HTML exactly as given. Never use it for values that come from users, or they can inject HTML into your email. Use it only for HTML you built yourself.
:::

HTML you write in the template itself is output as written, so you can add elements Markdown can't express:

```md
<p align="center">Thanks for your order, {{ customer.name }}!</p>
```

::: warning
Placeholders are filled before the Markdown is parsed, and `{{ }}` escapes only HTML. A value is still parsed as Markdown, so a value from a user such as `[Claim your prize](https://example.com)` becomes a link, and `# ` or `*` turn into a heading or emphasis. Don't put values from users where Markdown formatting would matter, such as on a line of their own, or remove Markdown syntax from them before you pass them as `data`.
:::

## Conditions, loops, and includes

Templates support Blade-style directives. Each takes a dot path or a template name and nothing else.

| Directive | Output |
| --- | --- |
| `@if (path)` … `@else` … `@endif` | The first block when the value at `path` is truthy, otherwise the `@else` block. `@else` is optional. |
| `@foreach (path as name)` … `@endforeach` | The block once for each item of the list at `path`. Inside the block, `name` is the current item. |
| `@include (name)` | Another Mail template, which sees the same `data` and the loop items in scope where it is included. |

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

`@if` only tests whether a value is truthy, the way Laravel's Blade does. A missing value, `null`, `false`, `0`, `''`, `'0'`, an empty list, and an empty object are false; every other value is true. There are no operators, comparisons, or function calls, so compute flags such as `isOverdue` before you pass them.

A line that holds only a directive leaves no blank line behind, so `@foreach` can produce the rows of a Markdown table. Directives also work inside a line, as long as the `@` doesn't follow a letter, digit, or `_`. Any other `@` word, such as `@holo` or `@media`, is output as written. To output a directive name as text, write `@@`, as in `@@if`. Email addresses such as `help@example.com` need no escaping.

A loop item's name hides a `data` value with the same name inside the loop. An included template sees the mail's `data` and, when it is included inside `@foreach`, the loop's current item by its name. An included template can include others, but a template that includes itself, directly or through other templates, fails `holo prepare`.

## Typed data

`holo prepare` generates a type for each template's `data` from the placeholders and directives it uses:

- A value used in `{{ }}` or `{!! !!}` must be a `string` or `number`.
- A value used only in `@if` is optional and can be any JSON value.
- A value used in `@foreach` must be a list. The shape of its items comes from how the loop uses them: `line.name` in the example above requires items with a `name`.
- The values an included template uses are required by every template that includes it. Inside `@foreach`, the included template's values that start with the loop item's name are part of the item shape: `{{ line.name }}` in a template included in the loop above requires items with a `name`.

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

Attribute values are strings and can contain placeholders. A `{{ }}` placeholder inside an attribute is escaped where the attribute is written, so `url="{{ order.url }}"` is safe for values that come from users, whichever way the component outputs it.

A button's `url` must be an absolute `http:` or `https:` URL. Sending a mail whose button has a missing, relative, `javascript:`, or `mailto:` URL throws an error, so a broken button is never sent. Plain Markdown links such as `[Track order](https://example.com)` stay normal links.

Components are part of the template, not of `data`: a value that contains `<mail::button>` is output as escaped text and never creates a component. An unknown component tag, such as `<mail::buton>`, fails `holo prepare` with the template name and line.

### Adding components

Add your own component with `server/mail/components/<name>.html`. The file name is the tag name, so `alert.html` adds `<mail::alert>`. A component file uses the same placeholders and directives as a Mail template, but it is HTML, not Markdown. It receives each attribute of the tag as a value, and the rendered content of the tag as `slot`:

```html [server/mail/components/alert.html]
<table class="alert alert-{{ type }}" width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr>
<td>
{!! slot !!}
</td>
</tr>
</table>
```

```md [server/mail/templates/billing/expiring.md]
<mail::alert type="warning">
Your plan expires on **{{ date }}**.
</mail::alert>
```

`slot` is HTML that Holo already rendered from the tag's Markdown content, so output it with `{!! slot !!}`. Output attributes with `{{ }}`, as `{{ type }}` does above. An attribute that contains a placeholder is already escaped HTML, so `{{ }}` outputs it as is and doesn't escape it twice. An attribute written without placeholders is plain text: `{{ }}` escapes it and `{!! !!}` outputs it exactly as written. An attribute the tag doesn't set is missing, so check optional attributes with `@if` before you output them.

Add `server/mail/components/<name>.txt` for the component's plain-text form. It receives the same values, and its `slot` is the content's Markdown, which the plain-text part turns into plain text:

```txt [server/mail/components/alert.txt]
WARNING: {!! slot !!}
```

A component without a `.txt` file shows its content as plain text in the plain-text part. Style a component's classes in your [Mail theme](/mail/layouts-and-themes#themes).

Component names start with a lowercase letter and use letters, digits, `-`, and `_`. Components can use other components, but a component that uses itself, directly or through other components, fails `holo prepare`.

### Overriding components

A component file named after a built-in component replaces it. For example, `server/mail/components/button.html` replaces the button's HTML. It receives `url`, `color` (`primary` when the tag doesn't set it), and the label as `slot`:

```html [server/mail/components/button.html]
<table class="action" align="center" width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr>
<td align="center">
<a href="{{ url }}" class="button button-{{ color }}" target="_blank" rel="noopener">{!! slot !!}</a>
</td>
</tr>
</table>
```

To edit the built-in components' own files, run `npx holo mail:publish`, which copies them into `server/mail/components` along with the [Mail layout and theme](/mail/layouts-and-themes#publishing-the-defaults).

The HTML and plain-text forms are independent. A `button.html` without a `button.txt` keeps the built-in `Label: URL` text, and a `button.txt` without a `button.html` keeps the built-in HTML. An overridden button still requires an absolute `http:` or `https:` `url`.

`holo prepare` compiles your component files into the generated registry together with your Mail templates, and makes their tags valid in templates and layouts. `holo dev` recompiles them when you save; after changing them outside `holo dev`, run `npx holo prepare`.

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

Holo builds the plain-text part from the same filled-in template with the syntax removed: headings, emphasis, and code lose their markers, links become `label (url)`, buttons become `Label: URL`, images become their alt text, lists keep a `-` or number per item, table rows become cells separated by `|`, and HTML tags are dropped. The plain-text [Mail layout](/mail/layouts-and-themes#plain-text-layout) then adds its header and footer. To write your own plain-text version, pass `text` as well. Holo sends it exactly as given, without the layout:

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
