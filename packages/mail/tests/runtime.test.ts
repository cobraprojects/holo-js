import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureMailRuntime,
  defineMail,
  getMailRuntimeBindings,
  getMailRuntime,
  listFakeSentMails,
  listPreviewMailArtifacts,
  MailSendError,
  mailRuntimeInternals,
  previewMail,
  registerMailDriver,
  renderMailPreview,
  resetFakeSentMails,
  resetMailDriverRegistry,
  resetPreviewMailArtifacts,
  resetMailRuntime,
  sendMail,
} from '../src'

const previousAppEnv = process.env.APP_ENV
const previousNodeEnv = process.env.NODE_ENV

function createQueueModuleStub(options: { readonly autoRun?: boolean } = {}) {
  const jobs = new Map<string, { handle(payload: unknown): Promise<unknown> | unknown }>()
  const dispatches: Array<{
    jobName: string
    payload: unknown
    connection?: string
    queue?: string
    delay?: number | Date
  }> = []
  const scheduled: Array<() => Promise<unknown>> = []
  const autoRun = options.autoRun ?? true

  return {
    jobs,
    dispatches,
    module: {
      defineJob(definition: { handle(payload: unknown): Promise<unknown> | unknown }) {
        return definition
      },
      getRegisteredQueueJob(name: string) {
        return jobs.get(name)
      },
      registerQueueJob(definition: { handle(payload: unknown): Promise<unknown> | unknown }, entry: { name: string }) {
        jobs.set(entry.name, definition)
      },
      dispatch(jobName: string, payload: unknown) {
        const entry: {
          jobName: string
          payload: unknown
          connection?: string
          queue?: string
          delay?: number | Date
        } = {
          jobName,
          payload,
        }

        return {
          onConnection(name: string) {
            entry.connection = name
            return this
          },
          onQueue(name: string) {
            entry.queue = name
            return this
          },
          delay(value: number | Date) {
            entry.delay = value
            return this
          },
          async dispatch() {
            dispatches.push({ ...entry })
            const run = async () => await jobs.get(jobName)?.handle(payload)
            if (autoRun) {
              return await run()
            }

            scheduled.push(run)
            return undefined
          },
        }
      },
    },
    async runDispatch(index = 0) {
      const dispatch = scheduled[index]
      if (!dispatch) {
        throw new Error(`Missing queued dispatch at index ${index}.`)
      }

      return await dispatch()
    },
  }
}

function createNodemailerModuleStub(options: {
  readonly result?: { readonly messageId?: string, readonly response?: string }
  readonly error?: Error
} = {}) {
  const sendMail = vi.fn(async (message: unknown) => {
    if (options.error) {
      throw options.error
    }

    return options.result ?? {
      messageId: 'smtp-provider-id',
      response: '250 accepted',
    }
  })
  const createTransport = vi.fn(() => ({
    sendMail,
  }))

  return {
    sendMail,
    createTransport,
    module: {
      createTransport,
    },
  }
}

function createStorageModuleStub() {
  const disks = new Map<string, {
    readonly driver: string
    path(path: string): string
    getBytes(path: string): Promise<Uint8Array | null>
  }>([
    ['local', {
      driver: 'local',
      path(path: string) {
        return `/resolved/local/${path}`
      },
      async getBytes() {
        throw new Error('local disk should use path()')
      },
    }],
    ['s3', {
      driver: 's3',
      path(path: string) {
        return `s3://bucket/${path}`
      },
      async getBytes(path: string) {
        if (path === 'images/logo.png') {
          return new Uint8Array([1, 2, 3, 4])
        }

        return null
      },
    }],
  ])

  return {
    module: {
      Storage: {
        disk(name?: string) {
          return disks.get(name ?? 'local') ?? disks.get('local')!
        },
      },
    },
  }
}

afterEach(() => {
  resetFakeSentMails()
  resetPreviewMailArtifacts()
  resetMailDriverRegistry()
  resetMailRuntime()
  if (typeof previousAppEnv === 'string') {
    process.env.APP_ENV = previousAppEnv
  } else {
    Reflect.deleteProperty(process.env, 'APP_ENV')
  }

  if (typeof previousNodeEnv === 'string') {
    process.env.NODE_ENV = previousNodeEnv
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
        ...mailRuntimeInternals.getResolvedConfig(),
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
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
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
        ...mailRuntimeInternals.getResolvedConfig(),
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
        ...mailRuntimeInternals.getResolvedConfig(),
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

  it('queues delayed mail, preserves precedence, and honors fluent mailer overrides', async () => {
    const queue = createQueueModuleStub()
    const delayAt = new Date('2026-04-12T10:00:00.000Z')

    mailRuntimeInternals.setQueueModuleLoader(async () => queue.module)
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'config-mailer',
        from: { email: 'config@example.com' },
        queue: {
          queued: true,
          connection: 'config-connection',
          queue: 'config-queue',
          afterCommit: false,
        },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          'config-mailer': {
            name: 'config-mailer',
            driver: 'preview',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: false,
              connection: undefined,
              queue: undefined,
              afterCommit: false,
            },
            path: '.holo-js/runtime/mail-preview',
          },
          transactional: {
            name: 'transactional',
            driver: 'preview',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: true,
              connection: 'mailer-connection',
              queue: 'mailer-queue',
              afterCommit: false,
            },
            path: '.holo-js/runtime/mail-preview',
          },
          override: {
            name: 'override',
            driver: 'preview',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: true,
              connection: 'override-connection',
              queue: 'override-queue',
              afterCommit: false,
            },
            path: '.holo-js/runtime/mail-preview',
          },
        },
      },
    })

    const delayed = defineMail({
      to: 'ava@example.com',
      subject: 'Delayed',
      markdown: '# Delayed',
      mailer: 'transactional',
      queue: {
        queued: true,
        queue: 'mail-definition-queue',
      },
      delay: delayAt,
    })

    const inherited = await sendMail(delayed)
    const overridden = await sendMail(delayed)
      .using('override')
      .onConnection('fluent-connection')
      .onQueue('fluent-queue')
      .delay(45)

    expect(inherited).toMatchObject({
      queued: true,
      mailer: 'transactional',
      driver: 'preview',
    })
    expect(overridden).toMatchObject({
      queued: true,
      mailer: 'override',
      driver: 'preview',
    })
    expect(queue.dispatches).toEqual([
      expect.objectContaining({
        jobName: mailRuntimeInternals.HOLO_MAIL_DELIVER_JOB,
        connection: 'mailer-connection',
        queue: 'mail-definition-queue',
        delay: delayAt,
      }),
      expect.objectContaining({
        jobName: mailRuntimeInternals.HOLO_MAIL_DELIVER_JOB,
        connection: 'fluent-connection',
        queue: 'fluent-queue',
        delay: 45,
      }),
    ])
    expect(listPreviewMailArtifacts()).toHaveLength(2)
    expect(queue.dispatches[1]!.payload).toMatchObject({
      mailer: 'override',
      driver: 'preview',
    })
  })

  it('throws a clear error when queue-backed delivery is requested without @holo-js/queue', async () => {
    mailRuntimeInternals.setQueueModuleLoader(async () => {
      const error = new Error('missing queue module') as Error & { code?: string }
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    })

    const mail = defineMail({
      from: 'noreply@example.com',
      to: 'ava@example.com',
      subject: 'Queued',
      markdown: '# Queued',
    })

    await expect(sendMail(mail).onQueue('mail')).rejects.toThrow(
      'Queued or delayed mail delivery requires @holo-js/queue to be installed',
    )
  })

  it('sends through the built-in preview and fake drivers and stores runtime records', async () => {
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'preview',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          preview: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.preview,
          },
          fake: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.fake,
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
      configureMailRuntime({
        config: {
          ...mailRuntimeInternals.getResolvedConfig(),
          default: 'preview',
          from: { email: 'config@example.com' },
          mailers: {
            ...mailRuntimeInternals.getResolvedConfig().mailers,
            preview: {
              ...mailRuntimeInternals.getResolvedConfig().mailers.preview,
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
      configureMailRuntime({
        config: {
          ...mailRuntimeInternals.getResolvedConfig(),
          from: { email: 'config@example.com' },
          mailers: {
            ...mailRuntimeInternals.getResolvedConfig().mailers,
            fake: {
              ...mailRuntimeInternals.getResolvedConfig().mailers.fake,
            },
            preview: {
              ...mailRuntimeInternals.getResolvedConfig().mailers.preview,
              path: previewRoot,
            },
          },
        },
      })

      await mailRuntimeInternals.persistPreviewArtifact({
        messageId: 'fake-mail-artifact',
        createdAt: new Date('2026-04-12T00:00:00.000Z'),
        mail: Object.freeze({
          from: { email: 'config@example.com' },
          replyTo: { email: 'config@example.com' },
          to: Object.freeze([{ email: 'ava@example.com' }]),
          cc: Object.freeze([]),
          bcc: Object.freeze([]),
          subject: 'Ignored fake artifact',
          attachments: Object.freeze([]),
          headers: Object.freeze({}),
          tags: Object.freeze([]),
        }),
        context: Object.freeze({
          messageId: 'fake-mail-artifact',
          mailer: 'fake',
          driver: 'fake',
          queued: false,
        }),
        result: Object.freeze({
          messageId: 'fake-mail-artifact',
          mailer: 'fake',
          driver: 'fake',
          queued: false,
        }),
      })

      expect(await readdir(previewRoot)).toEqual([])
    } finally {
      await rm(previewRoot, { recursive: true, force: true })
    }
  })

  it('queues built-in preview, fake, and log drivers and only captures on execution', async () => {
    const queue = createQueueModuleStub({ autoRun: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mailRuntimeInternals.setQueueModuleLoader(async () => queue.module)
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        from: { email: 'config@example.com' },
        default: 'preview',
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          preview: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.preview,
          },
          fake: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.fake,
          },
          log: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.log,
            logBodies: false,
          },
        },
      },
    })

    const previewMailDefinition = defineMail({
      to: 'ava@example.com',
      subject: 'Queued Preview',
      markdown: '# Queued Preview',
    })
    const fakeMailDefinition = defineMail({
      to: 'ava@example.com',
      subject: 'Queued Fake',
      markdown: '# Queued Fake',
      mailer: 'fake',
    })
    const logMailDefinition = defineMail({
      to: 'ava@example.com',
      subject: 'Queued Log',
      markdown: '# Queued Log',
      mailer: 'log',
    })

    const previewResult = await sendMail(previewMailDefinition).onQueue('mail')
    const fakeResult = await sendMail(fakeMailDefinition).onQueue('mail')
    const logResult = await sendMail(logMailDefinition).onQueue('mail')

    expect(previewResult.queued).toBe(true)
    expect(fakeResult.queued).toBe(true)
    expect(logResult.queued).toBe(true)
    expect(listPreviewMailArtifacts()).toHaveLength(0)
    expect(listFakeSentMails()).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()

    await queue.runDispatch(0)
    await queue.runDispatch(1)
    await queue.runDispatch(2)

    expect(listPreviewMailArtifacts()).toHaveLength(1)
    expect(listFakeSentMails()).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('translates smtp payloads through nodemailer with path, content, and storage attachments', async () => {
    const nodemailer = createNodemailerModuleStub({
      result: {
        messageId: 'smtp-provider-1',
        response: '250 queued',
      },
    })
    const storage = createStorageModuleStub()

    mailRuntimeInternals.setNodemailerModuleLoader(async () => nodemailer.module)
    mailRuntimeInternals.setStorageModuleLoader(async () => storage.module)
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'smtp',
        from: { email: 'config@example.com', name: 'Config Sender' },
        replyTo: { email: 'reply@example.com', name: 'Reply Team' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          smtp: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.smtp,
            from: { email: 'mailer@example.com', name: 'Mailer Sender' },
            replyTo: { email: 'mailer-reply@example.com', name: 'Mailer Reply' },
            host: 'smtp.internal',
            port: 2525,
            secure: true,
            user: 'mailer-user',
            password: 'mailer-pass',
          },
        },
      },
    })

    const mail = defineMail({
      to: [{ email: 'Ava@Example.com', name: 'Ava' }],
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      subject: 'SMTP Delivery',
      html: '<p>Hello</p>',
      text: 'Hello',
      headers: {
        'X-App': 'holo',
        'X-Priority': '9',
      },
      tags: ['billing', 'billing'],
      metadata: {
        invoiceId: 'inv-1',
      },
      priority: 'high',
      attachments: [
        {
          path: '/tmp/report.pdf',
        },
        {
          content: new Uint8Array([9, 8, 7]),
          name: 'bytes.bin',
          contentType: 'application/octet-stream',
        },
        {
          storage: {
            disk: 'local',
            path: 'reports/invoice.pdf',
          },
        },
        {
          storage: {
            disk: 's3',
            path: 'images/logo.png',
          },
          name: 'logo.png',
          disposition: 'inline',
          contentId: '<logo-cid>',
        },
      ],
    })

    const result = await sendMail(mail)

    expect(result).toMatchObject({
      driver: 'smtp',
      mailer: 'smtp',
      queued: false,
      providerMessageId: 'smtp-provider-1',
      provider: {
        response: '250 queued',
      },
    })
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.internal',
      port: 2525,
      secure: true,
      auth: {
        user: 'mailer-user',
        pass: 'mailer-pass',
      },
    })
    expect(nodemailer.sendMail).toHaveBeenCalledTimes(1)
    expect(nodemailer.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: {
        address: 'mailer@example.com',
        name: 'Mailer Sender',
      },
      replyTo: {
        address: 'mailer-reply@example.com',
        name: 'Mailer Reply',
      },
      to: [
        {
          address: 'ava@example.com',
          name: 'Ava',
        },
      ],
      cc: [
        {
          address: 'cc@example.com',
        },
      ],
      bcc: [
        {
          address: 'bcc@example.com',
        },
      ],
      subject: 'SMTP Delivery',
      html: '<p>Hello</p>',
      text: 'Hello',
      headers: expect.objectContaining({
        'X-App': 'holo',
        'X-Holo-Tags': 'billing',
        'X-Holo-Metadata': JSON.stringify({ invoiceId: 'inv-1' }),
        'X-Priority': '1',
        Importance: 'high',
        Priority: 'urgent',
      }),
    }))
    expect(nodemailer.sendMail.mock.calls[0]![0]).toMatchObject({
      attachments: [
        {
          filename: 'report.pdf',
          path: '/tmp/report.pdf',
          contentDisposition: 'attachment',
          contentType: 'application/pdf',
        },
        {
          filename: 'bytes.bin',
          content: new Uint8Array([9, 8, 7]),
          contentDisposition: 'attachment',
          contentType: 'application/octet-stream',
        },
        {
          filename: 'invoice.pdf',
          path: '/resolved/local/reports/invoice.pdf',
          contentDisposition: 'attachment',
          contentType: 'application/pdf',
        },
        {
          filename: 'logo.png',
          content: new Uint8Array([1, 2, 3, 4]),
          contentDisposition: 'inline',
          cid: 'logo-cid',
          contentType: 'image/png',
        },
      ],
    })
  })

  it('wraps smtp delivery failures with mail send context', async () => {
    const nodemailer = createNodemailerModuleStub({
      error: new Error('smtp boom'),
    })

    mailRuntimeInternals.setNodemailerModuleLoader(async () => nodemailer.module)
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'smtp',
        from: { email: 'config@example.com' },
      },
    })

    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'SMTP Failure',
      text: 'Failure',
    })

    await expect(sendMail(mail)).rejects.toBeInstanceOf(MailSendError)
    await expect(sendMail(mail)).rejects.toMatchObject({
      driver: 'smtp',
      mailer: 'smtp',
      cause: expect.objectContaining({
        message: 'smtp boom',
      }),
    })
  })

  it('defers mail delivery until commit and falls back to immediate execution without a transaction', async () => {
    const afterCommitCallbacks: Array<() => Promise<void>> = []

    mailRuntimeInternals.setDbModuleLoader(async () => ({
      connectionAsyncContext: {
        getActive() {
          return {
            connection: {
              getScope() {
                return { kind: 'transaction' }
              },
              afterCommit(callback: () => Promise<void>) {
                afterCommitCallbacks.push(callback)
              },
            },
          }
        },
      },
    }))
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'fake',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          fake: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.fake,
          },
        },
      },
    })

    const deferredMail = defineMail({
      to: 'ava@example.com',
      subject: 'Deferred',
      markdown: '# Deferred',
    })

    const deferred = await sendMail(deferredMail).afterCommit()
    expect(deferred).toMatchObject({
      queued: false,
      deferred: true,
      mailer: 'fake',
      driver: 'fake',
    })
    expect(listFakeSentMails()).toHaveLength(0)
    expect(afterCommitCallbacks).toHaveLength(1)

    await afterCommitCallbacks[0]!()

    expect(listFakeSentMails()).toHaveLength(1)
    expect(listFakeSentMails()[0]!.context).toMatchObject({
      queued: false,
      deferred: true,
    })

    resetFakeSentMails()
    afterCommitCallbacks.length = 0
    mailRuntimeInternals.setDbModuleLoader(async () => ({
      connectionAsyncContext: {
        getActive() {
          return {
            connection: {
              getScope() {
                return { kind: 'root' }
              },
              afterCommit() {
                throw new Error('should not defer from the root scope')
              },
            },
          }
        },
      },
    }))

    const immediate = await sendMail(deferredMail).afterCommit()
    expect(immediate).toMatchObject({
      queued: false,
    })
    expect(listFakeSentMails()).toHaveLength(1)
  })

  it('defers queued delivery until commit and preserves deferred context for runtime artifacts', async () => {
    const queue = createQueueModuleStub({ autoRun: false })
    const afterCommitCallbacks: Array<() => Promise<void>> = []

    mailRuntimeInternals.setQueueModuleLoader(async () => queue.module)
    mailRuntimeInternals.setDbModuleLoader(async () => ({
      connectionAsyncContext: {
        getActive() {
          return {
            connection: {
              getScope() {
                return { kind: 'transaction' }
              },
              afterCommit(callback: () => Promise<void>) {
                afterCommitCallbacks.push(callback)
              },
            },
          }
        },
      },
    }))
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'preview',
        from: { email: 'config@example.com' },
      },
    })

    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Deferred Queue',
      markdown: '# Deferred Queue',
    })

    const result = await sendMail(mail).onQueue('mail').afterCommit()
    expect(result).toMatchObject({
      queued: true,
      deferred: true,
      mailer: 'preview',
      driver: 'preview',
    })
    expect(queue.dispatches).toHaveLength(0)
    expect(listPreviewMailArtifacts()).toHaveLength(0)
    expect(afterCommitCallbacks).toHaveLength(1)

    await afterCommitCallbacks[0]!()

    expect(queue.dispatches).toHaveLength(1)
    expect(listPreviewMailArtifacts()).toHaveLength(0)

    await queue.runDispatch(0)

    expect(listPreviewMailArtifacts()).toHaveLength(1)
    expect(listPreviewMailArtifacts()[0]!.context).toMatchObject({
      queued: true,
      deferred: true,
    })
  })

  it('covers runtime helper branches and internal fallbacks', async () => {
    const originalVitest = process.env.VITEST
    const originalEval = globalThis.eval

    try {
      process.env.VITEST = ''

      const queueModule = { ok: 'queue' }
      const dbModule = { ok: 'db' }
      const nodemailerModule = {
        createTransport: vi.fn(() => ({
          sendMail: vi.fn(async () => ({ messageId: 'provider-id' })),
        })),
      }
      const storageModule = {
        Storage: {
          disk: vi.fn((disk?: string) => ({
            driver: disk === 's3' ? 's3' : 'local',
            path: (path: string) => `/resolved/${path}`,
            getBytes: vi.fn(async () => null),
          })),
        },
      }

      const evalMock = vi.fn()
      ;(globalThis as typeof globalThis & { eval: typeof eval }).eval = evalMock as never

      evalMock.mockResolvedValueOnce(queueModule)
      await expect(mailRuntimeInternals.loadQueueModule()).resolves.toBe(queueModule as never)

      const missingQueue = Object.assign(new Error('missing queue'), { code: 'ERR_MODULE_NOT_FOUND' })
      evalMock.mockRejectedValueOnce(missingQueue)
      await expect(mailRuntimeInternals.loadQueueModule()).rejects.toMatchObject({
        code: 'MAIL_QUEUE_MODULE_MISSING',
      })

      const queueFailure = new Error('queue failed')
      evalMock.mockRejectedValueOnce(queueFailure)
      await expect(mailRuntimeInternals.loadQueueModule()).rejects.toBe(queueFailure)
      mailRuntimeInternals.setQueueModuleLoader(async () => {
        throw new Error('override queue failed')
      })
      await expect(mailRuntimeInternals.loadQueueModule()).rejects.toThrow('override queue failed')
      mailRuntimeInternals.setQueueModuleLoader(undefined)

      evalMock.mockResolvedValueOnce(dbModule)
      await expect(mailRuntimeInternals.loadDbModule()).resolves.toBe(dbModule as never)

      const missingDb = Object.assign(new Error('missing db'), { code: 'ERR_MODULE_NOT_FOUND' })
      evalMock.mockRejectedValueOnce(missingDb)
      await expect(mailRuntimeInternals.loadDbModule()).resolves.toBeNull()

      const dbFailure = new Error('db failed')
      evalMock.mockRejectedValueOnce(dbFailure)
      await expect(mailRuntimeInternals.loadDbModule()).rejects.toBe(dbFailure)

      expect(mailRuntimeInternals.resolveNodemailerModule({
        default: nodemailerModule,
      })).toBe(nodemailerModule as never)
      expect(() => mailRuntimeInternals.resolveNodemailerModule({})).toThrow('Nodemailer could not be loaded')

      evalMock.mockResolvedValueOnce(nodemailerModule)
      await expect(mailRuntimeInternals.loadNodemailerModule()).resolves.toBe(nodemailerModule as never)

      const missingNodemailer = Object.assign(new Error('missing nodemailer'), { code: 'ERR_MODULE_NOT_FOUND' })
      evalMock.mockRejectedValueOnce(missingNodemailer)
      await expect(mailRuntimeInternals.loadNodemailerModule()).rejects.toMatchObject({
        code: 'MAIL_SMTP_MODULE_MISSING',
      })

      const nodemailerFailure = new Error('nodemailer failed')
      evalMock.mockRejectedValueOnce(nodemailerFailure)
      await expect(mailRuntimeInternals.loadNodemailerModule()).rejects.toBe(nodemailerFailure)

      expect(mailRuntimeInternals.resolveStorageModule(storageModule)).toBe(storageModule as never)
      expect(() => mailRuntimeInternals.resolveStorageModule({})).toThrow('storage runtime could not be loaded')

      evalMock.mockResolvedValueOnce(storageModule)
      await expect(mailRuntimeInternals.loadStorageModule()).resolves.toBe(storageModule as never)

      const missingStorage = Object.assign(new Error('missing storage'), { code: 'ERR_MODULE_NOT_FOUND' })
      evalMock.mockRejectedValueOnce(missingStorage)
      await expect(mailRuntimeInternals.loadStorageModule()).rejects.toMatchObject({
        code: 'MAIL_STORAGE_MODULE_MISSING',
      })

      const storageFailure = new Error('storage failed')
      evalMock.mockRejectedValueOnce(storageFailure)
      await expect(mailRuntimeInternals.loadStorageModule()).rejects.toBe(storageFailure)
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        Reflect.deleteProperty(process.env, 'VITEST')
      }
      ;(globalThis as typeof globalThis & { eval: typeof eval }).eval = originalEval
    }

    const barePreview = {
      messageId: 'mail-preview',
      source: {
        kind: 'text' as const,
      },
      mailer: 'preview',
      from: { email: 'from@example.com' },
      replyTo: { email: 'reply@example.com' },
      to: [{ email: 'to@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Plain Preview',
      attachments: [],
      metadata: {},
    }
    expect(mailRuntimeInternals.createPreviewHtml({
      ...barePreview,
      text: 'Only text',
    } as never)).toContain('<pre>Only text</pre>')
    expect(mailRuntimeInternals.createPreviewHtml({
      ...barePreview,
      cc: [{ email: 'cc@example.com' }],
      bcc: [{ email: 'bcc@example.com' }],
    } as never)).toContain('<strong>Bcc:</strong> bcc@example.com')
    expect(mailRuntimeInternals.createPreviewHtml(barePreview as never)).toContain('No rendered content is available')
    expect(mailRuntimeInternals.formatAddress({ email: 'ava@example.com', name: 'Ava' })).toContain('&lt;ava@example.com&gt;')
    expect(mailRuntimeInternals.escapeHtml(`'"<&`)).toBe('&#39;&quot;&lt;&amp;')

    expect(() => mailRuntimeInternals.getMailerConfig('missing', {
      ...mailRuntimeInternals.getResolvedConfig(),
      mailers: {},
    } as never)).toThrow('Mailer "missing" is not configured')
    expect(() => mailRuntimeInternals.normalizeExecutionString('   ', 'Queue name')).toThrow('Queue name must be a non-empty string')
    expect(() => mailRuntimeInternals.normalizeExecutionDelay(-1)).toThrow('greater than or equal to 0')
    expect(() => mailRuntimeInternals.normalizeExecutionDelay(new Date('invalid'))).toThrow('valid Date instances')
    expect(mailRuntimeInternals.normalizeExecutionDelay(new Date('2026-01-01T00:00:00.000Z'))).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    )

    const queueMailTrue = defineMail({
      to: 'ava@example.com',
      subject: 'Queued',
      markdown: '# Queued',
      queue: true,
    })
    const queueMailFalse = defineMail({
      to: 'ava@example.com',
      subject: 'Not queued',
      markdown: '# Nope',
      queue: false,
    })
    const queueMailExplicit = defineMail({
      to: 'ava@example.com',
      subject: 'Explicit',
      markdown: '# Explicit',
      queue: {
        queued: false,
      },
    })
    const queueMailFallback = defineMail({
      to: 'ava@example.com',
      subject: 'Fallback',
      markdown: '# Fallback',
    })
    const queueMailPlan = defineMail({
      to: 'ava@example.com',
      subject: 'Queued Plan',
      markdown: '# Queued Plan',
      queue: {
        queue: 'mail-only',
      },
    })
    const queueConfig = {
      ...mailRuntimeInternals.getResolvedConfig(),
      mailers: {
        preview: {
          ...mailRuntimeInternals.getResolvedConfig().mailers.preview,
          queue: {
            queued: true,
            connection: 'redis',
            queue: 'mail',
            afterCommit: false,
          },
        },
      },
    }
    expect(mailRuntimeInternals.isQueueRequested(queueMailTrue, 'preview', {}, queueConfig as never)).toBe(true)
    expect(mailRuntimeInternals.isQueueRequested(queueMailFalse, 'preview', {}, queueConfig as never)).toBe(false)
    expect(mailRuntimeInternals.isQueueRequested(queueMailExplicit, 'preview', {}, queueConfig as never)).toBe(false)
    expect(mailRuntimeInternals.isQueueRequested(queueMailFallback, 'preview', {}, queueConfig as never)).toBe(true)
    expect(mailRuntimeInternals.resolveQueuePlan(queueMailFallback, {}, 'preview', queueConfig as never)).toMatchObject({
      queued: true,
      connection: 'redis',
      queue: 'mail',
      afterCommit: false,
    })
    expect(mailRuntimeInternals.resolveQueuePlan(queueMailPlan, {}, 'preview', queueConfig as never)).toMatchObject({
      queued: true,
      queue: 'mail-only',
    })
    expect(mailRuntimeInternals.resolveQueuePlan(queueMailFalse, {}, 'preview', {
      ...queueConfig,
      queue: {
        ...queueConfig.queue,
        afterCommit: true,
      },
      mailers: {
        preview: {
          ...queueConfig.mailers.preview,
          queue: {
            ...queueConfig.mailers.preview.queue,
            afterCommit: undefined,
          },
        },
      },
    } as never).afterCommit).toBe(true)
    expect(mailRuntimeInternals.resolveQueuePlan(queueMailTrue, {}, 'preview', {
      ...queueConfig,
      queue: {
        ...queueConfig.queue,
        queue: 'global-mail',
      },
      mailers: {
        preview: {
          ...queueConfig.mailers.preview,
          queue: {
            queued: true,
            connection: 'redis',
            queue: undefined,
            afterCommit: false,
          },
        },
      },
    } as never)).toMatchObject({
      queued: true,
      queue: 'global-mail',
    })

    const context = mailRuntimeInternals.createSendContext('mail-1', {
      mailer: 'preview',
      driver: 'preview',
      implementation: mailRuntimeInternals.builtInDrivers.preview,
    }, false)
    expect(mailRuntimeInternals.normalizeDriverResult(undefined, context)).toMatchObject({
      messageId: 'mail-1',
      queued: false,
    })
    expect(mailRuntimeInternals.normalizeDriverResult({
      providerMessageId: 'provider-1',
      provider: {
        response: '250 accepted',
      },
    }, context)).toMatchObject({
      providerMessageId: 'provider-1',
      provider: {
        response: '250 accepted',
      },
    })
    expect(mailRuntimeInternals.renderMarkdown('# Heading')).toBe('<h1>Heading</h1>')

    expect(mailRuntimeInternals.createSmtpHeaders({
      headers: {},
      tags: [],
      priority: 'low',
    } as never)).toMatchObject({
      'X-Priority': '5',
      Importance: 'low',
      Priority: 'non-urgent',
    })
    expect(mailRuntimeInternals.createSmtpHeaders({
      headers: {},
      tags: [],
      priority: 'normal',
    } as never)).toMatchObject({
      'X-Priority': '3',
      Importance: 'normal',
      Priority: 'normal',
    })

    mailRuntimeInternals.setStorageModuleLoader(async () => ({
      Storage: {
        disk() {
          return {
            driver: 's3',
            path(path: string) {
              return `s3://bucket/${path}`
            },
            async getBytes() {
              return null
            },
          }
        },
      },
    }))
    await expect(mailRuntimeInternals.createSmtpAttachment({
      source: 'storage',
      name: 'logo.png',
      disposition: 'attachment',
      storage: {
        disk: 's3',
        path: 'images/logo.png',
      },
    } as never)).rejects.toThrow('could not be read for SMTP delivery')
    await expect(mailRuntimeInternals.createSmtpAttachment({
      source: 'resolve',
      name: 'broken.txt',
      disposition: 'attachment',
    } as never)).rejects.toThrow('could not be translated for SMTP delivery')

    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        from: { email: 'config@example.com' },
      },
    })
    const smtpResolvedMail = mailRuntimeInternals.createResolvedMail({
      messageId: 'mail-2',
      source: {
        kind: 'text',
      },
      mailer: 'preview',
      from: { email: 'config@example.com' },
      replyTo: { email: 'config@example.com' },
      to: [{ email: 'ava@example.com' }],
      cc: [],
      bcc: [],
      subject: 'SMTP',
      text: 'SMTP',
      attachments: [],
      metadata: {},
    } as never, [])
    expect(mailRuntimeInternals.createResolvedMail({
      ...barePreview,
      html: '<p>HTML only</p>',
    } as never, [])).toMatchObject({
      html: '<p>HTML only</p>',
    })
    await expect(mailRuntimeInternals.sendViaSmtp(
      smtpResolvedMail,
      mailRuntimeInternals.createSendContext('mail-2', {
        mailer: 'preview',
        driver: 'smtp',
        implementation: mailRuntimeInternals.builtInDrivers.smtp,
      }, false),
    )).rejects.toMatchObject({
      code: 'MAIL_SMTP_MAILER_INVALID',
    })
    const nodemailerWithoutResponse = createNodemailerModuleStub({
      result: {
        messageId: 'provider-only-id',
      },
    })
    mailRuntimeInternals.setNodemailerModuleLoader(async () => nodemailerWithoutResponse.module)
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'smtp',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          smtp: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.smtp,
            host: 'smtp.example.com',
            port: 587,
            secure: false,
          },
        },
      },
    })
    expect(await mailRuntimeInternals.createSmtpMessage({
      ...smtpResolvedMail,
      html: '<p>Hello</p>',
      text: undefined,
      headers: {},
      tags: [],
    } as never, mailRuntimeInternals.createSendContext('mail-3a', {
      mailer: 'smtp',
      driver: 'smtp',
      implementation: mailRuntimeInternals.builtInDrivers.smtp,
    }, false))).toMatchObject({
      html: '<p>Hello</p>',
    })
    await expect(mailRuntimeInternals.sendViaSmtp(
      {
        ...smtpResolvedMail,
        headers: {},
        tags: [],
        attachments: [],
      } as never,
      mailRuntimeInternals.createSendContext('mail-3', {
        mailer: 'smtp',
        driver: 'smtp',
        implementation: mailRuntimeInternals.builtInDrivers.smtp,
      }, false),
    )).resolves.toMatchObject({
      providerMessageId: 'provider-only-id',
    })
    const nodemailerWithoutMessageId = createNodemailerModuleStub({
      result: {
        response: '250 accepted',
      },
    })
    mailRuntimeInternals.setNodemailerModuleLoader(async () => nodemailerWithoutMessageId.module)
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'smtp',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          smtp: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.smtp,
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'mailer-user',
          },
        },
      },
    })
    await expect(mailRuntimeInternals.sendViaSmtp(
      {
        ...smtpResolvedMail,
        headers: {},
        tags: [],
        attachments: [],
      } as never,
      mailRuntimeInternals.createSendContext('mail-3ab', {
        mailer: 'smtp',
        driver: 'smtp',
        implementation: mailRuntimeInternals.builtInDrivers.smtp,
      }, false),
    )).resolves.toMatchObject({
      provider: {
        response: '250 accepted',
      },
    })
    const nodemailerWithResponse = createNodemailerModuleStub({
      result: {
        messageId: 'provider-response-id',
        response: '250 queued',
      },
    })
    mailRuntimeInternals.setNodemailerModuleLoader(async () => nodemailerWithResponse.module)
    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'smtp',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          smtp: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.smtp,
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'mailer-user',
            password: 'mailer-pass',
          },
        },
      },
    })
    await expect(mailRuntimeInternals.sendViaSmtp(
      {
        ...smtpResolvedMail,
        headers: {},
        tags: [],
        attachments: [],
      } as never,
      mailRuntimeInternals.createSendContext('mail-3b', {
        mailer: 'smtp',
        driver: 'smtp',
        implementation: mailRuntimeInternals.builtInDrivers.smtp,
      }, false),
    )).resolves.toMatchObject({
      providerMessageId: 'provider-response-id',
      provider: {
        response: '250 queued',
      },
    })
    mailRuntimeInternals.setNodemailerModuleLoader(undefined)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mailRuntimeInternals.builtInDrivers.log.send({
      ...smtpResolvedMail,
      tags: ['transactional'],
      priority: 'high',
      attachments: [
        {
          source: 'path',
          name: 'report.pdf',
          disposition: 'attachment',
          path: '/tmp/report.pdf',
        },
      ],
    } as never, mailRuntimeInternals.createSendContext('mail-log', {
      mailer: 'preview',
      driver: 'log',
      implementation: mailRuntimeInternals.builtInDrivers.log,
    }, false))).toMatchObject({
      driver: 'log',
    })
    expect(warn).toHaveBeenCalledWith('[@holo-js/mail] Logged mail send', expect.objectContaining({
      attachments: [
        {
          name: 'report.pdf',
          source: 'path',
          disposition: 'attachment',
        },
      ],
      tags: ['transactional'],
      priority: 'high',
    }))
    warn.mockRestore()

    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'custom-mailer',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          'custom-mailer': {
            driver: 'custom-driver',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: false,
              afterCommit: false,
            },
          },
        },
      } as never,
    })
    await expect(sendMail({
      to: 'ava@example.com',
      subject: 'Custom',
      markdown: '# Custom',
    })).rejects.toMatchObject({
      code: 'MAIL_DRIVER_NOT_REGISTERED',
    })
    registerMailDriver('resolved-driver', {
      async send() {
        return undefined
      },
    }, {
      replaceExisting: true,
    })
    expect(mailRuntimeInternals.resolveDriverByName('custom-mailer', 'resolved-driver')).toMatchObject({
      driver: 'resolved-driver',
    })
    expect(() => mailRuntimeInternals.resolveDriverByName('custom-mailer', 'missing-driver')).toThrow('is not registered')

    expect(mailRuntimeInternals.serializeQueuedAttachment({
      source: 'path',
      name: 'hello.txt',
      disposition: 'attachment',
      path: '/tmp/hello.txt',
    } as never)).toMatchObject({
      path: '/tmp/hello.txt',
    })
    const serializedStringAttachment = mailRuntimeInternals.serializeQueuedAttachment({
      source: 'content',
      name: 'hello.txt',
      disposition: 'attachment',
      content: 'hello',
    } as never)
    expect(mailRuntimeInternals.deserializeQueuedAttachment(serializedStringAttachment)).toMatchObject({
      content: 'hello',
    })
    expect(mailRuntimeInternals.deserializeQueuedAttachment({
      source: 'path',
      name: 'logo.png',
      disposition: 'attachment',
      path: '/tmp/logo.png',
    } as never)).toMatchObject({
      path: '/tmp/logo.png',
    })
    const serializedBytesAttachment = mailRuntimeInternals.serializeQueuedAttachment({
      source: 'content',
      name: 'hello.bin',
      disposition: 'attachment',
      content: new Uint8Array([1, 2, 3]),
    } as never)
    expect(mailRuntimeInternals.deserializeQueuedAttachment(serializedBytesAttachment)).toMatchObject({
      content: new Uint8Array([1, 2, 3]),
    })
    const serializedStorageAttachment = mailRuntimeInternals.serializeQueuedAttachment({
      source: 'storage',
      name: 'logo.png',
      contentType: 'image/png',
      disposition: 'inline',
      contentId: 'cid-logo',
      storage: {
        disk: 'public',
        path: 'logos/logo.png',
      },
    } as never)
    expect(mailRuntimeInternals.deserializeQueuedAttachment(serializedStorageAttachment)).toMatchObject({
      contentType: 'image/png',
      contentId: 'cid-logo',
      storage: {
        disk: 'public',
        path: 'logos/logo.png',
      },
    })
    const queuedPayload = mailRuntimeInternals.createQueuedMailPayload({
      ...smtpResolvedMail,
      html: '<p>Hello</p>',
      text: 'Hello',
      metadata: {
        tenantId: 'tenant-1',
      },
      priority: 'high',
    } as never, context)
    expect(mailRuntimeInternals.createQueuedMailPayload({
      ...smtpResolvedMail,
      html: undefined,
      text: undefined,
    } as never, context).mail).toMatchObject({
      subject: 'SMTP',
    })
    expect(queuedPayload.mail).toMatchObject({
      html: '<p>Hello</p>',
      text: 'Hello',
      metadata: {
        tenantId: 'tenant-1',
      },
      priority: 'high',
    })
    expect(mailRuntimeInternals.createResolvedMailFromQueuedPayload({
      ...queuedPayload,
      mail: {
        ...queuedPayload.mail,
        html: undefined,
        text: undefined,
      },
    } as never)).toMatchObject({
      subject: 'SMTP',
    })
    expect(mailRuntimeInternals.createResolvedMailFromQueuedPayload(queuedPayload)).toMatchObject({
      html: '<p>Hello</p>',
      text: 'Hello',
      metadata: {
        tenantId: 'tenant-1',
      },
      priority: 'high',
    })

    configureMailRuntime()
    await expect(mailRuntimeInternals.renderView({
      view: 'emails/welcome',
    })).rejects.toMatchObject({
      code: 'MAIL_VIEW_RENDERER_MISSING',
    })
    configureMailRuntime({
      renderView: vi.fn(async () => '   '),
    })
    await expect(mailRuntimeInternals.renderView({
      view: 'emails/welcome',
    })).rejects.toMatchObject({
      code: 'MAIL_VIEW_RENDER_FAILED',
    })

    expect(mailRuntimeInternals.renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>')
    expect(mailRuntimeInternals.renderMarkdown('Line one\nLine two')).toBe('<p>Line one<br />Line two</p>')
    expect(mailRuntimeInternals.resolveSourceKind({
      render: { view: 'emails/welcome' },
    } as never)).toBe('render')
    expect(mailRuntimeInternals.resolveSourceKind({
      markdown: '# Welcome',
    } as never)).toBe('markdown')
    expect(mailRuntimeInternals.resolveSourceKind({
      html: '<p>Hello</p>',
    } as never)).toBe('html')
    expect(mailRuntimeInternals.resolveSourceKind({
      text: 'Hello',
    } as never)).toBe('text')
    expect(mailRuntimeInternals.createMarkdownWrapperProps(defineMail({
      from: {
        email: 'noreply@example.com',
        name: 'No Reply',
      },
      to: 'ava@example.com',
      subject: 'Wrapped',
      markdown: '# Wrapped',
      text: 'Wrapped',
      tags: ['transactional'],
      metadata: {
        tenantId: 'tenant-1',
      },
      priority: 'high',
    }), {
      from: {
        email: 'noreply@example.com',
        name: 'No Reply',
      },
      replyTo: {
        email: 'noreply@example.com',
      },
      to: [{ email: 'ava@example.com' }],
      cc: [],
      bcc: [],
      config: mailRuntimeInternals.getResolvedConfig(),
      mailer: 'preview',
    }, '<h1>Wrapped</h1>', 'Wrapped')).toMatchObject({
      from: {
        email: 'noreply@example.com',
        name: 'No Reply',
      },
      tags: ['transactional'],
      metadata: {
        tenantId: 'tenant-1',
      },
      priority: 'high',
      text: 'Wrapped',
    })
    configureMailRuntime({
      renderView: vi.fn(async (input) => {
        if (input.view === 'emails/render-text') {
          return '<p>Rendered with text</p>'
        }

        return '<div>wrapped</div>'
      }),
    })
    await expect(mailRuntimeInternals.computePreview(defineMail({
      from: { email: 'noreply@example.com' },
      to: 'ava@example.com',
      subject: 'Render Text',
      render: {
        view: 'emails/render-text',
      },
      text: 'Render text fallback',
    }))).resolves.toMatchObject({
      preview: {
        html: '<p>Rendered with text</p>',
        text: 'Render text fallback',
        source: {
          kind: 'render',
        },
      },
    })

    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        from: undefined,
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          preview: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.preview,
            from: undefined,
            replyTo: undefined,
          },
        },
      } as never,
    })
    expect(() => mailRuntimeInternals.resolveEnvelope(defineMail({
      to: 'ava@example.com',
      subject: 'Missing from',
      markdown: '# Missing',
    }))).toThrow('requires a resolvable from address')

    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        from: { email: 'config@example.com' },
        preview: {
          allowedEnvironments: ['test'],
        },
      },
      preview: vi.fn(async ({ mail }) => ({
        messageId: 'preview-override',
        source: {
          kind: 'text',
        },
        mailer: 'preview',
        from: { email: 'config@example.com' },
        replyTo: { email: 'config@example.com' },
        to: mail.to,
        cc: [],
        bcc: [],
        subject: mail.subject,
        text: 'override preview',
        attachments: [],
        metadata: {},
      })),
      renderPreview: vi.fn(async () => new Response('override render')),
    })
    await expect(previewMail({
      to: 'ava@example.com',
      subject: 'Override',
      markdown: '# Override',
    })).resolves.toMatchObject({
      text: 'override preview',
    })
    const overrideResponse = await renderMailPreview({
      to: 'ava@example.com',
      subject: 'Override render',
      markdown: '# Override render',
    })
    await expect(overrideResponse.text()).resolves.toBe('override render')

    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        from: { email: 'config@example.com' },
        preview: {
          allowedEnvironments: ['test'],
        },
      },
      preview: vi.fn(async () => {
        throw new Error('preview boom')
      }),
    })
    await expect(renderMailPreview({
      to: 'ava@example.com',
      subject: 'Boom',
      markdown: '# Boom',
    })).rejects.toThrow('preview boom')

    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        from: { email: 'config@example.com' },
        default: 'failing',
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          failing: {
            driver: 'failing-driver',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: false,
              afterCommit: false,
            },
          },
        },
      } as never,
    })
    registerMailDriver('failing-driver', {
      async send() {
        throw new Error('send failed')
      },
    }, {
      replaceExisting: true,
    })
    await expect(sendMail({
      to: 'ava@example.com',
      subject: 'Catch',
      markdown: '# Catch',
    }).catch(error => {
      expect(error).toBeInstanceOf(MailSendError)
      return {
        messageId: 'caught',
        mailer: 'caught',
        driver: 'caught',
        queued: false,
      }
    })).resolves.toMatchObject({
      messageId: 'caught',
    })
    await expect(sendMail({
      to: 'ava@example.com',
      subject: 'Finally',
      markdown: '# Finally',
    }).finally(() => undefined)).rejects.toBeInstanceOf(MailSendError)

    const runtime = getMailRuntime()
    expect(getMailRuntimeBindings()).toBe(mailRuntimeInternals.getRuntimeBindings())
    expect(runtime.sendMail).toBe(sendMail)
    expect(runtime.previewMail).toBe(previewMail)
    expect(runtime.renderMailPreview).toBe(renderMailPreview)
  })

  it('logs summary output by default and includes bodies only when verbose log mode is enabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    configureMailRuntime({
      config: {
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'log',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
          log: {
            ...mailRuntimeInternals.getResolvedConfig().mailers.log,
            logBodies: false,
          },
          verbose: {
            name: 'verbose',
            driver: 'log',
            from: { email: 'config@example.com' },
            replyTo: { email: 'config@example.com' },
            queue: {
              queued: false,
              connection: undefined,
              queue: undefined,
              afterCommit: false,
            },
            logBodies: true,
          },
        },
      },
    })

    const mail = defineMail({
      to: 'ava@example.com',
      subject: 'Logged',
      html: '<p>Logged</p>',
      text: 'Logged',
    })

    await sendMail(mail)
    await sendMail(mail).using('verbose')

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenNthCalledWith(1, '[@holo-js/mail] Logged mail send', expect.objectContaining({
      driver: 'log',
      subject: 'Logged',
      hasHtml: true,
      hasText: true,
    }))
    expect(warn).toHaveBeenNthCalledWith(2, '[@holo-js/mail] Logged mail send', expect.objectContaining({
      driver: 'log',
      html: '<p>Logged</p>',
      text: 'Logged',
    }))
  })

  it('uses registered custom drivers and wraps thrown driver errors', async () => {
    const customSend = vi.fn(async () => ({
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
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'transactional',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
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
        ...mailRuntimeInternals.getResolvedConfig(),
        default: 'failing-mailer',
        from: { email: 'config@example.com' },
        mailers: {
          ...mailRuntimeInternals.getResolvedConfig().mailers,
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
