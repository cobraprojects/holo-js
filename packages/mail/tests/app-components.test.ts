import { afterEach, describe, expect, it } from 'vitest'
import {
  defineMail,
  listFakeSentMails,
  resetFakeSentMails,
  resetMailRuntime,
  sendMail,
  type MailJsonObject,
} from '../src'
import { compileMailRegistry, type MailRegistrySources } from '../src/templates'
import { configureFakeMailerWithTemplates } from './support/mail-templates'

async function sendWithComponents(
  source: string,
  components: MailRegistrySources['components'],
  data: MailJsonObject = {},
): Promise<{ readonly html: string, readonly text: string }> {
  configureFakeMailerWithTemplates({ fixture: source }, components)
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Components', markdown: 'fixture', data }))
  const mail = listFakeSentMails()[0]?.mail
  return { html: mail?.html ?? '', text: mail?.text ?? '' }
}

const ALERT_HTML = '<div class="alert alert-{{ type }}">{!! slot !!}</div>'

afterEach(() => {
  resetFakeSentMails()
  resetMailRuntime()
})

describe('App Mail components', () => {
  it('replaces the built-in button HTML while the built-in text form still applies', async () => {
    const mail = await sendWithComponents(
      '<mail::button url="https://example.test/orders/1">View Order</mail::button>',
      { button: { html: '<a class="cta cta-{{ color }}" href="{{ url }}">{!! slot !!}</a>' } },
    )

    expect(mail.html).toBe('<p><a class="cta cta-primary" href="https://example.test/orders/1">View Order</a></p>')
    expect(mail.text).toBe('View Order: https://example.test/orders/1')
  })

  it('replaces the built-in button text form', async () => {
    const mail = await sendWithComponents(
      '<mail::button url="https://example.test/orders/1">View Order</mail::button>',
      { button: { text: '{!! slot !!} -> {!! url !!}' } },
    )

    expect(mail.html).toContain('<a href="https://example.test/orders/1" class="button button-primary"')
    expect(mail.text).toBe('View Order -> https://example.test/orders/1')
  })

  it('renders an app-defined component with its attributes and Markdown slot', async () => {
    const mail = await sendWithComponents(
      [
        '# Heads up',
        '',
        '<mail::alert type="warning">',
        'Your plan expires **{{ date }}**.',
        '</mail::alert>',
      ].join('\n'),
      { alert: { html: ALERT_HTML, text: 'WARNING: {!! slot !!}' } },
      { date: 'tomorrow' },
    )

    expect(mail.html).toBe('<h1>Heads up</h1>\n<div class="alert alert-warning"><p>Your plan expires <strong>tomorrow</strong>.</p></div>')
    expect(mail.text).toBe('Heads up\n\nWARNING: Your plan expires tomorrow.')
  })

  it('renders the slot plain text for an app-defined component without a text form', async () => {
    const mail = await sendWithComponents(
      'Hello\n\n<mail::alert type="info">\nRead the [guide](https://example.test/guide).\n</mail::alert>',
      { alert: { html: ALERT_HTML } },
    )

    expect(mail.text).toBe('Hello\n\nRead the guide (https://example.test/guide).')
  })

  it('escapes attribute values in component output', async () => {
    const mail = await sendWithComponents(
      '<mail::alert type="{{ kind }}">Careful</mail::alert>',
      { alert: { html: ALERT_HTML } },
      { kind: '"><script>alert(1)</script>' },
    )

    expect(mail.html).toBe('<div class="alert alert-&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"><p>Careful</p></div>')
  })

  it('lets app components use other Mail components', async () => {
    const mail = await sendWithComponents(
      '<mail::notice>Check it</mail::notice>',
      { notice: { html: '<mail::alert type="info">{!! slot !!}</mail::alert>' }, alert: { html: ALERT_HTML } },
    )

    expect(mail.html).toBe('<div class="alert alert-info"><p>Check it</p></div>')
  })

  it.each([
    [
      'a cycle between app components',
      { alert: { html: '<mail::box>{!! slot !!}</mail::box>' }, box: { html: '<mail::alert>{!! slot !!}</mail::alert>' } },
      'Mail component "alert" creates a component cycle: alert -> box -> alert.',
    ],
    [
      'a component that uses itself',
      { alert: { html: 'Hi', text: '<mail::alert>{!! slot !!}</mail::alert>' } },
      'Mail component "alert" creates a component cycle: alert -> alert.',
    ],
    [
      'a text form without an HTML form for an app-defined component',
      { alert: { text: '{!! slot !!}' } },
      'Mail component "alert" has a text form but no HTML form. Add server/mail/components/alert.html.',
    ],
    [
      'an unknown component tag inside a component',
      { alert: { html: '<mail::bx>{!! slot !!}</mail::bx>' } },
      'Mail template "components/alert.html" line 1: <mail::bx> is not a Mail component.',
    ],
    [
      'a component name that cannot be used as a tag',
      { Alert: { html: '{!! slot !!}' } },
      '"Alert" is not a Mail component name. Start it with a lowercase letter and use letters, digits, "-" and "_".',
    ],
  ])('rejects %s when compiling', (_label, components, message) => {
    expect(() => compileMailRegistry({ templates: {}, components })).toThrow(message)
  })

  it('makes app components valid tags in Mail templates', () => {
    expect(() => compileMailRegistry({ templates: { welcome: '<mail::alert>Hi</mail::alert>' } }))
      .toThrow('<mail::alert> is not a Mail component.')
    expect(() => compileMailRegistry({ templates: { welcome: '<mail::alert>Hi</mail::alert>' }, components: { alert: { html: ALERT_HTML } } }))
      .not.toThrow()
  })
})
