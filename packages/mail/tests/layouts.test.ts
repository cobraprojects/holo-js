import { decodeHTML } from 'entities'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureMailRuntime,
  defineMail,
  listFakeSentMails,
  normalizeMailConfig,
  resetFakeSentMails,
  resetMailRuntime,
  sendMail,
  type HoloMailConfig,
  type MailDefinition,
} from '../src'
import { compileMailRegistry, type MailRegistrySources } from '../src/templates'
import './support/mail-templates'

const year = new Date().getFullYear()

function configureMail(sources: Partial<MailRegistrySources>, config: HoloMailConfig = {}): void {
  configureMailRuntime({
    config: normalizeMailConfig({
      default: 'fake',
      from: { email: 'noreply@example.com' },
      mailers: { fake: { driver: 'fake' } },
      ...config,
    }),
    app: { name: 'Acme & Co', url: 'https://acme.test' },
    compiled: compileMailRegistry({ templates: { welcome: '# Welcome' }, ...sources }),
  })
}

function welcomeMail(theme?: 'brand' | 'receipt'): MailDefinition {
  return defineMail({
    to: 'ava@example.com',
    subject: 'Hello there',
    markdown: 'welcome',
    ...(theme ? { theme } : {}),
  })
}

async function send(mail: MailDefinition = welcomeMail()): Promise<{ readonly html: string, readonly text: string }> {
  await sendMail(mail)
  const sent = listFakeSentMails().at(-1)?.mail
  return { html: sent?.html ?? '', text: sent?.text ?? '' }
}

afterEach(() => {
  resetFakeSentMails()
  resetMailRuntime()
})

describe('@holo-js/mail Mail layout', () => {
  it('wraps a Markdown mail in the default layout with the app name, app URL link, and footer', async () => {
    configureMail({})

    const mail = await send()

    expect(mail.html).toMatch(/<a href="https:\/\/acme\.test"[^>]*>\s*Acme &amp; Co\s*<\/a>/)
    expect(mail.html).toMatch(/<td class="content-cell"[^>]*>\s*<h1[^>]*>Welcome<\/h1>\s*<\/td>/)
    expect(mail.html).toContain(`© ${year} Acme &amp; Co. All rights reserved.`)
    expect(mail.html).toContain('@media only screen and (max-width: 600px)')
    expect(mail.text).toBe(`Acme & Co: https://acme.test\n\nWelcome\n\n© ${year} Acme & Co. All rights reserved.`)
  })

  it('replaces the HTML layout and the text layout independently with app layouts', async () => {
    configureMail({ layouts: { html: '<main data-subject="{{ subject }}">{!! body !!}</main>' } })
    const htmlOnly = await send()

    expect(htmlOnly.html).toMatch(/^<main data-subject="Hello there"><h1[^>]*>Welcome<\/h1><\/main>$/)
    expect(htmlOnly.text).toBe(`Acme & Co: https://acme.test\n\nWelcome\n\n© ${year} Acme & Co. All rights reserved.`)

    configureMail({ layouts: { text: '{{ subject }} from {{ app.name }} ({{ year }})\n\n{!! body !!}\n' } })
    const textOnly = await send()

    expect(textOnly.html).toContain(`© ${year} Acme &amp; Co. All rights reserved.`)
    expect(textOnly.text).toBe(`Hello there from Acme & Co (${year})\n\nWelcome`)
  })
  it('lets an app layout use conditions and include Mail templates', async () => {
    configureMail({
      templates: { 'welcome': '# Welcome', 'partials/footer': 'Sent by {{ app.name }}' },
      layouts: { html: '{!! body !!}@if (subject)<footer>@include (partials/footer)</footer>@endif' },
    })

    expect((await send()).html).toMatch(/<h1[^>]*>Welcome<\/h1><footer>Sent by Acme &amp; Co<\/footer>$/)
  })

  it('escapes {{ }} values in Mail components of an app layout with securedEncoding', async () => {
    configureMail({
      layouts: { html: '<mail::panel>{{ subject }}</mail::panel>{!! body !!}', text: '{{ subject }}\n{!! body !!}' },
    }, { markdown: { securedEncoding: true } })

    const mail = await send(defineMail({ to: 'ava@example.com', subject: '[Claim your prize](https://evil.test)', markdown: 'welcome' }))

    expect(mail.html).not.toContain('href=')
    expect(decodeHTML(mail.html)).toContain('[Claim your prize](https://evil.test)')
    expect(mail.text).toBe('[Claim your prize](https://evil.test)\nWelcome')
  })
})

describe('@holo-js/mail Mail theme', () => {
  it('inlines the default theme styles on elements in the HTML', async () => {
    configureMail({})

    const mail = await send()

    expect(mail.html).toMatch(/<h1 style="[^"]*color: #3d4852;[^"]*">Welcome<\/h1>/)
    expect(mail.html).toMatch(/<table class="wrapper"[^>]*style="[^"]*background-color: #edf2f7;/)
  })

  it('styles a built-in Mail component with the default theme', async () => {
    configureMail({ templates: { welcome: '<mail::button url="https://acme.test/start">Start</mail::button>' } })

    const mail = await send()

    expect(mail.html).toMatch(/<a href="https:\/\/acme\.test\/start" class="button button-primary"[^>]*style="[^"]*background-color: #2d3748;[^"]*">Start<\/a>/)
  })

  it('uses an app default theme in place of the built-in one', async () => {
    configureMail({ themes: { default: 'h1 { color: #ff0000; }' } })

    const mail = await send()

    expect(mail.html).toContain('<h1 style="color: #ff0000;">Welcome</h1>')
    expect(mail.html).not.toContain('#3d4852')
  })

  it('selects the app-wide theme from markdown.theme and lets a mail theme override it', async () => {
    configureMail({
      themes: { brand: 'h1 { color: #00aa00; }', receipt: 'h1 { color: #0000ff; }' },
    }, { markdown: { theme: 'brand' } })

    expect((await send()).html).toContain('<h1 style="color: #00aa00;">Welcome</h1>')
    expect((await send(welcomeMail('receipt'))).html).toContain('<h1 style="color: #0000ff;">Welcome</h1>')
  })

  it('rejects a theme that is not registered', async () => {
    configureMail({})

    await expect(sendMail(welcomeMail('receipt'))).rejects.toThrow('Mail theme "receipt" is not registered.')
  })
})
