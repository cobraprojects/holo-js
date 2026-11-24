import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureMailRuntime,
  normalizeMailConfig,
  defineMail,
  getRegisteredMailDriver,
  listFakeSentMails,
  listPreviewMailArtifacts,
  loadMailPluginDrivers,
  MailSendError,
  previewMail,
  registerMailDriver,
  renderMailPreview,
  resetFakeSentMails,
  resetMailDriverRegistry,
  resetPreviewMailArtifacts,
  resetMailRuntime,
  sendMail,
  type MailDriver,
  type MailJsonObject,
  type NormalizedHoloMailConfig,
} from '../src'
import { compileMailRegistry } from '../src/templates'
import { compileWithoutLayout, configureFakeMailerWithTemplates } from './support/mail-templates'

const previousAppEnv = process.env.APP_ENV
const previousNodeEnv = process.env.NODE_ENV

type NormalizedMailMailerConfig = NormalizedHoloMailConfig['mailers'][string]

function getMailerConfig<TDriver extends NormalizedMailMailerConfig['driver']>(
  config: NormalizedHoloMailConfig,
  mailer: string,
  driver: TDriver,
): Extract<NormalizedMailMailerConfig, { readonly driver: TDriver }> {
  const mailerConfig = config.mailers[mailer]
  if (!mailerConfig || mailerConfig.driver !== driver) {
    throw new Error(`Expected mailer "${mailer}" to use driver "${driver}".`)
  }

  return mailerConfig as Extract<NormalizedMailMailerConfig, { readonly driver: TDriver }>
}

async function writeMailPluginProject(
  projectRoot: string,
  packageName: string,
  driverName: string,
  label: string,
): Promise<void> {
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
    name: `${label}-mail-plugin-fixture`,
    private: true,
  }, null, 2))
  await mkdir(join(projectRoot, 'config'), { recursive: true })
  await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['${packageName}'],
}
`)
  const pluginRoot = join(projectRoot, 'node_modules', packageName)
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    holo: {
      plugin: './plugin.mjs',
    },
  }, null, 2))
  await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: '${label}-mail-plugin',
  contributes: {
    mail: {
      drivers: {
        ${driverName}: {
          runtime: './driver.mjs',
        },
      },
    },
  },
}
`)
  await writeFile(join(pluginRoot, 'driver.mjs'), `
export default {
  async send(_mail, context) {
    return {
      messageId: '${label}-message',
      mailer: context.mailer,
      driver: context.driver,
      queued: context.queued,
      provider: {
        project: '${label}',
      },
    }
  },
}
`)
}

afterEach(() => {
  resetFakeSentMails()
  resetPreviewMailArtifacts()
  resetMailDriverRegistry()
  resetMailRuntime()
  if (typeof previousAppEnv === 'string') {
    Reflect.set(process.env, 'APP_ENV', previousAppEnv)
  } else {
    Reflect.deleteProperty(process.env, 'APP_ENV')
  }

  if (typeof previousNodeEnv === 'string') {
    Reflect.set(process.env, 'NODE_ENV', previousNodeEnv)
  } else {
    Reflect.deleteProperty(process.env, 'NODE_ENV')
  }
})

describe('@holo-js/mail runtime', () => {
  it('previews text, html, and markdown mails without a transport driver', async () => {
    configureMailRuntime({ compiled: compileWithoutLayout({ welcome: '# Welcome\n\nBody text' }) })
    const markdown = defineMail({
      from: 'noreply@example.com',
      to: 'ava@example.com',
      subject: 'Markdown',
      markdown: 'welcome',
    })

    const html = defineMail({
      from: 'noreply@example.com',
      to: 'ava@example.com',
      subject: 'HTML',
      html: '<p>Hello</p>',
      text: 'Hello',
    })

    const text = defineMail({
      from: 'noreply@example.com',
      to: 'ava@example.com',
      subject: 'Text',
      text: 'Only text',
    })

    await expect(previewMail(markdown)).resolves.toMatchObject({
      from: { email: 'noreply@example.com' },
      replyTo: { email: 'noreply@example.com' },
      subject: 'Markdown',
      html: '<h1>Welcome</h1>\n<p>Body text</p>',
      text: 'Welcome\n\nBody text',
      source: {
        kind: 'markdown',
        markdown: 'welcome',
      },
    })
    await expect(previewMail(html)).resolves.toMatchObject({
      html: '<p>Hello</p>',
      text: 'Hello',
      source: {
        kind: 'html',
        rawHtml: '<p>Hello</p>',
      },
    })
    await expect(previewMail(text)).resolves.toMatchObject({
      text: 'Only text',
      source: {
        kind: 'text',
      },
    })
  })

  describe('Mail templates', () => {
    async function sendTemplate(source: string, data: MailJsonObject = {}): Promise<{ readonly html?: string, readonly text?: string }> {
      resetFakeSentMails()
      configureFakeMailerWithTemplates({ fixture: source })
      await sendMail(defineMail({ to: 'ava@example.com', subject: 'Template', markdown: 'fixture', data }))
      const sent = listFakeSentMails()
      expect(sent).toHaveLength(1)
      return sent[0]!.mail
    }

    it('fills placeholders with data values before rendering Markdown', async () => {
      const mail = await sendTemplate('# Hello {{ name }}\n\nOrder **#{{ orderId }}** shipped.', { name: 'Ava', orderId: 42 })

      expect(mail.html).toBe('<h1>Hello Ava</h1>\n<p>Order <strong>#42</strong> shipped.</p>')
      expect(mail.text).toBe('Hello Ava\n\nOrder #42 shipped.')
    })

    it('escapes {{ }} values and outputs {!! !!} values and template HTML as written', async () => {
      const mail = await sendTemplate(
        '<p class="lead">Escaped: {{ value }}</p>\n\nRaw: {!! value !!}',
        { value: '<b>"Tom" & \'Jerry\'</b>' },
      )

      expect(mail.html).toBe([
        '<p class="lead">Escaped: &lt;b&gt;&quot;Tom&quot; &amp; &#039;Jerry&#039;&lt;/b&gt;</p>',
        '<p>Raw: <b>&quot;Tom&quot; &amp; \'Jerry\'</b></p>',
      ].join('\n'))
      expect(mail.text).toBe('Escaped: <b>"Tom" & \'Jerry\'</b>\n\nRaw: "Tom" & \'Jerry\'')
    })

    it('resolves dot paths in nested data', async () => {
      const mail = await sendTemplate('Thanks, {{ customer.name }} from {{ customer.address.city }}.', {
        customer: { name: 'Ava', address: { city: 'Cairo' } },
      })

      expect(mail.html).toBe('<p>Thanks, Ava from Cairo.</p>')
    })

    it('rejects a missing data value and an unknown Mail template', async () => {
      await expect(sendTemplate('Hello {{ customer.name }}', { customer: {} }))
        .rejects.toThrow('Mail template "fixture" requires a string or number for "customer.name".')

      configureFakeMailerWithTemplates({})
      await expect(sendMail(defineMail({ to: 'ava@example.com', subject: 'Missing', markdown: 'welcome' })))
        .rejects.toThrow('Mail template "welcome" is not registered.')
    })

    it('does not resolve inherited properties from data', async () => {
      await expect(sendTemplate('{{ constructor }}'))
        .rejects.toThrow('requires a string or number for "constructor"')
    })

    it('shows the @if branch for truthy values and the @else branch for falsy or missing values', async () => {
      const template = '@if (order.paid)\nPaid\n@else\nUnpaid\n@endif\n'
      const truthy: readonly MailJsonObject[] = [{ order: { paid: true } }, { order: { paid: 'yes' } }, { order: { paid: 1 } }, { order: { paid: [] } }]
      const falsy: readonly MailJsonObject[] = [{}, { order: {} }, { order: { paid: null } }, { order: { paid: false } }, { order: { paid: 0 } }, { order: { paid: '' } }]

      for (const data of truthy) {
        expect((await sendTemplate(template, data)).html).toBe('<p>Paid</p>')
      }
      for (const data of falsy) {
        expect((await sendTemplate(template, data)).html).toBe('<p>Unpaid</p>')
      }
      expect((await sendTemplate('Write to help@example.com @if (vip)today @endif', { vip: true })).html)
        .toBe('<p>Write to help@example.com today</p>')
    })

    it('renders one @foreach block per item, including Markdown table rows', async () => {
      const mail = await sendTemplate([
        '# Order {{ order.id }}',
        '',
        '| Item | Qty |',
        '| --- | ---: |',
        '@foreach (order.lines as line)',
        '| {{ line.name }} | {{ line.quantity }} |',
        '@endforeach',
        '',
        '@foreach (tags as tag)',
        '- {{ tag }} for {{ order.id }}',
        '@endforeach',
      ].join('\n'), {
        order: { id: 7, lines: [{ name: 'Mug', quantity: 2 }, { name: 'Tea', quantity: 1 }] },
        tags: ['gift', 'fragile'],
      })

      expect(mail.html).toBe([
        '<h1>Order 7</h1>',
        '<table>',
        '<thead>',
        '<tr>',
        '<th>Item</th>',
        '<th style="text-align:right">Qty</th>',
        '</tr>',
        '</thead>',
        '<tbody>',
        '<tr>',
        '<td>Mug</td>',
        '<td style="text-align:right">2</td>',
        '</tr>',
        '<tr>',
        '<td>Tea</td>',
        '<td style="text-align:right">1</td>',
        '</tr>',
        '</tbody>',
        '</table>',
        '<ul>',
        '<li>gift for 7</li>',
        '<li>fragile for 7</li>',
        '</ul>',
      ].join('\n'))
    })

    it('renders nothing for an empty @foreach list and rejects a value that is not a list', async () => {
      const template = 'Items:\n@foreach (items as item)\n- {{ item }}\n@endforeach\nDone'

      expect((await sendTemplate(template, { items: [] })).html).toBe('<p>Items:\nDone</p>')
      await expect(sendTemplate(template, { items: 'Mug' }))
        .rejects.toThrow('Mail template "fixture" requires a list for "items".')
    })

    it('renders an @include with the parent data', async () => {
      configureFakeMailerWithTemplates({
        'fixture': '# Order {{ order.id }}\n\n@foreach (order.lines as line)\n@include (partials/summary)\n@endforeach\nThanks!',
        'partials/summary': 'Total: **{{ order.total }}**\n',
      })
      await sendMail(defineMail({
        to: 'ava@example.com',
        subject: 'Include',
        markdown: 'fixture',
        data: { order: { id: 7, total: '$12', lines: ['Mug'] } },
      }))

      expect(listFakeSentMails()[0]?.mail.html).toBe('<h1>Order 7</h1>\n<p>Total: <strong>$12</strong>\nThanks!</p>')
    })

    it('rejects template syntax errors when compiling', () => {
      expect(() => compileMailRegistry({ templates: { broken: 'Hello\n{{ name' } }))
        .toThrow('Mail template "broken" line 2: "{{" is not closed with "}}".')
      expect(() => compileMailRegistry({ templates: { broken: 'Hello {!! user.name() !!}' } }))
        .toThrow('Mail template "broken" line 1: "user.name()" is not a data path.')
      expect(() => compileMailRegistry({ templates: { broken: '{{ order }} {{ order.id }}' } }))
        .toThrow('Mail template "broken" uses "order.id" both as a value and as an object.')
    })

    it('rejects malformed and unclosed directives when compiling', () => {
      const failures: readonly (readonly [string, string])[] = [
        ['Hi\n@if (paid)\nPaid', 'line 2: "@if" is not closed with "@endif".'],
        ['@foreach (items as item)\n{{ item }}\n@endif', 'line 3: "@endif" has no matching "@if".'],
        ['@foreach (items as item)\n{{ item }}', 'line 1: "@foreach" is not closed with "@endforeach".'],
        ['@else\n', 'line 1: "@else" has no matching "@if".'],
        ['@if (a)\n@else\n@else\n@endif', 'line 3: "@else" has no matching "@if".'],
        ['@if paid\n@endif', 'line 1: "@if" needs a data path in parentheses.'],
        ['@if (paid\n)\n@endif', 'line 1: "@if" needs a data path in parentheses.'],
        ['@if (order.total > 10)\n@endif', 'line 1: "order.total > 10" is not a data path.'],
        ['@foreach (items)\n@endforeach', 'line 1: "@foreach" needs "path as name" in parentheses'],
        ['@include (../secrets)', 'line 1: "../secrets" is not a Mail template name'],
        ['@include (partials/missing)', 'line 1: "@include (partials/missing)" names a Mail template that does not exist.'],
        ['@foreach (items as item)\n{{ item.name }}\n@endforeach\n{{ items }}', 'uses "items" both as a list and as a value.'],
      ]

      for (const [source, message] of failures) {
        expect(() => compileMailRegistry({ templates: { broken: source } })).toThrow(`Mail template "broken" ${message}`)
      }
    })

    it('outputs an escaped @@ directive as literal text', async () => {
      expect((await sendTemplate('Follow @@holo on social media')).html).toBe('<p>Follow @holo on social media</p>')
      expect((await sendTemplate('Write @@if (paid) to check a value')).html).toBe('<p>Write @if (paid) to check a value</p>')
    })

    it('outputs an unknown @ word as literal text', async () => {
      const mail = await sendTemplate('Contact @support today\n@media (max-width: 600px)')

      expect(mail.html).toBe('<p>Contact @support today\n@media (max-width: 600px)</p>')
      expect(mail.text).toBe('Contact @support today\n@media (max-width: 600px)')
    })
  })

  describe('markdown rendering', () => {
    async function sendMarkdown(markdown: string): Promise<{ readonly html?: string, readonly text?: string }> {
      configureFakeMailerWithTemplates({ fixture: markdown })
      await sendMail(defineMail({ to: 'ava@example.com', subject: 'Markdown', markdown: 'fixture' }))
      const sent = listFakeSentMails()
      expect(sent).toHaveLength(1)
      return sent[0]!.mail
    }

    it('renders CommonMark block syntax', async () => {
      const mail = await sendMarkdown([
        '1. First',
        '2. Second',
        '   - Nested',
        '',
        '> Quoted *text*',
        '',
        '```ts',
        'const total = 1 < 2',
        '```',
        '',
        '---',
        '',
        '![Logo](https://example.test/logo.png "Brand")',
      ].join('\n'))

      expect(mail.html).toContain('<ol>\n<li>First</li>\n<li>Second\n<ul>\n<li>Nested</li>\n</ul>\n</li>\n</ol>')
      expect(mail.html).toContain('<blockquote>\n<p>Quoted <em>text</em></p>\n</blockquote>')
      expect(mail.html).toContain('<pre><code class="language-ts">const total = 1 &lt; 2\n</code></pre>')
      expect(mail.html).toContain('<hr>')
      expect(mail.html).toContain('<img src="https://example.test/logo.png" alt="Logo" title="Brand">')
    })

    it('renders GitHub-style tables', async () => {
      const mail = await sendMarkdown('| Item | Price |\n| :--- | ---: |\n| Plan | $10 |')

      expect(mail.html).toMatch(/<table>\s*<thead>\s*<tr>\s*<th[^>]*>Item<\/th>\s*<th[^>]*>Price<\/th>/)
      expect(mail.html).toMatch(/<tbody>\s*<tr>\s*<td[^>]*>Plan<\/td>\s*<td[^>]*>\$10<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/)
    })

    it('outputs template HTML as written and does not link unsafe URLs', async () => {
      const mail = await sendMarkdown([
        '<div align="center">Block</div>',
        '',
        'Inline <b>bold</b> [bad](javascript:alert(1)) [ok](https://example.test) ![pixel](javascript:track) <javascript:alert(2)>',
      ].join('\n'))

      expect(mail.html).toContain('<div align="center">Block</div>')
      expect(mail.html).toContain('<p>Inline <b>bold</b> bad <a href="https://example.test">ok</a> pixel javascript:alert(2)</p>')
      expect(mail.html).not.toContain('href="javascript:')
      expect(mail.html).not.toContain('<img')
      expect(mail.text).toBe('Block\n\nInline bold bad ok (https://example.test) pixel javascript:alert(2)')
    })

    it('generates plain text from markdown with syntax removed', async () => {
      const mail = await sendMarkdown([
        '# Invoice **paid**',
        '',
        'Thanks for using `Holo`. [View invoice](https://example.test/invoices/1) or [bad](javascript:alert).',
        '',
        '1. First',
        '2. Second',
        '   - Nested',
        '',
        '> Quoted *text*',
        '',
        '```',
        'npm install',
        '```',
        '',
        '| Item | Price |',
        '| --- | --- |',
        '| Plan | $10 |',
      ].join('\n'))

      expect(mail.text).toBe([
        'Invoice paid',
        '',
        'Thanks for using Holo. View invoice (https://example.test/invoices/1) or bad.',
        '',
        '1. First',
        '2. Second',
        '  - Nested',
        '',
        'Quoted text',
        '',
        'npm install',
        '',
        'Item | Price',
        'Plan | $10',
      ].join('\n'))
    })
  })

  it('uses renderView for render-backed mails', async () => {
    const renderView = vi.fn(async ({ view, props }: { view: string, props?: Record<string, unknown> }) => {
      return `<section data-view="${view}">${String(props?.title ?? '')}</section>`
    })

    configureMailRuntime({
      renderView,
      config: {
        ...normalizeMailConfig(),
        from: { email: 'config@example.com' },
      },
    })

    const renderMail = defineMail({
      to: 'ava@example.com',
      subject: 'Rendered',
      render: {
        view: 'auth/verify-email',
        props: {
          title: 'Verify Email',
        },
      },
    })

    const rendered = await previewMail(renderMail)

    expect(rendered.html).toBe('<section data-view="auth/verify-email">Verify Email</section>')
    expect(rendered.source).toEqual({
      kind: 'render',
      render: {
        view: 'auth/verify-email',
        props: {
          title: 'Verify Email',
        },
      },
    })
    expect(renderView).toHaveBeenCalledTimes(1)
  })

  it('renders html, json, and text preview responses and maps preview errors', async () => {
    const config = {
      ...normalizeMailConfig(),
      from: { email: 'config@example.com' },
      preview: {
        allowedEnvironments: ['development', 'test'] as const,
      },
    }
    const compiled = compileWithoutLayout({ welcome: '# Preview' })
    configureMailRuntime({ config, environment: 'test', compiled })

    const markdown = defineMail({
      to: 'ava@example.com',
      subject: 'Preview',
      markdown: 'welcome',
    })

    const htmlResponse = await renderMailPreview(markdown)
    expect(htmlResponse.status).toBe(200)
    expect(htmlResponse.headers.get('content-type')).toContain('text/html')
    await expect(htmlResponse.text()).resolves.toContain('<h1>Preview</h1>')

    const unsafeHtml = defineMail({
      to: 'ava@example.com',
      subject: 'Unsafe HTML',
      html: '<img src=x onerror=alert(1)>',
    })
    await expect(renderMailPreview(unsafeHtml).then(response => response.text())).resolves.toContain('&lt;img src=x onerror=alert(1)&gt;')

    const jsonResponse = await renderMailPreview(markdown, undefined, 'json')
    expect(jsonResponse.status).toBe(200)
    expect(jsonResponse.headers.get('content-type')).toContain('application/json')
    await expect(jsonResponse.json()).resolves.toMatchObject({
      subject: 'Preview',
      source: {
        kind: 'markdown',
      },
    })

    const textResponse = await renderMailPreview(markdown, undefined, 'text')
    expect(textResponse.status).toBe(200)
    await expect(textResponse.text()).resolves.toBe('Preview')

    const htmlOnly = defineMail({
      to: 'ava@example.com',
      subject: 'HTML only',
      html: '<p>Only html</p>',
    })
    const unavailableText = await renderMailPreview(htmlOnly, undefined, 'text')
    expect(unavailableText.status).toBe(422)
    await expect(unavailableText.text()).resolves.toContain('text preview is unavailable')

    configureMailRuntime({ config, environment: 'production', compiled })
    const disabled = await renderMailPreview(markdown)
    expect(disabled.status).toBe(403)
    await expect(disabled.text()).resolves.toContain('preview is disabled')
    await expect(previewMail(markdown)).resolves.toMatchObject({
      subject: 'Preview',
    })
  })

  it('reads the preview environment from the runtime bindings and treats a missing one as production', async () => {
    const config = {
      ...normalizeMailConfig(),
      from: { email: 'config@example.com' },
      preview: {
        allowedEnvironments: ['development'] as const,
      },
    }
    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Preview',
      text: 'Preview',
    })
    process.env.APP_ENV = 'development'
    process.env.NODE_ENV = 'development'
    configureMailRuntime({ config })

    const disabled = await renderMailPreview(mail)
    expect(disabled.status).toBe(403)
    await expect(disabled.text()).resolves.toContain('"production"')

    configureMailRuntime({ config, environment: 'development' })
    expect((await renderMailPreview(mail)).status).toBe(200)
  })

  it('re-normalizes overrides and preserves preview validation', async () => {
    const mail = defineMail({
      from: 'noreply@example.com',
      to: 'ava@example.com',
      subject: 'Base',
      markdown: 'welcome',
    })

    await expect(previewMail(mail, {
      html: '<p>Broken</p>',
    })).rejects.toThrow('exactly one primary content source')
  })

  it('keeps preview attachment metadata source-free and resolves sync resolver attachments for send', async () => {
    const resolveAttachment = vi.fn(async () => ({
      content: 'hello',
      name: 'welcome.txt',
    }))
    const send = vi.fn(async () => ({
      messageId: 'mail-1',
      mailer: 'preview',
      driver: 'preview',
      queued: false,
    }))

    configureMailRuntime({
      send,
      config: {
        ...normalizeMailConfig(),
        from: { email: 'config@example.com' },
      },
    })

    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Attachments',
      text: 'Attachments',
      attachments: [
        {
          path: '/tmp/report.pdf',
        },
        {
          storage: {
            path: 'images/logo.png',
          },
          disposition: 'inline',
          contentId: '<logo-cid>',
        },
        {
          resolve: resolveAttachment,
        },
      ],
    })

    const preview = await previewMail(mail)
    expect(preview.attachments).toEqual([
      {
        source: 'path',
        name: 'report.pdf',
        contentType: 'application/pdf',
        disposition: 'attachment',
        contentId: undefined,
      },
      {
        source: 'storage',
        name: 'logo.png',
        contentType: 'image/png',
        disposition: 'inline',
        contentId: 'logo-cid',
      },
      {
        source: 'resolve',
        name: undefined,
        contentType: undefined,
        disposition: 'attachment',
        contentId: undefined,
      },
    ])
    expect(resolveAttachment).not.toHaveBeenCalled()

    await expect(sendMail(mail)).resolves.toMatchObject({
      messageId: 'mail-1',
      queued: false,
    })
    expect(resolveAttachment).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [
        {
          source: 'path',
          name: 'report.pdf',
          contentType: 'application/pdf',
          disposition: 'attachment',
          path: '/tmp/report.pdf',
        },
        {
          source: 'storage',
          name: 'logo.png',
          contentType: 'image/png',
          disposition: 'inline',
          contentId: 'logo-cid',
          storage: {
            path: 'images/logo.png',
          },
        },
        {
          source: 'content',
          name: 'welcome.txt',
          contentType: 'text/plain',
          disposition: 'attachment',
          content: 'hello',
        },
      ],
    }))
  })

  it('rejects resolver attachments when queueing is requested', async () => {
    const send = vi.fn(async () => ({
      messageId: 'mail-queued',
      mailer: 'preview',
      driver: 'preview',
      queued: true,
    }))

    configureMailRuntime({
      send,
      config: {
        ...normalizeMailConfig(),
        from: { email: 'config@example.com' },
      },
    })

    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Queued',
      text: 'Queued',
      attachments: [
        {
          resolve: async () => ({
            content: 'hello',
            name: 'queued.txt',
          }),
        },
      ],
    })

    await expect(sendMail(mail).onQueue('mail')).rejects.toThrow('not queue-safe')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends through the built-in preview and fake drivers and stores runtime records', async () => {
    const resolvedConfig = normalizeMailConfig()

    configureMailRuntime({
      config: {
        ...resolvedConfig,
        default: 'preview',
        from: { email: 'config@example.com' },
        mailers: {
          ...resolvedConfig.mailers,
          preview: {
            ...getMailerConfig(resolvedConfig, 'preview', 'preview'),
          },
          fake: {
            ...getMailerConfig(resolvedConfig, 'fake', 'fake'),
          },
        },
      },
    })

    const previewMailDefinition = defineMail({
      to: 'ava@example.com',
      subject: 'Preview Driver',
      text: 'Preview Driver',
    })
    const fakeMailDefinition = defineMail({
      to: 'ava@example.com',
      subject: 'Fake Driver',
      text: 'Fake Driver',
      mailer: 'fake',
    })

    const previewResult = await sendMail(previewMailDefinition)
    const fakeResult = await sendMail(fakeMailDefinition)

    expect(previewResult.driver).toBe('preview')
    expect(previewResult.mailer).toBe('preview')
    expect(Object.isFrozen(previewResult)).toBe(true)
    expect(fakeResult.driver).toBe('fake')
    expect(fakeResult.mailer).toBe('fake')
    expect(Object.isFrozen(fakeResult)).toBe(true)

    const artifacts = listPreviewMailArtifacts()
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      messageId: previewResult.messageId,
      context: {
        driver: 'preview',
        mailer: 'preview',
      },
      result: previewResult,
      mail: {
        subject: 'Preview Driver',
      },
    })
    expect(Object.isFrozen(artifacts[0]!.mail)).toBe(true)
    expect(Object.isFrozen(artifacts[0]!.context)).toBe(true)

    const fakeSent = listFakeSentMails()
    expect(fakeSent).toHaveLength(1)
    expect(fakeSent[0]).toMatchObject({
      messageId: fakeResult.messageId,
      context: {
        driver: 'fake',
        mailer: 'fake',
      },
      result: fakeResult,
      mail: {
        subject: 'Fake Driver',
      },
    })
    expect(Object.isFrozen(fakeSent[0]!.mail)).toBe(true)
    expect(Object.isFrozen(fakeSent[0]!.result)).toBe(true)
  })

  it('persists preview artifacts to the configured preview path', async () => {
    const previewRoot = await mkdtemp(join(tmpdir(), 'holo-mail-preview-'))

    try {
      const resolvedConfig = normalizeMailConfig()

      configureMailRuntime({
        config: {
          ...resolvedConfig,
          default: 'preview',
          from: { email: 'config@example.com' },
          mailers: {
            ...resolvedConfig.mailers,
            preview: {
              ...getMailerConfig(resolvedConfig, 'preview', 'preview'),
              path: previewRoot,
            },
          },
        },
      })

      const result = await sendMail(defineMail({
        to: 'ava@example.com',
        subject: 'Persisted Preview Driver',
        text: 'Preview Driver',
      }))

      const persistedEntries = await readdir(previewRoot)
      expect(persistedEntries).toHaveLength(1)

      const persistedArtifact = JSON.parse(
        await readFile(join(previewRoot, persistedEntries[0]!), 'utf8'),
      ) as {
        readonly messageId: string
        readonly mail: {
          readonly subject: string
        }
        readonly context: {
          readonly driver: string
          readonly mailer: string
        }
      }

      expect(persistedArtifact).toMatchObject({
        messageId: result.messageId,
        context: {
          driver: 'preview',
          mailer: 'preview',
        },
        mail: {
          subject: 'Persisted Preview Driver',
        },
      })
    } finally {
      await rm(previewRoot, { recursive: true, force: true })
    }
  })

  it('skips filesystem persistence for non-preview artifacts', async () => {
    const previewRoot = await mkdtemp(join(tmpdir(), 'holo-mail-preview-'))

    try {
      const resolvedConfig = normalizeMailConfig()

      configureMailRuntime({
        config: {
          ...resolvedConfig,
          from: { email: 'config@example.com' },
          mailers: {
            ...resolvedConfig.mailers,
            fake: {
              ...getMailerConfig(resolvedConfig, 'fake', 'fake'),
            },
            preview: {
              ...getMailerConfig(resolvedConfig, 'preview', 'preview'),
              path: previewRoot,
            },
          },
        },
      })

      await sendMail(defineMail({ to: 'ava@example.com', subject: 'Non-preview delivery', text: 'Not previewed' })).using('fake')
      expect(listFakeSentMails()).toHaveLength(1)

      expect(await readdir(previewRoot)).toEqual([])
    } finally {
      await rm(previewRoot, { recursive: true, force: true })
    }
  })

  it('loads mail drivers contributed by active Holo plugins', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-mail-plugin-'))
    const previousCwd = process.cwd()

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'mail-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-mail'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-mail')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-mail',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'mail-plugin',
  contributes: {
    mail: {
      drivers: {
        plugin: {
          runtime: './driver.mjs',
        },
      },
    },
  },
}
`)
      await writeFile(join(pluginRoot, 'driver.mjs'), `
export default {
  async send(_mail, context) {
    return {
      messageId: 'plugin-message',
      mailer: context.mailer,
      driver: context.driver,
      queued: context.queued
    }
  },
}
`)

      process.chdir(projectRoot)
      await loadMailPluginDrivers(projectRoot, ['holo-plugin-mail'])
      expect(getRegisteredMailDriver('plugin')?.driver.send).toEqual(expect.any(Function))
      await expect(loadMailPluginDrivers(projectRoot, ['holo-plugin-mail'])).resolves.toBeUndefined()
    } finally {
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('clears mail plugin drivers when the runtime resets', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'holo-mail-plugin-first-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'holo-mail-plugin-second-'))
    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Plugin mail',
      text: 'Plugin mail',
    })

    try {
      await writeMailPluginProject(firstRoot, 'holo-plugin-mail-first', 'shared', 'first')
      await writeMailPluginProject(secondRoot, 'holo-plugin-mail-second', 'shared', 'second')

      configureMailRuntime({
        projectRoot: firstRoot,
        plugins: ['holo-plugin-mail-first'],
        config: {
          ...normalizeMailConfig(),
          default: 'plugin',
          from: { email: 'config@example.com' },
          mailers: {
            ...normalizeMailConfig().mailers,
            plugin: {
              name: 'plugin',
              driver: 'shared',
              from: { email: 'config@example.com' },
              replyTo: { email: 'config@example.com' },
              queue: {
                queued: false,
                connection: undefined,
                queue: undefined,
                afterCommit: false,
              },
            },
          },
        },
      } as Parameters<typeof configureMailRuntime>[0] & { readonly projectRoot: string })

      await expect(sendMail(mail)).resolves.toMatchObject({
        provider: {
          project: 'first',
        },
      })

      resetMailRuntime()
      configureMailRuntime({
        projectRoot: secondRoot,
        plugins: ['holo-plugin-mail-second'],
        config: {
          ...normalizeMailConfig(),
          default: 'plugin',
          from: { email: 'config@example.com' },
          mailers: {
            ...normalizeMailConfig().mailers,
            plugin: {
              name: 'plugin',
              driver: 'shared',
              from: { email: 'config@example.com' },
              replyTo: { email: 'config@example.com' },
              queue: {
                queued: false,
                connection: undefined,
                queue: undefined,
                afterCommit: false,
              },
            },
          },
        },
      } as Parameters<typeof configureMailRuntime>[0] & { readonly projectRoot: string })

      await expect(sendMail(mail)).resolves.toMatchObject({
        provider: {
          project: 'second',
        },
      })
    } finally {
      await rm(firstRoot, { recursive: true, force: true })
      await rm(secondRoot, { recursive: true, force: true })
    }
  })

  it('uses registered custom drivers and wraps thrown driver errors', async () => {
    const customSend = vi.fn<MailDriver['send']>(async () => ({
      messageId: 'custom-send',
      mailer: 'transactional',
      driver: 'resend',
      queued: false,
      providerMessageId: 'provider-1',
      provider: {
        region: 'us',
      },
    }))
    registerMailDriver('resend', {
      send: customSend,
    })

    configureMailRuntime({
      config: {
        ...normalizeMailConfig(),
        default: 'transactional',
        from: { email: 'config@example.com' },
        mailers: {
          ...normalizeMailConfig().mailers,
          transactional: {
            name: 'transactional',
            driver: 'resend',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: false,
              connection: undefined,
              queue: undefined,
              afterCommit: false,
            },
          },
        },
      },
    })

    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Custom Driver',
      text: 'Custom Driver',
    })

    const result = await sendMail(mail)
    expect(result).toMatchObject({
      driver: 'resend',
      mailer: 'transactional',
      providerMessageId: 'provider-1',
      provider: {
        region: 'us',
      },
    })
    expect(customSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Custom Driver',
      }),
      expect.objectContaining({
        driver: 'resend',
        mailer: 'transactional',
      }),
    )
    const driverMail = customSend.mock.calls[0]![0]
    const driverContext = customSend.mock.calls[0]![1]
    expect(Object.isFrozen(driverMail)).toBe(true)
    expect(Object.isFrozen(driverContext)).toBe(true)

    expect(() => registerMailDriver('resend', {
      send() {
        return {
          messageId: 'duplicate',
          mailer: 'resend',
          driver: 'resend',
          queued: false,
        }
      },
    })).toThrow('already registered')
    expect(() => registerMailDriver('broken', {} as never)).toThrow('must define send()')

    registerMailDriver('failing', {
      send() {
        throw new Error('boom')
      },
    }, {
      replaceExisting: true,
    })

    configureMailRuntime({
      config: {
        ...normalizeMailConfig(),
        default: 'failing-mailer',
        from: { email: 'config@example.com' },
        mailers: {
          ...normalizeMailConfig().mailers,
          'failing-mailer': {
            name: 'failing-mailer',
            driver: 'failing',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: false,
              connection: undefined,
              queue: undefined,
              afterCommit: false,
            },
          },
        },
      },
    })

    await expect(sendMail(mail)).rejects.toBeInstanceOf(MailSendError)
    await expect(sendMail(mail)).rejects.toMatchObject({
      driver: 'failing',
      mailer: 'failing-mailer',
      cause: expect.objectContaining({
        message: 'boom',
      }),
    })
  })
})
