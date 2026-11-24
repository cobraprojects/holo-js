import { decodeHTML } from 'entities'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureMailRuntime,
  defineMail,
  listFakeSentMails,
  normalizeMailConfig,
  previewMail,
  resetFakeSentMails,
  resetMailRuntime,
  sendMail,
  type MailJsonObject,
} from '../src'
import type { MailComponentFiles } from '../src/components'
import { compileWithoutLayout } from './support/mail-templates'

const injectedLink = '[Claim your prize](https://evil.test)'

interface RenderedMail {
  readonly html: string
  readonly text: string
}

function configure(
  source: string,
  securedEncoding: boolean | undefined,
  components: Readonly<Record<string, MailComponentFiles>> = {},
): void {
  configureMailRuntime({
    config: normalizeMailConfig({
      default: 'fake',
      from: { email: 'noreply@example.com' },
      mailers: { fake: { driver: 'fake' } },
      preview: { allowedEnvironments: ['test'] },
      ...(securedEncoding === undefined ? {} : { markdown: { securedEncoding } }),
    }),
    environment: 'test',
    compiled: compileWithoutLayout({ fixture: source }, components),
  })
}

function fixtureMail(data: MailJsonObject) {
  return defineMail({ to: 'ava@example.com', subject: 'Secured', markdown: 'fixture', data })
}

async function send(
  source: string,
  data: MailJsonObject,
  securedEncoding: boolean | undefined,
  components: Readonly<Record<string, MailComponentFiles>> = {},
): Promise<RenderedMail> {
  configure(source, securedEncoding, components)
  await sendMail(fixtureMail(data))
  const mail = listFakeSentMails().at(-1)?.mail
  return { html: mail?.html ?? '', text: mail?.text ?? '' }
}

function hrefs(html: string): readonly string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map(match => decodeHTML(match[1] ?? ''))
}

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1
}

afterEach(() => {
  resetFakeSentMails()
  resetMailRuntime()
})

describe('Mail template secured encoding', () => {
  it('renders Markdown link, image, and HTML syntax from {{ }} values as literal text in both parts', async () => {
    const mail = await send('Hello {{ name }}', {
      name: `${injectedLink} ![x](https://evil.test/x.png) <b>bold</b> & "quoted"`,
    }, true)

    expect(mail.html).toBe('<p>Hello [Claim your prize](https://evil.test) ![x](https://evil.test/x.png) &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;</p>')
    expect(mail.text).toBe('Hello [Claim your prize](https://evil.test) ![x](https://evil.test/x.png) <b>bold</b> & "quoted"')
  })

  it('does not let a backslash in a {{ }} value undo the escaping', async () => {
    const mail = await send('Hello {{ name }}', { name: `\\${injectedLink}` }, true)

    expect(mail.html).toBe('<p>Hello \\[Claim your prize](https://evil.test)</p>')
    expect(mail.text).toBe('Hello \\[Claim your prize](https://evil.test)')
  })

  it('keeps reference-style links from {{ }} values as literal text', async () => {
    const mail = await send('{{ definition }}\n\nSee [docs].', { definition: '[docs]: https://evil.test' }, true)

    expect(mail.html).not.toContain('<a')
    expect(mail.html).toContain('[docs]: https://evil.test')
  })

  it('outputs {!! !!} values unchanged', async () => {
    const mail = await send('{!! line !!}', { line: '[Docs](https://docs.test)' }, true)

    expect(mail.html).toBe('<p><a href="https://docs.test">Docs</a></p>')
  })

  it('keeps Markdown links from {{ }} values when securedEncoding is off or absent, like Laravel', async () => {
    for (const securedEncoding of [false, undefined]) {
      const mail = await send('{{ line }}', { line: '[Docs](https://docs.test)' }, securedEncoding)

      expect(mail.html).toBe('<p><a href="https://docs.test">Docs</a></p>')
      expect(mail.text).toBe('Docs (https://docs.test)')
    }
  })

  it('escapes {{ }} values in Mail component slots and attributes', async () => {
    const mail = await send(
      '<mail::panel>{{ name }}</mail::panel>\n\n<mail::note title="{{ name }}"></mail::note>',
      { name: injectedLink },
      true,
      { note: { html: '**{{ title }}**', text: '{{ title }}' } },
    )

    expect(hrefs(mail.html)).toEqual([])
    expect(occurrences(decodeHTML(mail.html), injectedLink)).toBe(2)
    expect(mail.html).toContain(`<strong>${injectedLink}</strong>`)
    expect(mail.text).toBe('[Claim your prize](https://evil.test)\n\n[Claim your prize](https://evil.test)')
  })

  it('keeps {{ }} values in a Mail component slot literal when the component places the slot in inline HTML', async () => {
    const mail = await send(
      '<mail::note>{{ name }}</mail::note>',
      { name: injectedLink },
      true,
      { note: { html: '<span>{!! slot !!}</span>' } },
    )

    expect(hrefs(mail.html)).toEqual([])
    expect(decodeHTML(mail.html)).toContain(injectedLink)
  })

  it.each([true, false])('keeps Mail action URLs with brackets and query strings working when securedEncoding is %s', async (securedEncoding) => {
    const url = 'https://acme.test/verify?ids[0]=1&sig=a%2Bb#done'
    const mail = await send(
      '<mail::button url="{{ url }}">Verify</mail::button>\n\n<span class="break-all">[{{ url }}]({{ url }})</span>',
      { url },
      securedEncoding,
    )

    expect(hrefs(mail.html)).toEqual([url, 'https://acme.test/verify?ids%5B0%5D=1&sig=a%2Bb#done'])
    expect(mail.html).toContain('>https://acme.test/verify?ids[0]=1&amp;sig=a%2Bb#done</a>')
    expect(mail.text).toContain(`Verify: ${url}\n\n${url}`)
  })

  it('applies to Mail previews', async () => {
    configure('Hello {{ name }}', true)

    const preview = await previewMail(fixtureMail({ name: injectedLink }))

    expect(preview.html).toBe('<p>Hello [Claim your prize](https://evil.test)</p>')
  })
})

describe('markdown.securedEncoding config', () => {
  it('defaults to false and keeps a boolean', () => {
    expect(normalizeMailConfig({}).markdown.securedEncoding).toBe(false)
    expect(normalizeMailConfig({ markdown: { securedEncoding: true } }).markdown).toEqual({ theme: 'default', securedEncoding: true })
    expect(normalizeMailConfig({ markdown: { securedEncoding: false } }).markdown.securedEncoding).toBe(false)
  })

  it('rejects a value that is not a boolean', () => {
    expect(() => normalizeMailConfig({ markdown: { securedEncoding: 'true' as unknown as boolean } }))
      .toThrow('[Holo Mail] Mail markdown securedEncoding must be a boolean when provided.')
  })
})
