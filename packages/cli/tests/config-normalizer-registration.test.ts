import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configRegistryInternals, resetConfigNormalizers } from '@holo-js/config/registry'
import { normalizeHoloProjectConfig } from '@holo-js/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectInternals } from '../src/project'
import { prepareProjectDiscovery } from '../src/project/discovery'
import { CONFIG_NORMALIZER_PACKAGES } from '../src/project/load-config'
import { initializeQueueMaintenanceEnvironment } from '../src/queue'

const tempDirs: string[] = []

type PackageManifest = {
  readonly name: string
  readonly exports?: Readonly<Record<string, string | { readonly import?: string }>>
}

function readPackageManifest(path: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  } catch {
    return undefined
  }
}
const workspaceRoot = resolve(import.meta.dirname, '../../..')

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-config-normalizers-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, 'server/jobs'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'config-normalizers-fixture', private: true }, null, 2))
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

describe('@holo-js/cli config normalizer registration', () => {
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

  it('initializes queue maintenance when no queue config is registered and config/queue.ts is absent', async () => {
    const root = await createProject()

    const restoreNormalizers = configRegistryInternals.snapshotNormalizers()
    resetConfigNormalizers()
    vi.resetModules()
    try {
      const environment = await initializeQueueMaintenanceEnvironment(root)

      await expect(environment.cleanup()).resolves.toBeUndefined()
    } finally {
      restoreNormalizers()
    }
  })

  it('keeps queue maintenance working after an unreadable queue config was inspected in the same process', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/queue.ts'), 'throw new Error("unreadable queue config")\n', 'utf8')

    const restoreNormalizers = configRegistryInternals.snapshotNormalizers()
    resetConfigNormalizers()
    vi.resetModules()
    try {
      await projectInternals.installQueueIntoProject(root)
      await writeFile(join(root, 'config/queue.ts'), 'export default {}\n', 'utf8')

      const environment = await initializeQueueMaintenanceEnvironment(root)

      await expect(environment.cleanup()).resolves.toBeUndefined()
    } finally {
      restoreNormalizers()
    }
  })

  it('lists exactly the workspace packages whose built config module registers a normalizer', async () => {
    const packagesRoot = join(workspaceRoot, 'packages')
    const registering: string[] = []
    for (const directory of readdirSync(packagesRoot)) {
      const manifest = readPackageManifest(join(packagesRoot, directory, 'package.json'))
      const configExport = manifest?.exports?.['./config']
      const configModule = typeof configExport === 'string' ? configExport : configExport?.import
      if (!manifest || !configModule) continue

      const restoreNormalizers = configRegistryInternals.snapshotNormalizers()
      resetConfigNormalizers()
      vi.resetModules()
      try {
        await import(join(packagesRoot, directory, configModule))

        if (configRegistryInternals.getRegisteredNames().length > 0) registering.push(manifest.name)
      } finally {
        restoreNormalizers()
      }
    }

    expect(registering.sort()).toEqual([...CONFIG_NORMALIZER_PACKAGES].sort())
  })
})
