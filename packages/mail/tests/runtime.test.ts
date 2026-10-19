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
  type NormalizedHoloMailConfig,
} from '../src'

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
    const markdown = defineMail({
      from: 'noreply@example.com',
      to: 'ava@example.com',
      subject: 'Markdown',
      markdown: '# Welcome\n\nBody text',
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
        markdown: '# Welcome\n\nBody text',
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

  it('uses renderView for render-backed mails and markdown wrappers', async () => {
    const renderView = vi.fn(async ({ view, props }: { view: string, props?: Record<string, unknown> }) => {
      if (view === 'emails/layout') {
        return `<article data-wrapper="true">${String(props?.html)}</article>`
      }

      return `<section data-view="${view}">${String(props?.title ?? '')}</section>`
    })

    configureMailRuntime({
      renderView,
      config: {
        ...normalizeMailConfig(),
        from: { email: 'config@example.com' },
      },
    })

    const wrappedMarkdown = defineMail({
      to: 'ava@example.com',
      subject: 'Wrapped',
      markdown: '# Wrapped',
      markdownWrapper: 'emails/layout',
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

    const wrapped = await previewMail(wrappedMarkdown)
    const rendered = await previewMail(renderMail)

    expect(wrapped.html).toBe('<article data-wrapper="true"><h1>Wrapped</h1></article>')
    expect(wrapped.text).toBe('Wrapped')
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
    expect(renderView).toHaveBeenCalledTimes(2)
    expect(renderView).toHaveBeenNthCalledWith(1, {
      view: 'emails/layout',
      props: expect.objectContaining({
        html: '<h1>Wrapped</h1>',
        markdown: '# Wrapped',
        text: 'Wrapped',
        subject: 'Wrapped',
      }),
    })
    expect(renderView).toHaveBeenNthCalledWith(2, {
      view: 'auth/verify-email',
      props: {
        title: 'Verify Email',
      },
    })
  })

  it('renders html, json, and text preview responses and maps preview errors', async () => {
    process.env.APP_ENV = 'test'
    configureMailRuntime({
      config: {
        ...normalizeMailConfig(),
        from: { email: 'config@example.com' },
        preview: {
          allowedEnvironments: ['development', 'test'],
        },
      },
    })

    const markdown = defineMail({
      to: 'ava@example.com',
      subject: 'Preview',
      markdown: '# Preview',
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

    process.env.APP_ENV = 'production'
    const disabled = await renderMailPreview(markdown)
    expect(disabled.status).toBe(403)
    await expect(disabled.text()).resolves.toContain('preview is disabled')
    await expect(previewMail(markdown)).resolves.toMatchObject({
      subject: 'Preview',
    })
  })

  it('reads the preview environment from APP_ENV only and treats a missing value as production', async () => {
    configureMailRuntime({
      config: {
        ...normalizeMailConfig(),
        from: { email: 'config@example.com' },
        preview: {
          allowedEnvironments: ['development'],
        },
      },
    })
    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Preview',
      markdown: '# Preview',
    })
    Reflect.deleteProperty(process.env, 'APP_ENV')
    process.env.NODE_ENV = 'development'

    const disabled = await renderMailPreview(mail)
    expect(disabled.status).toBe(403)
    await expect(disabled.text()).resolves.toContain('"production"')

    process.env.APP_ENV = 'development'
    expect((await renderMailPreview(mail)).status).toBe(200)
  })

  it('re-normalizes overrides and preserves preview validation', async () => {
    const mail = defineMail({
      from: 'noreply@example.com',
      to: 'ava@example.com',
      subject: 'Base',
      markdown: '# Base',
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
      markdown: '# Attachments',
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
      markdown: '# Queued',
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
      markdown: '# Preview Driver',
    })
    const fakeMailDefinition = defineMail({
      to: 'ava@example.com',
      subject: 'Fake Driver',
      markdown: '# Fake Driver',
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
        markdown: '# Preview Driver',
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
      markdown: '# Custom Driver',
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
