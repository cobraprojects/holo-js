import { afterEach, describe, expect, it } from 'vitest'
import {
  defineMail,
  listFakeSentMails,
  resetFakeSentMails,
  resetMailRuntime,
  sendMail,
  type MailJsonObject,
} from '../src'
import { compileMailRegistry } from '../src/templates'
import { configureFakeMailerWithTemplates } from './support/mail-templates'

async function sendTemplate(source: string, data: MailJsonObject = {}): Promise<{ readonly html: string, readonly text: string }> {
  configureFakeMailerWithTemplates({ fixture: source })
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Components', markdown: 'fixture', data }))
  const mail = listFakeSentMails()[0]?.mail
  return { html: mail?.html ?? '', text: mail?.text ?? '' }
}

function button(url: string, color: string, label: string): string {
  return [
    '<table class="action" align="center" width="100%" cellpadding="0" cellspacing="0" role="presentation">',
    '<tr>',
    '<td align="center">',
    '<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">',
    '<tr>',
    '<td align="center">',
    '<table border="0" cellpadding="0" cellspacing="0" role="presentation">',
    '<tr>',
    '<td>',
    `<a href="${url}" class="button button-${color}" target="_blank" rel="noopener">${label}</a>`,
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
  ].join('\n')
}

afterEach(() => {
  resetFakeSentMails()
  resetMailRuntime()
})

describe('Mail components', () => {
  it('renders a button as an HTML call to action and as "Label: URL" text', async () => {
    const mail = await sendTemplate([
      '# Order shipped',
      '',
      '<mail::button url="{{ url }}">',
      'View Order',
      '</mail::button>',
      '',
      'Thanks',
    ].join('\n'), { url: 'https://example.test/orders/1' })

    expect(mail.html).toBe([
      '<h1>Order shipped</h1>',
      button('https://example.test/orders/1', 'primary', 'View Order'),
      '<p>Thanks</p>',
    ].join('\n'))
    expect(mail.text).toBe('Order shipped\n\nView Order: https://example.test/orders/1\n\nThanks')
  })

  it('renders each button color with its own class', async () => {
    const mail = await sendTemplate([
      '<mail::button url="https://example.test/a" color="success">Approve</mail::button>',
      '',
      '<mail::button url="https://example.test/b" color="error">Cancel</mail::button>',
    ].join('\n'))

    expect(mail.html).toContain('class="button button-success" target="_blank" rel="noopener">Approve</a>')
    expect(mail.html).toContain('class="button button-error" target="_blank" rel="noopener">Cancel</a>')
  })

  it.each([
    ['a relative URL', 'url="/orders/1"'],
    ['a javascript: URL', 'url="javascript:alert(1)"'],
    ['a mailto: URL', 'url="mailto:ava@example.com"'],
    ['no URL', ''],
  ])('fails rendering a button with %s', async (_label, attribute) => {
    await expect(sendTemplate(`<mail::button ${attribute}>Open</mail::button>`))
      .rejects.toThrow('Mail component "button" in Mail template "fixture" requires an absolute http or https "url".')
  })

  it('escapes attribute values once in the HTML and keeps the URL in the text', async () => {
    const mail = await sendTemplate(
      '<mail::button url="{{ url }}">Search</mail::button>',
      { url: 'https://example.test/search?a=1&b="x"' },
    )

    expect(mail.html).toContain('<a href="https://example.test/search?a=1&amp;b=&quot;x&quot;" class="button button-primary"')
    expect(mail.text).toBe('Search: https://example.test/search?a=1&b="x"')
  })

  it('keeps button URLs containing Markdown delimiters exactly in the text', async () => {
    const url = 'https://example.test/_reset_/token*1*/[a](b)/`code`/~x~/<y>/#z\\w'
    const mail = await sendTemplate(
      '<mail::button url="{{ url }}">Reset</mail::button>\n\n<mail::button url="https://example.test/__literal__/*path*">Literal</mail::button>',
      { url },
    )

    expect(mail.text).toBe(`Reset: ${url}\n\nLiteral: https://example.test/__literal__/*path*`)
    expect(mail.html).toContain('<a href="https://example.test/_reset_/token*1*/[a](b)/`code`/~x~/&lt;y&gt;/#z\\w" class="button button-primary"')
    expect(mail.html).toContain('<a href="https://example.test/__literal__/*path*" class="button button-primary"')
  })

  it('escapes the written parts of an attribute with placeholders once and validates the unescaped URL', async () => {
    const mail = await sendTemplate(
      '<mail::button url="https://example.test/orders?id={{ id }}&ref=mail">Open</mail::button>',
      { id: '7&8' },
    )

    expect(mail.html).toContain('<a href="https://example.test/orders?id=7&amp;8&amp;ref=mail" class="button button-primary"')
    expect(mail.text).toBe('Open: https://example.test/orders?id=7&8&ref=mail')
    await expect(sendTemplate('<mail::button url="{{ url }}">Open</mail::button>', { url: 'javascript:alert(1)' }))
      .rejects.toThrow('requires an absolute http or https "url".')
  })

  it('renders panel, table, and subcopy content as Markdown', async () => {
    const mail = await sendTemplate([
      '<mail::panel>',
      'Your code is **{{ code }}**.',
      '</mail::panel>',
      '',
      '<mail::table>',
      '| Item | Price |',
      '| --- | ---: |',
      '| Plan | $10 |',
      '</mail::table>',
      '',
      '<mail::subcopy>',
      'Questions? [Contact us](https://example.test/help).',
      '</mail::subcopy>',
    ].join('\n'), { code: 'A-1' })

    expect(mail.html).toContain([
      '<table class="panel" width="100%" cellpadding="0" cellspacing="0" role="presentation">',
      '<tr>',
      '<td class="panel-content">',
      '<table width="100%" cellpadding="0" cellspacing="0" role="presentation">',
      '<tr>',
      '<td class="panel-item">',
      '<p>Your code is <strong>A-1</strong>.</p>',
      '</td>',
      '</tr>',
      '</table>',
      '</td>',
      '</tr>',
      '</table>',
    ].join('\n'))
    expect(mail.html).toMatch(/<div class="table">\n<table>\n<thead>[\s\S]*<td>Plan<\/td>[\s\S]*<\/table>\n<\/div>/)
    expect(mail.html).toContain([
      '<table class="subcopy" width="100%" cellpadding="0" cellspacing="0" role="presentation">',
      '<tr>',
      '<td>',
      '<p>Questions? <a href="https://example.test/help">Contact us</a>.</p>',
      '</td>',
      '</tr>',
      '</table>',
    ].join('\n'))
    expect(mail.text).toBe([
      'Your code is A-1.',
      '',
      'Item | Price',
      'Plan | $10',
      '',
      'Questions? Contact us (https://example.test/help).',
    ].join('\n'))
  })

  it('renders components inside directives and directives inside components', async () => {
    configureFakeMailerWithTemplates({
      'fixture': [
        '@foreach (links as link)',
        '<mail::button url="{{ link.url }}">{{ link.label }}</mail::button>',
        '',
        '@endforeach',
        '<mail::panel>',
        '@if (paid)',
        'Paid in full.',
        '@else',
        'Payment due.',
        '@endif',
        '@include (partials/help)',
        '</mail::panel>',
      ].join('\n'),
      'partials/help': 'Questions? Email **{{ support }}**.\n',
    })
    const send = async (paid: boolean): Promise<{ readonly html: string, readonly text: string }> => {
      resetFakeSentMails()
      await sendMail(defineMail({
        to: 'ava@example.com',
        subject: 'Components',
        markdown: 'fixture',
        data: {
          paid,
          support: 'help@example.test',
          links: [
            { url: 'https://example.test/orders/1', label: 'View Order' },
            { url: 'https://example.test/invoices/1', label: 'Invoice' },
          ],
        },
      }))
      const mail = listFakeSentMails()[0]?.mail
      return { html: mail?.html ?? '', text: mail?.text ?? '' }
    }
    const panel = (status: string): string => [
      '<table class="panel" width="100%" cellpadding="0" cellspacing="0" role="presentation">',
      '<tr>',
      '<td class="panel-content">',
      '<table width="100%" cellpadding="0" cellspacing="0" role="presentation">',
      '<tr>',
      '<td class="panel-item">',
      `<p>${status}\nQuestions? Email <strong>help@example.test</strong>.</p>`,
      '</td>',
      '</tr>',
      '</table>',
      '</td>',
      '</tr>',
      '</table>',
    ].join('\n')

    const paid = await send(true)
    const due = await send(false)

    expect(paid.html).toBe([
      button('https://example.test/orders/1', 'primary', 'View Order'),
      button('https://example.test/invoices/1', 'primary', 'Invoice'),
      panel('Paid in full.'),
    ].join('\n'))
    expect(due.html).toContain(panel('Payment due.'))
    expect(paid.text).toBe([
      'View Order: https://example.test/orders/1',
      '',
      'Invoice: https://example.test/invoices/1',
      '',
      'Paid in full.',
      'Questions? Email help@example.test.',
    ].join('\n'))
  })

  it('does not create components from data values', async () => {
    const mail = await sendTemplate('{{ comment }}', {
      comment: '<mail::button url="https://evil.test">Claim</mail::button>',
    })

    expect(mail.html).toBe('<p>&lt;mail::button url=&quot;https://evil.test&quot;&gt;Claim&lt;/mail::button&gt;</p>')
    expect(mail.html).not.toContain('class="button')
  })

  it('keeps plain Markdown links as normal links', async () => {
    const mail = await sendTemplate('[View order](https://example.test/orders/1)')

    expect(mail.html).toBe('<p><a href="https://example.test/orders/1">View order</a></p>')
  })

  it.each([
    ['an unknown component', 'Hello\n<mail::alert>Careful</mail::alert>', 'line 2: <mail::alert> is not a Mail component.'],
    ['an unclosed component', '<mail::panel>\nOpen', 'line 1: <mail::panel> is not closed with </mail::panel>.'],
    ['a mismatched closing tag', '<mail::panel>Open</mail::subcopy>', 'line 1: </mail::subcopy> does not close an open <mail::subcopy>.'],
    ['a malformed component tag', '<mail::button url=https://example.test>Open</mail::button>', 'line 1: Malformed Mail component tag.'],
  ])('rejects %s when compiling', (_label, source, message) => {
    expect(() => compileMailRegistry({ templates: { broken: source } }))
      .toThrow(`Mail template "broken" ${message}`)
  })
})
