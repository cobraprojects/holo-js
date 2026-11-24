import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { holoRuntimeInternals } from '@holo-js/core'
import { renderGeneratedSchemaPlaceholder } from '@holo-js/db'
import { normalizeHoloProjectConfig } from '@holo-js/kernel'
import { configureMailRuntime, listFakeSentMails, normalizeMailConfig, resetFakeSentMails, resetMailRuntime, sendMail } from '@holo-js/mail'
import { DEFAULT_MAIL_SOURCES } from '@holo-js/mail/templates'
import { createInternalCommands } from '../src/cli'
import type { IoStreams } from '../src/cli-types'
import { prepareProjectDiscovery } from '../src/project/discovery'
import { renderAuthEmailVerificationNotification, renderAuthPasswordResetNotification } from '../src/project/scaffold/project-renderers'

declare module '@holo-js/mail' {
  interface HoloMailTemplateRegistry {
    readonly receipt: { readonly url: string | number }
  }
}

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')
const authOverrideFiles = [
  'server/notifications/auth/email-verification.ts',
  'server/notifications/auth/password-reset.ts',
]
const mailFiles = [
  'server/mail/layout.html',
  'server/mail/layout.txt',
  'server/mail/components/button.html',
  'server/mail/components/button.txt',
  'server/mail/components/panel.html',
  'server/mail/components/panel.txt',
  'server/mail/components/table.html',
  'server/mail/components/table.txt',
  'server/mail/components/subcopy.html',
  'server/mail/components/subcopy.txt',
  'server/mail/themes/default.css',
  'server/mail/templates/notifications/email.md',
]
const authToken = { id: 'token-id', plainTextToken: 'secret', createdAt: new Date('2026-10-08T12:00:00Z'), expiresAt: new Date('2026-10-08T13:00:00Z') }

async function createProject(options: { readonly notifications: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-mail-publish-'))
  tempDirs.push(root)
  const packages = ['config', 'db', 'kernel', 'mail', ...(options.notifications ? ['notifications', 'queue'] : [])]
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'mail-publish-fixture',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(packages.map(name => [`@holo-js/${name}`, 'workspace:*'])),
  }, null, 2))
  await writeFile(join(root, 'config/app.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/database.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, '.holo-js/generated/schema.generated.ts'), renderGeneratedSchemaPlaceholder(), 'utf8')
  await Promise.all(packages.map(async (name) => {
    await symlink(join(workspaceRoot, 'packages', name), join(root, 'node_modules/@holo-js', name))
  }))
  return root
}

function createStreams(root: string): { readonly io: IoStreams, readonly stdout: () => string } {
  let stdout = ''
  const output = new PassThrough()
  output.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  return {
    io: { cwd: root, stdin: new PassThrough() as never, stdout: output as never, stderr: new PassThrough() as never },
    stdout: () => stdout,
  }
}

async function runMailPublish(root: string, flags: Record<string, boolean> = {}): Promise<string> {
  const { io, stdout } = createStreams(root)
  const context = {
    ...io,
    projectRoot: root,
    registry: [],
    loadProject: async () => {
      throw new Error('loadProject should not be called')
    },
  }
  const command = createInternalCommands(context).find(entry => entry.name === 'mail:publish')
  if (!command) throw new Error('Missing mail:publish command')
  const prepared = await command.prepare?.({ args: [], flags }, context)
  await command.run({ projectRoot: root, cwd: root, args: [], flags: prepared?.flags ?? {}, loadProject: context.loadProject })
  return stdout()
}

function expectedContent(path: string): string {
  if (path === authOverrideFiles[0]) return renderAuthEmailVerificationNotification()
  if (path === authOverrideFiles[1]) return renderAuthPasswordResetNotification()
  const relativePath = path.replace('server/mail/', '')
  if (relativePath === 'layout.html') return DEFAULT_MAIL_SOURCES.layouts.html
  if (relativePath === 'layout.txt') return DEFAULT_MAIL_SOURCES.layouts.text
  if (relativePath === 'themes/default.css') return DEFAULT_MAIL_SOURCES.themes.default ?? ''
  if (relativePath === 'templates/notifications/email.md') return DEFAULT_MAIL_SOURCES.templates['notifications/email'] ?? ''
  const [, name, format] = /^components\/(\w+)\.(html|txt)$/.exec(relativePath) ?? []
  const component = DEFAULT_MAIL_SOURCES.components[name ?? '']
  return (format === 'html' ? component?.html : component?.text) ?? ''
}

async function writeProjectFile(root: string, path: string, source: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), source, 'utf8')
}

async function renderProjectMails(root: string): Promise<ReadonlyArray<{ readonly html?: string, readonly text?: string }>> {
  const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())
  resetFakeSentMails()
  configureMailRuntime({
    config: normalizeMailConfig({ default: 'fake', from: { email: 'noreply@example.com' }, mailers: { fake: { driver: 'fake' } } }),
    app: { name: 'Holo App', url: 'https://app.test' },
    compiled: registry.mail,
  })
  await sendMail({ to: 'ava@example.com', subject: 'Receipt', markdown: 'receipt', data: { url: 'https://app.test/orders/1' } })
  const auth = holoRuntimeInternals.createAuthMailDeliveryHook({ sendMail }, { name: 'Holo App', url: 'https://app.test' }, root)
  await auth.sendEmailVerification({ provider: 'users', user: { name: 'Ava' }, email: 'ava@example.com', token: authToken, route: '/verify' })
  await auth.sendPasswordReset({ provider: 'users', broker: 'users', email: 'ava@example.com', token: authToken, route: '/reset' })
  return listFakeSentMails().map(({ mail }) => ({ html: mail.html, text: mail.text }))
}

afterEach(async () => {
  resetFakeSentMails()
  resetMailRuntime()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('holo mail:publish', () => {
  it('publishes every customisable mail file with the framework defaults and reports each one', async () => {
    const root = await createProject({ notifications: true })

    const output = await runMailPublish(root)

    for (const path of [...mailFiles, ...authOverrideFiles]) {
      expect(output).toContain(`  - published ${path}`)
      expect(await readFile(join(root, path), 'utf8')).toBe(expectedContent(path))
    }
  })

  it('skips existing files and reports them, and overwrites them with --force', async () => {
    const root = await createProject({ notifications: true })
    await runMailPublish(root)
    await writeProjectFile(root, 'server/mail/layout.txt', 'edited')
    await writeProjectFile(root, authOverrideFiles[0] ?? '', 'edited')

    const rerun = await runMailPublish(root)

    for (const path of [...mailFiles, ...authOverrideFiles]) {
      expect(rerun).toContain(`  - skipped existing ${path}`)
    }
    expect(rerun).not.toContain('  - published')
    expect(await readFile(join(root, 'server/mail/layout.txt'), 'utf8')).toBe('edited')
    expect(await readFile(join(root, authOverrideFiles[0] ?? ''), 'utf8')).toBe('edited')

    const forced = await runMailPublish(root, { force: true })

    for (const path of [...mailFiles, ...authOverrideFiles]) {
      expect(forced).toContain(`  - published ${path}`)
      expect(await readFile(join(root, path), 'utf8')).toBe(expectedContent(path))
    }
  })

  it('skips the auth override files when @holo-js/notifications is not installed', async () => {
    const root = await createProject({ notifications: false })

    const output = await runMailPublish(root, { force: true })

    for (const path of mailFiles) {
      expect(output).toContain(`  - published ${path}`)
    }
    for (const path of authOverrideFiles) {
      expect(output).toContain(`  - skipped ${path} (requires @holo-js/notifications)`)
      await expect(readFile(join(root, path), 'utf8')).rejects.toThrow()
    }
  })

  it('fails with an install hint when @holo-js/mail is not installed', async () => {
    const root = await createProject({ notifications: false })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'mail-publish-fixture', private: true, type: 'module' }))

    await expect(runMailPublish(root)).rejects.toThrow('Mail publishing requires @holo-js/mail. Install mail first with `holo install mail`.')
  })

  it('leaves mail, notification, and auth email output unchanged until a published file is edited', async () => {
    const root = await createProject({ notifications: true })
    await writeProjectFile(root, 'server/mail/templates/receipt.md', [
      '# Receipt',
      '',
      '<mail::panel>',
      'Thanks for your order.',
      '</mail::panel>',
      '',
      '<mail::table>',
      '| Item | Price |',
      '| :--- | ----: |',
      '| Book | $10 |',
      '</mail::table>',
      '',
      '<mail::button url="{{ url }}">View order</mail::button>',
      '',
      '<mail::subcopy>Questions? Reply to this email.</mail::subcopy>',
      '',
    ].join('\n'))
    const defaults = await renderProjectMails(root)
    expect(defaults).toHaveLength(3)

    await runMailPublish(root)

    expect(await renderProjectMails(root)).toEqual(defaults)

    await writeProjectFile(root, 'server/mail/components/panel.html', '<aside class="edited-panel">{!! slot !!}</aside>')
    const edited = await renderProjectMails(root)
    expect(edited[0]?.html).toMatch(/<aside class="edited-panel"[^>]*>/)
    expect(edited[0]?.html).not.toEqual(defaults[0]?.html)
  })
})
