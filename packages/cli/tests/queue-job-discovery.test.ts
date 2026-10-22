import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configRegistryInternals, resetConfigNormalizers } from '@holo-js/config/registry'
import { normalizeHoloProjectConfig } from '@holo-js/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareProjectDiscovery } from '../src/project/discovery'

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-queue-discovery-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, 'server/jobs'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'queue-discovery-fixture', private: true }, null, 2))
  await writeFile(join(root, 'config/app.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/database.ts'), 'export default {}', 'utf8')
  await Promise.all([
    symlink(join(workspaceRoot, 'packages/config'), join(root, 'node_modules/@holo-js/config')),
    symlink(join(workspaceRoot, 'packages/db'), join(root, 'node_modules/@holo-js/db')),
    symlink(join(workspaceRoot, 'packages/queue'), join(root, 'node_modules/@holo-js/queue')),
  ])
  return root
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/cli queue job discovery', () => {
  it('discovers jobs when no queue config is registered and config/queue.ts is absent', async () => {
    const root = await createProject()
    await writeFile(join(root, 'server/jobs/send-email.ts'), `
import { defineJob } from '@holo-js/queue'

export const sendEmailJob = defineJob({
  async handle() {},
})
`, 'utf8')

    const restoreNormalizers = configRegistryInternals.snapshotNormalizers()
    resetConfigNormalizers()
    vi.resetModules()
    try {
      const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

      expect(registry.jobs).toEqual([
        expect.objectContaining({
          sourcePath: 'server/jobs/send-email.ts',
          name: 'send-email',
          exportName: 'sendEmailJob',
          connection: 'sync',
          queue: 'default',
        }),
      ])
    } finally {
      restoreNormalizers()
    }
  })
})
