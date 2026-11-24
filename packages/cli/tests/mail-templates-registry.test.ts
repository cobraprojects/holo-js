import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { renderGeneratedSchemaPlaceholder } from '@holo-js/db'
import { normalizeHoloProjectConfig } from '@holo-js/kernel'
import { discoverAppCommands, prepareProjectDiscovery } from '../src/project/discovery'

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')

async function createProject(packages: readonly string[] = ['config', 'db', 'kernel', 'mail']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-mail-templates-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'mail-templates-fixture', private: true, type: 'module' }, null, 2))
  await writeFile(join(root, 'config/app.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/database.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, '.holo-js/generated/schema.generated.ts'), renderGeneratedSchemaPlaceholder(), 'utf8')
  await Promise.all(packages.map(async (name) => {
    await symlink(join(workspaceRoot, 'packages', name), join(root, 'node_modules/@holo-js', name))
  }))
  return root
}

async function writeMailFile(root: string, path: string, source: string): Promise<void> {
  const filePath = join(root, 'server/mail', path)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, source, 'utf8')
}

async function writeTemplate(root: string, name: string, source: string): Promise<void> {
  await writeMailFile(root, `templates/${name}.md`, source)
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
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/cli Mail template discovery', () => {
  it('compiles Mail templates into the generated registry and types their data', async () => {
    const root = await createProject()
    await writeTemplate(root, 'orders/shipped', '# Order {{ order.id }}\n\nThanks, {!! customer.name !!}.')
    await writeTemplate(root, 'welcome', '# Welcome')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    expect(Object.keys(registry.mail?.templates ?? {})).toEqual(['orders/shipped', 'welcome'])
    const persisted = JSON.parse(await readFile(join(root, '.holo-js/generated/registry.json'), 'utf8')) as typeof registry
    expect(persisted.mail).toEqual(registry.mail)
    expect(await readFile(join(root, '.holo-js/generated/index.ts'), 'utf8')).toContain('/// <reference path="./mail.d.ts" />')

    await writeFile(join(root, 'check-mail.ts'), `
import { defineMail } from '@holo-js/mail'

export const shipped = defineMail({
  to: 'ava@example.com',
  subject: 'Shipped',
  markdown: 'orders/shipped',
  data: { order: { id: 42 }, customer: { name: 'Ava' } },
})
export const welcome = defineMail({ to: 'ava@example.com', subject: 'Welcome', markdown: 'welcome' })
`, 'utf8')
    expect(typeErrors(root, 'check-mail.ts')).toEqual([])

    await writeFile(join(root, 'check-mail-errors.ts'), `
import { defineMail } from '@holo-js/mail'

export const unknown = defineMail({ to: 'ava@example.com', subject: 'Typo', markdown: 'orders/shiped' })
export const missing = defineMail({ to: 'ava@example.com', subject: 'Shipped', markdown: 'orders/shipped', data: { order: { id: 42 } } })
export const date = defineMail({ to: 'ava@example.com', subject: 'Shipped', markdown: 'orders/shipped', data: { order: { id: new Date() }, customer: { name: 'Ava' } } })
`, 'utf8')
    expect(typeErrors(root, 'check-mail-errors.ts')).toHaveLength(3)
  })

  it('compiles the app Mail layouts and Mail themes into the generated registry and types theme names', async () => {
    const root = await createProject()
    await writeMailFile(root, 'layout.html', '<main>{!! body !!}</main>')
    await writeMailFile(root, 'layout.txt', '{{ app.name }}\n\n{!! body !!}')
    await writeMailFile(root, 'themes/default.css', 'h1 { color: red; }')
    await writeMailFile(root, 'themes/receipt.css', 'h1 { color: blue; }')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    expect(Object.keys(registry.mail?.layouts ?? {})).toEqual(['html', 'text'])
    expect(registry.mail?.themes).toEqual({ default: 'h1 { color: red; }', receipt: 'h1 { color: blue; }' })

    await writeFile(join(root, 'check-theme.ts'), `
import { defineMailConfig } from '@holo-js/mail'

export const config = defineMailConfig({ markdown: { theme: 'receipt' } })
export const typo = defineMailConfig({ markdown: { theme: 'reciept' } })
`, 'utf8')
    expect(typeErrors(root, 'check-theme.ts')).toHaveLength(1)
  })

  it('fails prepare on a Mail layout syntax error', async () => {
    const root = await createProject()
    await writeMailFile(root, 'layout.html', '<main>\n{!! body </main>')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig()))
      .rejects.toThrow('Mail template "layout.html" line 2: "{!!" is not closed with "!!}".')
  })

  it('types @if paths as optional, @foreach paths as lists of the item shape, and merges included templates', async () => {
    const root = await createProject()
    await writeTemplate(root, 'orders/receipt', [
      '# Receipt {{ order.id }}',
      '@if (order.coupon)',
      'Coupon applied',
      '@endif',
      '@if (customer.vip)',
      'Thanks for being a VIP',
      '@endif',
      '@foreach (order.lines as line)',
      '- {{ line.name }} x {{ line.quantity }}',
      '@if (line.gift)',
      '  (gift)',
      '@endif',
      '@endforeach',
      '@foreach (order.tags as tag)',
      '- {{ tag }}',
      '@endforeach',
      '@foreach (order.notes as note)',
      'Note',
      '@endforeach',
      '@include (partials/footer)',
    ].join('\n'))
    await writeTemplate(root, 'partials/footer', 'Questions? Contact {{ support.email }}.')
    await writeTemplate(root, 'reminder', '@if (name)\nHi\n@endif')

    await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    await writeFile(join(root, 'check-mail.ts'), `
import { defineMail } from '@holo-js/mail'

export const receipt = defineMail({
  to: 'ava@example.com',
  subject: 'Receipt',
  markdown: 'orders/receipt',
  data: {
    order: {
      id: 42,
      coupon: { code: 'SAVE' },
      lines: [{ name: 'Mug', quantity: 2 }, { name: 'Tea', quantity: 1, gift: true }],
      tags: ['gift'],
      notes: [{ any: ['json'] }],
    },
    support: { email: 'help@example.com' },
  },
})
export const reminder = defineMail({ to: 'ava@example.com', subject: 'Reminder', markdown: 'reminder' })
`, 'utf8')
    expect(typeErrors(root, 'check-mail.ts')).toEqual([])

    await writeFile(join(root, 'check-mail-errors.ts'), `
import { defineMail } from '@holo-js/mail'

const order = { id: 42, lines: [], tags: [], notes: [] }
export const missingInclude = defineMail({ to: 'a@example.com', subject: 'R', markdown: 'orders/receipt', data: { order } })
export const notList = defineMail({ to: 'a@example.com', subject: 'R', markdown: 'orders/receipt', data: { order: { ...order, tags: 'gift' }, support: { email: 'e' } } })
export const badItem = defineMail({ to: 'a@example.com', subject: 'R', markdown: 'orders/receipt', data: { order: { ...order, lines: [{ name: 'Mug' }] }, support: { email: 'e' } } })
export const date = defineMail({ to: 'a@example.com', subject: 'R', markdown: 'orders/receipt', data: { order: { ...order, coupon: new Date() }, support: { email: 'e' } } })
`, 'utf8')
    expect(typeErrors(root, 'check-mail-errors.ts')).toHaveLength(4)
  })

  it('types the loop item paths of a template included inside @foreach as the item shape', async () => {
    const root = await createProject()
    await writeTemplate(root, 'orders/shipped', '# Order {{ order.id }}\n\n@foreach (order.lines as line)\n@include (partials/line)\n@endforeach')
    await writeTemplate(root, 'partials/line', '- {{ line.name }} x {{ line.quantity }} for {{ customer.name }}')

    await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    await writeFile(join(root, 'check-mail.ts'), `
import { defineMail } from '@holo-js/mail'

export const shipped = defineMail({
  to: 'ava@example.com',
  subject: 'Shipped',
  markdown: 'orders/shipped',
  data: { order: { id: 42, lines: [{ name: 'Mug', quantity: 2 }] }, customer: { name: 'Ava' } },
})
`, 'utf8')
    expect(typeErrors(root, 'check-mail.ts')).toEqual([])

    await writeFile(join(root, 'check-mail-errors.ts'), `
import { defineMail } from '@holo-js/mail'

export const badItem = defineMail({ to: 'a@example.com', subject: 'S', markdown: 'orders/shipped', data: { order: { id: 1, lines: [{ name: 'Mug' }] }, customer: { name: 'Ava' } } })
export const missingRoot = defineMail({ to: 'a@example.com', subject: 'S', markdown: 'orders/shipped', data: { order: { id: 1, lines: [] } } })
`, 'utf8')
    expect(typeErrors(root, 'check-mail-errors.ts')).toHaveLength(2)
  })

  it('re-prepares before running commands when a Mail file changed since the last prepare', async () => {
    const root = await createProject()
    const config = normalizeHoloProjectConfig()
    await writeTemplate(root, 'welcome', '# Welcome')
    await prepareProjectDiscovery(root, config)
    const readMail = async () => {
      return (JSON.parse(await readFile(join(root, '.holo-js/generated/registry.json'), 'utf8')) as Awaited<ReturnType<typeof prepareProjectDiscovery>>).mail
    }

    await writeTemplate(root, 'welcome', '# Welcome back')
    await discoverAppCommands(root, config)
    expect(JSON.stringify((await readMail())?.templates.welcome)).toContain('# Welcome back')

    await writeMailFile(root, 'layout.html', '<main>{!! body !!}</main>')
    await writeMailFile(root, 'themes/receipt.css', 'h1 { color: blue; }')
    await writeMailFile(root, 'components/alert.html', '<div>{!! slot !!}</div>')
    await discoverAppCommands(root, config)
    const updated = await readMail()
    expect(Object.keys(updated?.layouts ?? {})).toEqual(['html'])
    expect(Object.keys(updated?.themes ?? {})).toEqual(['receipt'])
    expect(Object.keys(updated?.components ?? {})).toContain('alert')

    await rm(join(root, 'server/mail/themes/receipt.css'))
    await discoverAppCommands(root, config)
    expect((await readMail())?.themes).toEqual({})
  })

  it('types notification mail templates and data from the generated registry', async () => {
    const root = await createProject(['config', 'db', 'kernel', 'mail', 'notifications'])
    await writeTemplate(root, 'invoices/paid', '# Invoice {{ invoice.id }} paid')

    await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    await writeFile(join(root, 'check-notification.ts'), `
import type { NotificationMailMessage } from '@holo-js/notifications'

export const paid = { subject: 'Paid', markdown: 'invoices/paid', data: { invoice: { id: 7 } } } satisfies NotificationMailMessage
export const lines = { subject: 'Paid', lines: ['Paid.'] } satisfies NotificationMailMessage
`, 'utf8')
    expect(typeErrors(root, 'check-notification.ts')).toEqual([])

    await writeFile(join(root, 'check-notification-errors.ts'), `
import type { NotificationMailMessage } from '@holo-js/notifications'

export const typo = { subject: 'Paid', markdown: 'invoices/payed', data: { invoice: { id: 7 } } } satisfies NotificationMailMessage
export const badData = { subject: 'Paid', markdown: 'invoices/paid', data: { invoice: { id: true } } } satisfies NotificationMailMessage
`, 'utf8')
    expect(typeErrors(root, 'check-notification-errors.ts')).toHaveLength(2)
  })

  it('types notification mail messages without Mail templates when @holo-js/mail is not installed', async () => {
    const root = await createProject(['config', 'db', 'kernel'])
    const notificationsRoot = join(root, 'node_modules/@holo-js/notifications')
    await mkdir(notificationsRoot, { recursive: true })
    await cp(join(workspaceRoot, 'packages/notifications/dist'), join(notificationsRoot, 'dist'), { recursive: true })
    await cp(join(workspaceRoot, 'packages/notifications/package.json'), join(notificationsRoot, 'package.json'))

    await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    await writeFile(join(root, 'check-notification.ts'), `
import type { NotificationMailMessage } from '@holo-js/notifications'

export const lines = { subject: 'Hi', greeting: 'Hello', lines: ['Line.'], action: { label: 'Open', url: 'https://example.com' } } satisfies NotificationMailMessage
export const template = { subject: 'Hi', markdown: 'welcome', data: {} } satisfies NotificationMailMessage
export const level = { subject: 'Hi', level: 'warning' } satisfies NotificationMailMessage
`, 'utf8')
    expect(typeErrors(root, 'check-notification.ts')).toEqual([
      'Type \'string\' is not assignable to type \'undefined\'.',
      'Type \'{}\' is not assignable to type \'undefined\'.',
      'Type \'"warning"\' is not assignable to type \'"info" | "success" | "error" | undefined\'.',
    ])
  })

  it('fails prepare on an include cycle', async () => {
    const root = await createProject()
    await writeTemplate(root, 'orders/shipped', '# Shipped\n\n@include (partials/summary)')
    await writeTemplate(root, 'partials/summary', 'Summary\n@include (partials/lines)')
    await writeTemplate(root, 'partials/lines', 'Lines\n\n@include (partials/summary)')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig()))
      .rejects.toThrow('"@include (partials/summary)" creates an include cycle: partials/summary -> partials/lines -> partials/summary.')
  })

  it('fails prepare on a Mail template syntax error', async () => {
    const root = await createProject()
    await writeTemplate(root, 'broken', 'Hello\n{{ name')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig()))
      .rejects.toThrow('Mail template "broken" line 2: "{{" is not closed with "}}".')
  })

  it('compiles app Mail components into the generated registry and accepts their tags', async () => {
    const root = await createProject()
    await writeMailFile(root, 'components/alert.html', '<div class="alert">{!! slot !!}</div>')
    await writeMailFile(root, 'components/button.txt', '{!! slot !!} -> {!! url !!}')
    await writeTemplate(root, 'welcome', '<mail::alert>Hi</mail::alert>')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    expect(Object.keys(registry.mail?.components ?? {}).sort()).toEqual(['alert', 'button', 'panel', 'subcopy', 'table'])
    expect(registry.mail?.components.button?.text).toEqual([
      { type: 'output', path: ['slot'], escaped: false },
      { type: 'text', value: ' -> ' },
      { type: 'output', path: ['url'], escaped: false },
    ])
  })

  it('fails prepare on a cycle between app Mail components', async () => {
    const root = await createProject()
    await writeMailFile(root, 'components/alert.html', '<mail::box>{!! slot !!}</mail::box>')
    await writeMailFile(root, 'components/box.html', '<mail::alert>{!! slot !!}</mail::alert>')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig()))
      .rejects.toThrow('Mail component "alert" creates a component cycle: alert -> box -> alert.')
  })

  it('fails prepare on an unknown Mail component tag', async () => {
    const root = await createProject()
    await writeTemplate(root, 'welcome', '# Welcome\n\n<mail::buton url="https://example.test">Open</mail::buton>')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig()))
      .rejects.toThrow('Mail template "welcome" line 3: <mail::buton> is not a Mail component.')
  })
})
