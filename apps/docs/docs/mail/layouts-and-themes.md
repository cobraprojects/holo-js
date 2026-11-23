# Mail Layouts and Themes

Every [Markdown mail](/mail/markdown) is wrapped in a Mail layout and styled by a Mail theme. The layout adds the parts every email shares, such as a header and a footer. The theme is a CSS file that Holo inlines into the HTML, so the styles survive in clients like Gmail and Outlook that ignore `<style>` blocks.

Layouts and themes apply only to mails that use `markdown`. Mails sent with `html`, `text`, or `render` are sent as given.

## Default layout

Without any layout files, Holo uses its default Mail layout, which matches Laravel's:

- a header with your app's name, linking to your app's URL,
- the rendered Mail template in a white panel,
- the footer `© 2026 Your App. All rights reserved.`, with the current year.

The name and URL come from `name` and `url` in `config/app.ts`.

```ts [config/app.ts]
import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  name: env('APP_NAME', 'Acme'),
  url: env('APP_URL', 'https://acme.test'),
})
```

There is no logo or brand setting. To add a logo, change colors, or change the footer, write your own layout.

## Custom layout

Create `server/mail/layout.html` to replace the default HTML layout. It uses the same placeholders and directives as a [Mail template](/mail/markdown#placeholders), including `@if` and `@include`, but it is HTML, not Markdown. A layout receives these values:

| Value | Contains |
| --- | --- |
| `app.name` | `name` from `config/app.ts`. |
| `app.url` | `url` from `config/app.ts`. |
| `subject` | The mail's subject. |
| `year` | The current year. |
| `body` | The rendered Mail template. Output it with `{!! body !!}`. |

```html [server/mail/layout.html]
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>{{ subject }}</title>
</head>
<body>
<table class="wrapper" width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr>
<td class="header">
<a href="{{ app.url }}"><img src="https://acme.test/logo.png" class="logo" alt="{{ app.name }}"></a>
</td>
</tr>
<tr>
<td class="content-cell">
{!! body !!}
</td>
</tr>
<tr>
<td class="footer">
<p>© {{ year }} {{ app.name }}. All rights reserved.</p>
</td>
</tr>
</table>
</body>
</html>
```

`body` is HTML that Holo already rendered and escaped, so output it with `{!! body !!}`. `{{ body }}` would show the HTML tags as text.

### Plain-text layout

The plain-text part of a Markdown mail uses a plain-text layout. The default one puts `App Name: https://app.url` above the body and the same footer below it. Create `server/mail/layout.txt` to replace it:

```txt [server/mail/layout.txt]
{{ app.name }}

{!! body !!}

Questions? Reply to this email.
```

The two layouts are independent. A `layout.html` without a `layout.txt` keeps the default plain-text layout, and a `layout.txt` without a `layout.html` keeps the default HTML layout.

## Themes

A Mail theme is a CSS file in `server/mail/themes`. Holo inlines its rules into the `style` attribute of each element they match after wrapping the mail in its layout. Rules that can't be inlined, such as `@media` queries, are dropped, so put those in a `<style>` block in your layout, as the default layout does. A layout uses [Mail template directives](/mail/markdown#conditions-loops-and-includes), so write `@@media` there to output a literal `@media`.

Holo ships a built-in `default` theme, the same as Laravel's. It styles the default layout, headings, paragraphs, links, and tables, and the `button`, `panel`, `table`, and `subcopy` classes. To change it, create `server/mail/themes/default.css`, which replaces the built-in theme completely:

```css [server/mail/themes/default.css]
body {
    background-color: #f8fafc;
    color: #334155;
}

h1 {
    color: #0f172a;
    font-size: 20px;
}

.footer p {
    color: #94a3b8;
    font-size: 12px;
}
```

Add more themes as more files, such as `server/mail/themes/receipt.css`. A theme's name is its path inside `server/mail/themes` without `.css`.

### Choose a theme

Set the theme for every Markdown mail with `markdown.theme` in `config/mail.ts`. It defaults to `'default'`.

```ts [config/mail.ts]
import { defineMailConfig } from '@holo-js/mail'

export default defineMailConfig({
  markdown: {
    theme: 'default',
  },
})
```

Set `theme` on a mail to use a different theme for that mail only:

```ts
defineMail({
  to: 'ava@example.com',
  subject: 'Your receipt',
  markdown: 'orders/receipt',
  data: { orderNumber: 'A-1001' },
  theme: 'receipt',
})
```

`holo prepare` generates the theme names, so an unknown name in `theme` or `markdown.theme` is a type error. If a mail names a theme that isn't in the generated registry, for example after you delete the file without running `holo prepare`, sending it throws `Mail theme "receipt" is not registered`.

## Preparing layouts and themes

`holo prepare` compiles `layout.html`, `layout.txt`, and every theme into the generated registry together with your Mail templates, so your app doesn't read these files when it sends mail. `holo dev` recompiles them when you save. After changing them outside `holo dev`, run `npx holo prepare`. A syntax error in a layout, such as an unclosed `{{`, fails `holo prepare` with the file name and line.

## Next steps

- [Markdown mail](/mail/markdown)
- [Previewing mail](/mail/previewing)
- [Configuration reference](/reference/config#mail-ts)
