import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { renderGeneratedSchemaPlaceholder } from '@holo-js/db'
import { configureMailRuntime, listFakeSentMails, normalizeMailConfig, resetFakeSentMails, resetMailRuntime, sendMail } from '@holo-js/mail'
import { runMakeMail } from '../src/generators'
import { loadGeneratedProjectRegistry } from '../src/project/registry'
import { importProjectModule } from '../src/project/runtime'

declare module '@holo-js/mail' {
  interface HoloMailTemplateRegistry {
    readonly 'order-shipped': { readonly name: string | number, readonly url: string | number }
  }
}

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')

async function createProject(options: { readonly mail?: boolean } = {}): Promise<string> {
  const mail = options.mail ?? true
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-make-mail-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'make-mail-fixture',
    private: true,
    type: 'module',
    dependencies: mail ? { '@holo-js/mail': 'workspace:*' } : {},
  }, null, 2))
  await writeFile(join(root, 'config/app.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/database.ts'), 'export default {}', 'utf8')
  if (mail) await writeFile(join(root, 'config/mail.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, '.holo-js/generated/schema.generated.ts'), renderGeneratedSchemaPlaceholder(), 'utf8')
  await Promise.all(['config', 'db', 'kernel', ...(mail ? ['mail'] : [])].map(async (name) => {
    await symlink(join(workspaceRoot, 'packages', name), join(root, 'node_modules/@holo-js', name))
  }))
  return root
}

function createIo(root: string) {
  let stdout = ''
  const output = new PassThrough()
  output.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  return {
    io: {
      cwd: root,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    },
    stdout: () => stdout,
  }
}

function typeErrors(root: string, fileName: string): string[] {
  const program = ts.createProgram([join(root, fileName), join(root, '.holo-js/generated/mail.d.ts')], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  })
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

afterEach(async () => {
  resetFakeSentMails()
  resetMailRuntime()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('holo make:mail', () => {
  it('creates a mail definition and its Mail template that type-check and render', async () => {
    const root = await createProject()
    const { io, stdout } = createIo(root)

    await runMakeMail(io, root, { args: ['OrderShippedMail'], flags: {} })

    expect(stdout()).toContain('Created mail: server/mail/order-shipped-mail.ts')
    expect(stdout()).toContain('Created mail template: server/mail/templates/order-shipped.md')

    await writeFile(join(root, 'check-mail.ts'), [
      'import OrderShippedMail from \'./server/mail/order-shipped-mail\'',
      '',
      'export const mail = OrderShippedMail({ to: \'ava@example.com\', name: \'Ava\', url: \'https://example.test/welcome\' })',
      '',
    ].join('\n'), 'utf8')
    expect(typeErrors(root, 'check-mail.ts')).toEqual([])

    configureMailRuntime({
      config: normalizeMailConfig({ default: 'fake', from: { email: 'noreply@example.com' }, mailers: { fake: { driver: 'fake' } } }),
      compiled: (await loadGeneratedProjectRegistry(root))?.mail,
    })
    const generated = await importProjectModule(root, join(root, 'server/mail/order-shipped-mail.ts')) as {
      readonly default: (input: { readonly to: string, readonly name: string, readonly url: string }) => Parameters<typeof sendMail>[0]
    }
    await sendMail(generated.default({ to: 'ava@example.com', name: 'Ava', url: 'https://example.test/welcome' }))
    const sent = listFakeSentMails()[0]?.mail
    expect(sent?.subject).toBe('Welcome, Ava')
    expect(sent?.html).toMatch(/<h1[^>]*>Welcome<\/h1>\s*<p[^>]*>Hello Ava,<\/p>\s*<p[^>]*>Your mail is ready\.<\/p>/)
    expect(sent?.html).toMatch(/<a href="https:\/\/example\.test\/welcome" class="button button-primary" target="_blank" rel="noopener" style="[^"]+">Get Started<\/a>/)
    expect(sent?.text).toContain('Welcome\n\nHello Ava,\n\nYour mail is ready.\n\nGet Started: https://example.test/welcome')
  })

  it('names the Mail template with --markdown and rejects unsafe template names', async () => {
    const root = await createProject()
    const { io, stdout } = createIo(root)

    await runMakeMail(io, root, { args: ['billing/Receipt'], flags: { markdown: 'orders/receipt' } })

    expect(stdout()).toContain('Created mail: server/mail/billing/receipt.ts')
    expect(stdout()).toContain('Created mail template: server/mail/templates/orders/receipt.md')
    expect(Object.keys((await loadGeneratedProjectRegistry(root))?.mail?.templates ?? {})).toEqual(['orders/receipt'])
    await expect(runMakeMail(io, root, { args: ['Escape'], flags: { markdown: '../escape' } }))
      .rejects.toThrow('Invalid Mail template name "../escape".')
    await expect(runMakeMail(io, root, { args: ['Dotted'], flags: { markdown: 'orders/shipped.v2' } }))
      .rejects.toThrow('Invalid Mail template name "orders/shipped.v2".')
  })

  it('fails with an install hint and writes nothing when @holo-js/mail is not installed', async () => {
    const root = await createProject({ mail: false })
    const { io } = createIo(root)

    await expect(runMakeMail(io, root, { args: ['OrderShippedMail'], flags: {} }))
      .rejects.toThrow('Mail generation requires @holo-js/mail. Install mail first with `holo install mail`.')
    await expect(readdir(join(root, 'server'))).rejects.toThrow()
  })
})
