import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { configureMailRuntime, defineMail, MailSendError, normalizeMailConfig, previewMail, renderMailPreview, resetMailRuntime, sendMail } from '../src'

type SmtpServerOptions = {
  readonly rejectRecipient?: boolean
  readonly holdAcceptance?: Promise<void>
}

async function startSmtpServer({ rejectRecipient = false, holdAcceptance }: SmtpServerOptions = {}) {
  const messages: string[] = []
  const commands: string[] = []
  const stats = { connections: 0, closedConnections: 0 }
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    stats.connections++
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      stats.closedConnections++
    })
    socket.setEncoding('utf8')
    socket.write('220 Local SMTP provider\r\n')
    let buffer = ''
    let data: string[] | undefined
    socket.on('data', chunk => {
      buffer += chunk
      let separator = buffer.indexOf('\r\n')
      while (separator >= 0) {
        const line = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        if (data) {
          if (line === '.') {
            messages.push(data.join('\r\n'))
            data = undefined
            if (holdAcceptance) void holdAcceptance.then(() => socket.write('250 Message accepted\r\n'))
            else socket.write('250 Message accepted\r\n')
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line)
          }
        } else {
          commands.push(line)
          if (line === 'DATA') {
            data = []
            socket.write('354 Send message\r\n')
          } else if (line === 'QUIT') {
            socket.end('221 Goodbye\r\n')
          } else if (rejectRecipient && line.startsWith('RCPT TO:')) {
            socket.write('550 Mailbox unavailable\r\n')
          } else {
            socket.write('250 OK\r\n')
          }
        }
        separator = buffer.indexOf('\r\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('SMTP provider did not bind a port')
  const dropConnections = () => {
    for (const socket of sockets) socket.destroy()
  }
  return { messages, commands, stats, port: address.port, dropConnections }
}

async function startSmtpProvider(options: SmtpServerOptions = {}) {
  const provider = await startSmtpServer(options)
  configureMailRuntime({
    config: normalizeMailConfig({
      default: 'smtp',
      from: { email: 'mailer@example.com', name: 'Mailer Sender' },
      replyTo: { email: 'reply@example.com' },
      mailers: { smtp: { driver: 'smtp', host: '127.0.0.1', port: provider.port, secure: false } },
    }),
  })
  return provider
}

afterEach(() => resetMailRuntime())

async function runOneShotSmtpSend(port: number): Promise<void> {
  const srcPath = resolve(import.meta.dirname, '../src/index.ts')
  const script = `
import assert from 'node:assert/strict'
import { configureMailRuntime, defineMail, normalizeMailConfig, sendMail } from ${JSON.stringify(srcPath)}
configureMailRuntime({ config: normalizeMailConfig({
  default: 'smtp', from: { email: 'mailer@example.com' },
  mailers: { smtp: { driver: 'smtp', host: '127.0.0.1', port: ${port}, secure: false } },
}) })
const result = await sendMail(defineMail({ to: 'ava@example.com', subject: 'One-shot script', text: 'Hello' }))
assert.equal(result.driver, 'smtp')
`
  const compiled = await build({ stdin: { contents: script, resolveDir: import.meta.dirname }, tsconfigRaw: { compilerOptions: {} }, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false })
  const entry = compiled.outputFiles[0]
  if (!entry) throw new Error('One-shot mail script compilation produced no entry')
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', entry.text], { cwd: resolve(import.meta.dirname, '..'), timeout: 10000 })
}

async function runNativeMailWorker(port: number, operation: 'queue' | 'transaction' | 'queued-transaction' | 'storage' | 'log' | 'delayed' | 'builtins' | 'plugin' | 'broken-plugin', s3Port?: number): Promise<{ stdout: string, stderr: string }> {
  const harnessPath = resolve(import.meta.dirname, '../../queue-db/tests/support/sqlite-queue.ts')
  const storageRuntimePath = resolve(import.meta.dirname, '../../core/src/storageRuntime.ts')
  const script = `
import assert from 'node:assert/strict'
import { createSQLiteQueueHarness } from ${JSON.stringify(harnessPath)}
import { configurePlainNodeStorageRuntime } from ${JSON.stringify(storageRuntimePath)}
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import { Storage, resetStorageRuntime } from '@holo-js/storage/runtime'
import '@holo-js/storage/config'
import { configureMailRuntime, normalizeMailConfig, defineMail, sendMail, listFakeSentMails, listPreviewMailArtifacts, loadMailPluginDrivers } from '@holo-js/mail'
import { runQueueWorker } from '@holo-js/queue'
const harness = await createSQLiteQueueHarness()
configureMailRuntime({ config: normalizeMailConfig({
  default: 'smtp', from: { email: 'mailer@example.com' },
  mailers: { smtp: { driver: 'smtp', host: '127.0.0.1', port: ${port}, secure: false } },
}) })
try {
  if (${JSON.stringify(operation)} === 'queue') {
    const result = await sendMail(defineMail({ to: 'ava@example.com', subject: 'Native queued delivery', text: 'Queued message', attachments: [{ content: new Uint8Array([9, 8, 7]), name: 'bytes.bin' }], queue: { queued: true, connection: 'database', queue: 'mail' } }))
    assert.equal(result.queued, true)
    assert.equal((await harness.readJobRows()).length, 1)
    const work = await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true })
    assert.equal(work.processed, 1)
    assert.equal(work.failed, 0)
    assert.deepEqual(await harness.readJobRows(), [])
  } else if (${JSON.stringify(operation)} === 'delayed') {
    configureMailRuntime({ config: normalizeMailConfig({ default: 'smtp', from: { email: 'sender@example.com' }, mailers: { smtp: { driver: 'smtp', host: '127.0.0.1', port: ${port}, secure: false, queue: { queued: true, connection: 'database', queue: 'inherited' } }, transactional: { driver: 'smtp', host: '127.0.0.1', port: ${port}, secure: false, queue: { queued: true, connection: 'database', queue: 'mailer-default' } } } }) })
    const mail = defineMail({ to: 'ava@example.com', subject: 'Delayed fluent delivery', text: 'Delayed', queue: { queued: true, queue: 'definition' } })
    const result = await sendMail(mail).using('transactional').onConnection('database').onQueue('mail').delay(1)
    assert.equal(result.mailer, 'transactional')
    assert.equal(result.queued, true)
    let work = await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true })
    assert.equal(work.processed, 0)
    await new Promise(resolve => setTimeout(resolve, 1200))
    work = await runQueueWorker({ connection: 'database', queueNames: ['inherited', 'mailer-default', 'definition'], once: true })
    assert.equal(work.processed, 0)
    work = await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true })
    assert.equal(work.processed, 1)
    assert.equal(work.failed, 0)
  } else if (${JSON.stringify(operation)} === 'broken-plugin') {
    const project = await mkdtemp(join(tmpdir(), 'holo-native-broken-mail-plugin-'))
    const previousCwd = process.cwd()
    try {
      const pluginRoot = join(project, 'node_modules/holo-plugin-broken-mail')
      await mkdir(pluginRoot, { recursive: true })
      await mkdir(join(project, 'config'))
      await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }))
      await writeFile(join(project, 'config/app.ts'), "export default { plugins: ['holo-plugin-broken-mail'] }")
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'holo-plugin-broken-mail', type: 'module', holo: { plugin: './plugin.mjs' } }))
      await writeFile(join(pluginRoot, 'plugin.mjs'), 'export default ' + JSON.stringify({ id: 'broken', contributes: { mail: { drivers: { broken: { runtime: './driver.mjs' } } } } }))
      await writeFile(join(pluginRoot, 'driver.mjs'), 'export default {}')
      process.chdir(project)
      configureMailRuntime({ config: normalizeMailConfig({ default: 'log', from: { email: 'sender@example.com' } }) })
      const result = await sendMail(defineMail({ to: 'ava@example.com', subject: 'Native builtin log', text: 'Logged' }))
      assert.equal(result.driver, 'log')
      assert.equal(result.queued, false)
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(loadMailPluginDrivers(project, ['holo-plugin-broken-mail']), /must export send\\(\\)/)
    } finally {
      process.chdir(previousCwd)
      await rm(project, { recursive: true, force: true })
    }
  } else if (${JSON.stringify(operation)} === 'plugin') {
    const project = await mkdtemp(join(tmpdir(), 'holo-native-queued-mail-plugin-'))
    try {
      const pluginRoot = join(project, 'node_modules/holo-plugin-receipt')
      const receipt = join(project, 'delivery.json')
      await mkdir(pluginRoot, { recursive: true })
      await mkdir(join(project, 'config'))
      await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }))
      await writeFile(join(project, 'config/app.ts'), "export default { plugins: ['holo-plugin-receipt'] }")
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'holo-plugin-receipt', type: 'module', holo: { plugin: './plugin.mjs' } }))
      await writeFile(join(pluginRoot, 'plugin.mjs'), 'export default ' + JSON.stringify({ id: 'receipt', contributes: { mail: { drivers: { receipt: { runtime: './driver.mjs' } } } } }))
      await writeFile(join(pluginRoot, 'driver.mjs'), 'import { writeFile } from "node:fs/promises"; export default { async send(mail, context) { await writeFile(' + JSON.stringify(receipt) + ', JSON.stringify({ subject: mail.subject, queued: context.queued, mailer: context.mailer, driver: context.driver })); return { messageId: context.messageId, queued: context.queued, mailer: context.mailer, driver: context.driver } } }')
      configureMailRuntime({ projectRoot: project, plugins: ['holo-plugin-receipt'], config: normalizeMailConfig({ default: 'transactional', from: { email: 'sender@example.com' }, mailers: { transactional: { driver: 'receipt' } } }) })
      const result = await sendMail(defineMail({ to: 'ava@example.com', subject: 'Queued plugin receipt', text: 'Receipt' })).onConnection('database').onQueue('mail')
      assert.equal(result.queued, true)
      await assert.rejects(readFile(receipt), { code: 'ENOENT' })
      const work = await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true })
      assert.equal(work.processed, 1)
      assert.equal(work.failed, 0)
      assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { subject: 'Queued plugin receipt', queued: true, mailer: 'transactional', driver: 'receipt' })
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  } else if (${JSON.stringify(operation)} === 'builtins') {
    const previewRoot = await mkdtemp(join(tmpdir(), 'holo-native-queued-preview-'))
    try {
      configureMailRuntime({ config: normalizeMailConfig({ default: 'preview', from: { email: 'sender@example.com' }, mailers: { preview: { driver: 'preview', path: previewRoot }, fake: { driver: 'fake' }, log: { driver: 'log', logBodies: false } } }) })
      for (const mailer of ['preview', 'fake', 'log']) {
        const result = await sendMail(defineMail({ to: 'ava@example.com', subject: 'Native ' + mailer, text: 'Queued ' + mailer })).using(mailer).onConnection('database').onQueue('mail')
        assert.equal(result.queued, true)
      }
      assert.equal(listFakeSentMails().length, 0)
      assert.equal(listPreviewMailArtifacts().length, 0)
      assert.deepEqual(await readdir(previewRoot), [])
      for (let index = 0; index < 3; index++) {
        const work = await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true })
        assert.equal(work.processed, 1)
        assert.equal(work.failed, 0)
      }
      assert.equal(listFakeSentMails().length, 1)
      assert.equal(listFakeSentMails()[0].mail.subject, 'Native fake')
      assert.equal(listPreviewMailArtifacts().length, 1)
      assert.equal(listPreviewMailArtifacts()[0].mail.subject, 'Native preview')
      const files = await readdir(previewRoot)
      assert.equal(files.length, 1)
      const preview = JSON.parse(await readFile(join(previewRoot, files[0]), 'utf8'))
      assert.equal(preview.mail.subject, 'Native preview')
      assert.deepEqual(await harness.readJobRows(), [])
    } finally {
      await rm(previewRoot, { recursive: true, force: true })
    }
  } else if (${JSON.stringify(operation)} === 'log') {
    configureMailRuntime({ config: normalizeMailConfig({ default: 'log', from: { email: 'sender@example.com' }, mailers: { log: { driver: 'log', logBodies: false }, verbose: { driver: 'log', logBodies: true } } }) })
    await sendMail(defineMail({ to: 'ava@example.com', subject: 'Summary only', text: 'Hidden summary body', html: '<p>Hidden summary body</p>' }))
    await sendMail(defineMail({ to: 'ava@example.com', subject: 'Verbose delivery', text: 'Visible verbose body', html: '<p>Visible verbose body</p>' })).using('verbose')
  } else if (${JSON.stringify(operation)} === 'storage') {
    const project = await mkdtemp(join(tmpdir(), 'holo-native-mail-storage-'))
    try {
      await mkdir(join(project, 'config'))
      await writeFile(join(project, 'config/app.ts'), "export default { name: 'Mail storage', key: 'native-mail-storage-key' }")
      await mkdir(join(project, 'node_modules/@holo-js'), { recursive: true })
      await symlink(${JSON.stringify(resolve(import.meta.dirname, '../../storage-s3'))}, join(project, 'node_modules/@holo-js/storage-s3'))
      await writeFile(join(project, 'config/storage.ts'), 'export default ' + JSON.stringify({ defaultDisk: 'local', disks: { local: { driver: 'local', root: './files' }, archive: { driver: 's3', bucket: 'archive', region: 'us-east-1', endpoint: 'http://127.0.0.1:${s3Port}', accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key', forcePathStyleEndpoint: true } } }))
      await configurePlainNodeStorageRuntime(project, await loadConfigDirectory(project))
      await Storage.put('reports/invoice.txt', 'Real persisted attachment')
      await sendMail(defineMail({ to: 'ava@example.com', subject: 'Native stored attachment', text: 'Stored', attachments: [{ storage: { disk: 'local', path: 'reports/invoice.txt' } }, { storage: { disk: 'archive', path: 'reports/logo.png' }, disposition: 'inline', contentId: 'stored-logo' }] }))
    } finally {
      resetStorageRuntime()
      await rm(project, { recursive: true, force: true })
    }
  } else {
    const queued = ${JSON.stringify(operation)} === 'queued-transaction'
    const mail = defineMail({ to: 'ava@example.com', subject: 'Committed delivery', text: 'Committed', ...(queued ? { queue: { queued: true, connection: 'database', queue: 'mail' } } : {}) })
    await assert.rejects(harness.connection.transaction(async () => {
      const result = await sendMail(mail).afterCommit()
      assert.equal(result.deferred, true)
      assert.deepEqual(await harness.readJobRows(), [])
      throw new Error('Rollback mail')
    }), /Rollback mail/)
    assert.deepEqual(await harness.readJobRows(), [])
    await harness.connection.transaction(async () => {
      const result = await sendMail(mail).afterCommit()
      assert.equal(result.deferred, true)
      assert.deepEqual(await harness.readJobRows(), [])
    })
    if (queued) {
      assert.equal((await harness.readJobRows()).length, 1)
      const work = await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true })
      assert.equal(work.processed, 1)
      assert.equal(work.failed, 0)
      assert.deepEqual(await harness.readJobRows(), [])
    }
  }
} finally {
  await harness.cleanup()
}
`
  const compiled = await build({ stdin: { contents: script, resolveDir: import.meta.dirname }, tsconfigRaw: { compilerOptions: {} }, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false })
  const entry = compiled.outputFiles[0]
  if (!entry) throw new Error('Native mail test compilation produced no entry')
  return await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', entry.text], { cwd: resolve(import.meta.dirname, '..'), timeout: 15000 })
}

it('delivers real MIME, recipients, and attachments through the native SMTP client', async () => {
  const provider = await startSmtpProvider()
  const directory = await mkdtemp(join(tmpdir(), 'holo-native-mail-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'report.pdf')
  await writeFile(path, 'Native PDF attachment')
  const result = await sendMail(defineMail({
    to: { email: 'Ava@Example.com', name: 'Ava' },
    cc: 'cc@example.com',
    bcc: 'bcc@example.com',
    subject: 'Native SMTP delivery',
    html: '<p>Hello Ava</p>',
    text: 'Hello Ava',
    headers: { 'X-App': 'holo', 'X-Priority': '9' },
    tags: ['billing', 'billing'],
    metadata: { invoiceId: 'inv-1' },
    priority: 'high',
    attachments: [{ path }, { content: new Uint8Array([9, 8, 7]), name: 'bytes.bin' }, { content: new Uint8Array([1, 2, 3, 4]), name: 'logo.png', disposition: 'inline', contentId: '<logo-cid>' }],
  }))
  expect(result).toMatchObject({ driver: 'smtp', mailer: 'smtp', queued: false })
  expect(result.providerMessageId).toEqual(expect.any(String))
  expect(provider.commands).toEqual(expect.arrayContaining(['MAIL FROM:<mailer@example.com>', 'RCPT TO:<ava@example.com>', 'RCPT TO:<cc@example.com>', 'RCPT TO:<bcc@example.com>']))
  expect(provider.messages).toHaveLength(1)
  const message = provider.messages[0]!
  expect(message).toContain('Subject: Native SMTP delivery')
  expect(message).toContain('Reply-To: reply@example.com')
  expect(message).toContain('X-App: holo')
  expect(message).toContain('X-Holo-Tags: billing')
  expect(message).toContain('X-Holo-Metadata: =?UTF-8?Q?=7B=22invoiceId=22=3A=22inv-1=22=7D?=')
  expect(message).toContain('X-Priority: 1')
  expect(message).toContain('Importance: high')
  expect(message).toContain('Hello Ava')
  expect(message).toContain('filename=report.pdf')
  expect(message).toContain('TmF0aXZlIFBERiBhdHRhY2htZW50')
  expect(message).toContain('filename=bytes.bin')
  expect(message).toContain('CQgH')
  expect(message).toContain('Content-ID: <logo-cid>')
  expect(message).toContain('AQIDBA==')
  expect(message).not.toMatch(/^Bcc:/m)
})

it('escapes app-provided mail content and rejects executable markdown links in real previews', async () => {
  const mail = defineMail({
    to: 'ava@example.com',
    from: 'sender@example.com',
    subject: '<script>alert(1)</script>',
    markdown: '[safe](https://example.test) [bad](javascript:alert)\n\n<script>alert(1)</script>',
  })
  configureMailRuntime({ config: normalizeMailConfig({ preview: { allowedEnvironments: ['test'] } }), environment: 'test' })
  const preview = await previewMail(mail)
  expect(preview.html).toContain('href="https://example.test"')
  expect(preview.html).not.toContain('href="javascript:')
  expect(preview.html).not.toContain('<script>')
  const response = await renderMailPreview(mail)
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>alert(1)</script>')
})

it('escapes a markdown link href once and keeps the label escaped once in real previews', async () => {
  const mail = defineMail({
    to: 'ava@example.com',
    from: 'sender@example.com',
    subject: 'Links',
    markdown: '[Search](https://example.test/?a=1&b=2) [A & B](https://example.test/b) [bad](javascript:alert)',
  })
  configureMailRuntime({ config: normalizeMailConfig({ preview: { allowedEnvironments: ['test'] } }), environment: 'test' })
  const preview = await previewMail(mail)
  expect(preview.html).toContain('<a href="https://example.test/?a=1&amp;b=2">Search</a>')
  expect(preview.html).toContain('<a href="https://example.test/b">A &amp; B</a>')
  expect(preview.html).toContain('bad')
  expect(preview.html).not.toContain('&amp;amp;')
  expect(preview.html).not.toContain('javascript:')
})

it('reports a real SMTP rejection with the native mailer context', async () => {
  const provider = await startSmtpProvider({ rejectRecipient: true })
  let finalized = false
  const result = await sendMail(defineMail({ to: 'ava@example.com', subject: 'Rejected delivery', text: 'Hello' }))
    .finally(() => { finalized = true })
    .catch((error: unknown) => error)
  expect(finalized).toBe(true)
  expect(result).toBeInstanceOf(MailSendError)
  expect(result).toMatchObject({ driver: 'smtp', mailer: 'smtp', cause: { responseCode: 550 } })
  expect(provider.messages).toEqual([])
})

it('reuses one SMTP connection for sequential sends through the same mailer', async () => {
  const provider = await startSmtpProvider()
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'First pooled send', text: 'One' }))
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Second pooled send', text: 'Two' }))
  expect(provider.messages).toHaveLength(2)
  expect(provider.stats.connections).toBe(1)
})

it('reconnects for the next send after the server drops the idle connection', async () => {
  const provider = await startSmtpProvider()
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Before idle drop', text: 'One' }))
  provider.dropConnections()
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'After idle drop', text: 'Two' }))
  expect(provider.messages).toHaveLength(2)
  expect(provider.messages[1]).toContain('Subject: After idle drop')
  expect(provider.stats.connections).toBe(2)
})

it('lets a one-shot script exit after its SMTP send instead of holding the pooled connection open', async () => {
  const provider = await startSmtpServer()
  await runOneShotSmtpSend(provider.port)
  expect(provider.messages).toHaveLength(1)
})

it('keeps an in-flight send alive through reconfiguration and closes its connection once it finishes', async () => {
  let acceptMessage!: () => void
  const accepted = new Promise<void>(resolve => { acceptMessage = resolve })
  const provider = await startSmtpProvider({ holdAcceptance: accepted })
  const send = Promise.resolve(sendMail(defineMail({ to: 'ava@example.com', subject: 'In flight', text: 'Hello' })))
  await vi.waitFor(() => expect(provider.messages).toHaveLength(1))
  resetMailRuntime()
  acceptMessage()
  await expect(send).resolves.toMatchObject({ driver: 'smtp', mailer: 'smtp' })
  await vi.waitFor(() => expect(provider.stats.closedConnections).toBe(1))
})

it('closes the cached SMTP connection when the mail runtime is reset', async () => {
  const provider = await startSmtpProvider()
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Before reset', text: 'One' }))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(provider.stats.closedConnections).toBe(0)
  resetMailRuntime()
  await vi.waitFor(() => expect(provider.stats.closedConnections).toBe(1))
})

it('keeps a separate SMTP connection for each mailer', async () => {
  const primary = await startSmtpServer()
  const secondary = await startSmtpServer()
  configureMailRuntime({
    config: normalizeMailConfig({
      default: 'primary',
      from: { email: 'mailer@example.com' },
      mailers: {
        primary: { driver: 'smtp', host: '127.0.0.1', port: primary.port, secure: false },
        secondary: { driver: 'smtp', host: '127.0.0.1', port: secondary.port, secure: false },
      },
    }),
  })
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Primary mailer', text: 'One' }))
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Secondary mailer', text: 'Two' })).using('secondary')
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Primary again', text: 'Three' }))
  expect(primary.messages).toHaveLength(2)
  expect(secondary.messages).toHaveLength(1)
  expect(primary.stats.connections).toBe(1)
  expect(secondary.stats.connections).toBe(1)
})

it('replaces the cached SMTP connection when the mailer config changes', async () => {
  const previous = await startSmtpProvider()
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'Before config change', text: 'One' }))
  const next = await startSmtpServer()
  configureMailRuntime({
    config: normalizeMailConfig({
      default: 'smtp',
      from: { email: 'mailer@example.com' },
      mailers: { smtp: { driver: 'smtp', host: '127.0.0.1', port: next.port, secure: false } },
    }),
  })
  await sendMail(defineMail({ to: 'ava@example.com', subject: 'After config change', text: 'Two' }))
  expect(next.messages).toHaveLength(1)
  expect(next.stats.connections).toBe(1)
  await vi.waitFor(() => expect(previous.stats.closedConnections).toBe(1))
})

it('requires usable app renderers for view-backed previews', async () => {
  const mail = defineMail({ from: 'sender@example.com', to: 'ava@example.com', subject: 'Rendered view', render: { view: 'emails/welcome' } })
  await expect(previewMail(mail)).rejects.toMatchObject({ code: 'MAIL_VIEW_RENDERER_MISSING' })
  configureMailRuntime({ renderView: async () => '   ' })
  await expect(previewMail(mail)).rejects.toMatchObject({ code: 'MAIL_VIEW_RENDER_FAILED' })
})

it('uses app preview overrides and propagates app rendering failures', async () => {
  const config = normalizeMailConfig({ from: { email: 'sender@example.com' }, preview: { allowedEnvironments: ['test'] } })
  const mail = defineMail({ to: 'ava@example.com', subject: 'App preview', text: 'Original' })
  configureMailRuntime({
    config,
    environment: 'test',
    preview: async ({ mail }) => ({
      source: { kind: 'text' },
      from: { email: 'sender@example.com' },
      replyTo: { email: 'sender@example.com' },
      to: mail.to,
      cc: [],
      bcc: [],
      subject: mail.subject,
      text: 'App rendered preview',
      attachments: [],
      headers: {},
      tags: [],
    }),
    renderPreview: async () => new Response('App rendered page'),
  })
  await expect(previewMail(mail)).resolves.toMatchObject({ text: 'App rendered preview' })
  await expect((await renderMailPreview(mail)).text()).resolves.toBe('App rendered page')
  configureMailRuntime({ config, environment: 'test', preview: async () => { throw new Error('App preview failed') } })
  await expect(renderMailPreview(mail)).rejects.toThrow('App preview failed')
})

it('delivers queued mail only when the real SQLite worker runs', async () => {
  const provider = await startSmtpProvider()
  expect(provider.messages).toEqual([])
  await runNativeMailWorker(provider.port, 'queue')
  expect(provider.messages).toHaveLength(1)
  expect(provider.messages[0]).toContain('Subject: Native queued delivery')
  expect(provider.messages[0]).toContain('filename=bytes.bin')
  expect(provider.messages[0]).toContain('CQgH')
})

it.each(['transaction', 'queued-transaction'] as const)('sends after a real %s commit and discards delivery after rollback', async operation => {
  const provider = await startSmtpProvider()
  await runNativeMailWorker(provider.port, operation)
  expect(provider.messages).toHaveLength(1)
  expect(provider.messages[0]).toContain('Subject: Committed delivery')
})

it('reads mail attachments from the real configured filesystem disk', async () => {
  const provider = await startSmtpProvider()
  const requests: Array<{ method: string | undefined, path: string | undefined, authorization: string | undefined }> = []
  const s3 = createHttpServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization })
    response.setHeader('content-type', 'image/png')
    response.end(Buffer.from([1, 2, 3, 4]))
  })
  await new Promise<void>(resolve => s3.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve, reject) => s3.close(error => error ? reject(error) : resolve())))
  const address = s3.address()
  if (!address || typeof address === 'string') throw new Error('The local S3 provider did not bind a port')
  await runNativeMailWorker(provider.port, 'storage', address.port)
  expect(requests).toEqual([{ method: 'GET', path: '/archive/reports/logo.png', authorization: expect.stringContaining('AWS4-HMAC-SHA256') }])
  expect(provider.messages).toHaveLength(1)
  expect(provider.messages[0]).toContain('filename=invoice.txt')
  expect(provider.messages[0]).toContain('UmVhbCBwZXJzaXN0ZWQgYXR0YWNobWVudA==')
  expect(provider.messages[0]).toContain('Content-ID: <stored-logo>')
  expect(provider.messages[0]).toContain('AQIDBA==')
})

it('prints native delivery summaries and includes message bodies only for verbose mailers', async () => {
  const { stderr } = await runNativeMailWorker(2525, 'log')
  expect(stderr.match(/\[@holo-js\/mail\] Logged mail send/g)).toHaveLength(2)
  expect(stderr).toContain('Summary only')
  expect(stderr).toContain('hasText: true')
  expect(stderr).not.toContain('Hidden summary body')
  expect(stderr).toContain('Verbose delivery')
  expect(stderr).toContain('Visible verbose body')
})

it('honors fluent mailer and queue overrides and delivers only after the real delay expires', async () => {
  const provider = await startSmtpProvider()
  await runNativeMailWorker(provider.port, 'delayed')
  expect(provider.messages).toHaveLength(1)
  expect(provider.messages[0]).toContain('Subject: Delayed fluent delivery')
})

it('captures queued preview, fake-driver, and log deliveries only when the real worker executes them', async () => {
  const { stderr } = await runNativeMailWorker(2525, 'builtins')
  expect(stderr.match(/\[@holo-js\/mail\] Logged mail send/g)).toHaveLength(1)
  expect(stderr).toContain('Native log')
})

it('loads an app mail driver and delivers its queued receipt through the real worker', async () => {
  await runNativeMailWorker(2525, 'plugin')
})

it('keeps native builtin delivery usable while explicitly loading an invalid app driver fails', async () => {
  const { stderr } = await runNativeMailWorker(2525, 'broken-plugin')
  expect(stderr.match(/\[@holo-js\/mail\] Logged mail send/g)).toHaveLength(1)
  expect(stderr).toContain('Native builtin log')
})
