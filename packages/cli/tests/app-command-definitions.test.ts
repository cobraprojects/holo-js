import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defineCommand } from '../src'
import { defaultProjectConfig, discoverAppCommands } from '../src/project'

const temporaryDirectories: string[] = []

afterEach(async () => {
  delete (globalThis as { __holoExpectedDefineCommand__?: unknown }).__holoExpectedDefineCommand__
  await Promise.all(temporaryDirectories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('gives commands loaded with discovered jobs the CLI module instance the process uses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-app-command-definitions-'))
  temporaryDirectories.push(root)
  const write = async (name: string, content: string) => {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), content)
  }
  await write('package.json', JSON.stringify({ type: 'module' }))
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../..'), join(root, 'node_modules/@holo-js'), 'dir')
  await write('config/app.ts', "import { defineAppConfig } from '@holo-js/config'\nexport default defineAppConfig({ name: 'Definitions' })")
  await write('server/jobs/plain.ts', "import { defineJob } from '@holo-js/queue'\nexport default defineJob({ async handle() {} })")
  await write('server/support/label.ts', "export const label = 'shared'")
  await write('server/commands/instance.ts', "import { defineCommand } from '@holo-js/cli'\nimport { label } from '../support/label'\nexport default defineCommand({ description: defineCommand === globalThis.__holoExpectedDefineCommand__ ? label : 'separate', async run() {} })")
  ;(globalThis as { __holoExpectedDefineCommand__?: unknown }).__holoExpectedDefineCommand__ = defineCommand

  const [discovered] = await discoverAppCommands(root, defaultProjectConfig())
  const command = await discovered!.load()

  expect(command.description).toBe('shared')
}, 30_000)
