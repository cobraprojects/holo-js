import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type * as Project from '../src/project'

const calls = vi.hoisted(() => ({ pluginsChanged: false, order: [] as string[] }))

vi.mock('../src/project/plugin-prepare/coordinator', () => ({
  runPluginProjectPreparers: async () => {
    calls.order.push('plugins')
    return calls.pluginsChanged
  },
}))

vi.mock('../src/project', async (importOriginal) => {
  const original = await importOriginal<typeof Project>()
  return {
    ...original,
    prepareProjectDiscovery: async (...args: Parameters<typeof original.prepareProjectDiscovery>) => {
      calls.order.push('discovery')
      return await original.prepareProjectDiscovery(...args)
    },
    syncManagedDriverDependencies: async () => false,
  }
})

const { runProjectPrepare } = await import('../src/project-prepare')

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-prepare-plugin-discovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config/app.mjs'), 'export default {}')
  await writeFile(join(root, 'config/database.mjs'), 'export default {}')
  return root
}

it('discovers again after plugins change managed artifacts', async () => {
  const root = await createProject()
  calls.pluginsChanged = true
  calls.order.length = 0
  await runProjectPrepare(root, undefined, { command: 'dev', syncFramework: false })
  expect(calls.order).toEqual(['discovery', 'plugins', 'discovery'])
}, 60_000)

it('does not discover again when plugins leave managed artifacts unchanged', async () => {
  const root = await createProject()
  calls.pluginsChanged = false
  calls.order.length = 0
  await runProjectPrepare(root, undefined, { command: 'dev', syncFramework: false })
  expect(calls.order).toEqual(['discovery', 'plugins'])
}, 60_000)
