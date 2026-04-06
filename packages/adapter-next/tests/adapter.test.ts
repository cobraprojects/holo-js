import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeConfigCache } from '@holo-js/config'
import {
  adapterNextInternals,
  createNextHoloHelpers,
  createNextHoloProject,
  initializeNextHoloProject,
  resetNextHoloProject,
} from '../src'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const tempDirs: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-next-adapter-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await mkdir(join(root, 'server/db/migrations'), { recursive: true })
  await mkdir(join(root, 'server/db/seeders'), { recursive: true })
  await mkdir(join(root, 'server/commands'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Next App',
  env: 'development',
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${configEntry}

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`, 'utf8')
  await writeFile(join(root, 'config/services.ts'), `
import { defineConfig, env } from ${configEntry}

export default defineConfig({
  services: {
    secret: env('APP_SECRET', 'live-secret'),
  },
})
`, 'utf8')
  return root
}

afterEach(async () => {
  await resetNextHoloProject()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/adapter-next', () => {
  it('initializes a singleton project and exposes typed config helpers', async () => {
    const root = await createProject()
    const project = await initializeNextHoloProject<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'next-secret',
      },
    })

    expect(project.config.app.name).toBe('Next App')
    expect(project.runtime.initialized).toBe(true)
    expect(project.runtime.useConfig('services').services.secret).toBe('next-secret')

    const helpers = createNextHoloHelpers<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'next-secret',
      },
    })

    await expect(helpers.getApp()).resolves.toBe(project)
    await expect(helpers.getProject()).resolves.toBe(project)
    await expect(helpers.useConfig('services')).resolves.toEqual({
      services: {
        secret: 'next-secret',
      },
    })
    await expect(helpers.useConfig('services.services.secret')).resolves.toBe('next-secret')
    await expect(helpers.config('services.services.secret')).resolves.toBe('next-secret')
    expect(adapterNextInternals.getState().projectRoot).toBe(root)
  })

  it('allows direct project creation and prefers config cache in production by default', async () => {
    const root = await createProject()
    await writeConfigCache(root, {
      envName: 'production',
      processEnv: {
        ...process.env,
        NODE_ENV: 'production',
        APP_SECRET: 'cached-secret',
      },
    })
    await writeFile(join(root, 'config/services.ts'), `
import { defineConfig } from ${configEntry}

export default defineConfig({
  services: {
    secret: 'live-secret',
  },
})
`, 'utf8')

    const project = await createNextHoloProject<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        NODE_ENV: 'production',
        APP_SECRET: 'cached-secret',
      },
    })

    expect(project.config.custom.services).toEqual({
      services: {
        secret: 'cached-secret',
      },
    })
    await project.runtime.shutdown()
  })

  it('rejects conflicting singleton roots and resets cleanly', async () => {
    const root = await createProject()
    const otherRoot = await createProject()

    await initializeNextHoloProject({ projectRoot: root })
    await expect(initializeNextHoloProject({ projectRoot: otherRoot })).rejects.toThrow(`Next Holo project already initialized for "${root}".`)

    await resetNextHoloProject()

    expect(adapterNextInternals.getState().project).toBeUndefined()
  })

  it('resolves default options from process state when explicit values are omitted', () => {
    const cwd = process.cwd()
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    try {
      const resolved = adapterNextInternals.resolveOptions()
      expect(resolved.projectRoot).toBe(cwd)
      expect(resolved.runtime.preferCache).toBe(true)
      expect(resolved.runtime.processEnv).toBe(process.env)
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })
})
