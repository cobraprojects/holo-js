import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { renderGeneratedSchemaPlaceholder } from '@holo-js/db'
import { normalizeHoloProjectConfig } from '@holo-js/kernel'
import { prepareProjectDiscovery } from '../src/project/discovery'

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-mail-templates-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'mail-templates-fixture', private: true, type: 'module' }, null, 2))
  await writeFile(join(root, 'config/app.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/database.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, '.holo-js/generated/schema.generated.ts'), renderGeneratedSchemaPlaceholder(), 'utf8')
  await Promise.all(['config', 'db', 'kernel', 'mail'].map(async (name) => {
    await symlink(join(workspaceRoot, 'packages', name), join(root, 'node_modules/@holo-js', name))
  }))
  return root
}

async function writeTemplate(root: string, name: string, source: string): Promise<void> {
  const filePath = join(root, 'server/mail/templates', `${name}.md`)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, source, 'utf8')
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

  it('fails prepare on a Mail template syntax error', async () => {
    const root = await createProject()
    await writeTemplate(root, 'broken', 'Hello\n{{ name')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig()))
      .rejects.toThrow('Mail template "broken" line 2: "{{" is not closed with "}}".')
  })
})
