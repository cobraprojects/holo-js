import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { writeConfigCache } from '@holo-js/config'
import type * as AdapterModule from '../src'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const repoRoot = resolve(import.meta.dirname, '../../..')
const tempDirs: string[] = []
const tempBuildRoots: string[] = []
const dbRuntimeDependencyNames = ['better-sqlite3', 'mysql2', 'pg', 'ulid', 'uuid'] as const
let coreBuildPromise: Promise<{ coreEntryUrl: string }> | null = null
let adapterModulePromise: Promise<typeof AdapterModule> | null = null

async function writePackageWrapper(sourcePackageDir: string, targetPackageDir: string): Promise<void> {
  await mkdir(targetPackageDir, { recursive: true })
  await writeFile(
    join(targetPackageDir, 'package.json'),
    await readFile(join(sourcePackageDir, 'package.json'), 'utf8'),
    'utf8',
  )
}

async function linkPackageDependency(
  targetPackageDir: string,
  packageName: string,
  dependencyRoot: string,
): Promise<void> {
  const dependencyPath = join(targetPackageDir, 'node_modules', ...packageName.split('/'))
  await rm(dependencyPath, { recursive: true, force: true })
  await mkdir(dirname(dependencyPath), { recursive: true })
  await symlink(dependencyRoot, dependencyPath)
}

async function linkExternalDependency(
  targetPackageDir: string,
  dependencyName: string,
): Promise<void> {
  await linkPackageDependency(
    targetPackageDir,
    dependencyName,
    join(repoRoot, 'node_modules', ...dependencyName.split('/')),
  )
}

function buildWorkspacePackage(filter: string, outDir: string): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOLO_BUILD_OUT_DIR: outDir,
  }

  delete env.NODE_V8_COVERAGE

  execFileSync('bun', ['run', '--filter', filter, 'build'], {
    cwd: repoRoot,
    env,
    stdio: 'pipe',
  })
}

async function ensureIsolatedCoreBuild(): Promise<{ coreEntryUrl: string }> {
  if (!coreBuildPromise) {
    coreBuildPromise = (async () => {
      const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-build-'))
      tempBuildRoots.push(root)
      const dbPackageRoot = join(root, 'packages/db')
      const configPackageRoot = join(root, 'packages/config')
      const eventsPackageRoot = join(root, 'packages/events')
      const queuePackageRoot = join(root, 'packages/queue')
      const queueDbPackageRoot = join(root, 'packages/queue-db')
      const storagePackageRoot = join(root, 'packages/storage')
      const corePackageRoot = join(root, 'packages/core')

      await writePackageWrapper(resolve(repoRoot, 'packages/db'), dbPackageRoot)
      for (const dependencyName of dbRuntimeDependencyNames) {
        await linkExternalDependency(dbPackageRoot, dependencyName)
      }
      buildWorkspacePackage('@holo-js/db', join(dbPackageRoot, 'dist'))

      await writePackageWrapper(resolve(repoRoot, 'packages/queue'), queuePackageRoot)
      await linkExternalDependency(queuePackageRoot, 'bullmq')
      buildWorkspacePackage('@holo-js/queue', join(queuePackageRoot, 'dist'))

      await writePackageWrapper(resolve(repoRoot, 'packages/queue-db'), queueDbPackageRoot)
      await linkPackageDependency(queueDbPackageRoot, '@holo-js/db', dbPackageRoot)
      await linkPackageDependency(queueDbPackageRoot, '@holo-js/queue', queuePackageRoot)
      buildWorkspacePackage('@holo-js/queue-db', join(queueDbPackageRoot, 'dist'))

      await writePackageWrapper(resolve(repoRoot, 'packages/config'), configPackageRoot)
      await linkPackageDependency(configPackageRoot, '@holo-js/db', dbPackageRoot)
      await linkPackageDependency(configPackageRoot, '@holo-js/queue', queuePackageRoot)
      buildWorkspacePackage('@holo-js/config', join(configPackageRoot, 'dist'))

      await writePackageWrapper(resolve(repoRoot, 'packages/storage'), storagePackageRoot)
      buildWorkspacePackage('@holo-js/storage', join(storagePackageRoot, 'dist'))

      await writePackageWrapper(resolve(repoRoot, 'packages/events'), eventsPackageRoot)
      await linkPackageDependency(eventsPackageRoot, '@holo-js/db', dbPackageRoot)
      await linkPackageDependency(eventsPackageRoot, '@holo-js/queue', queuePackageRoot)
      buildWorkspacePackage('@holo-js/events', join(eventsPackageRoot, 'dist'))

      await writePackageWrapper(resolve(repoRoot, 'packages/core'), corePackageRoot)
      await linkPackageDependency(corePackageRoot, '@holo-js/config', configPackageRoot)
      await linkPackageDependency(corePackageRoot, '@holo-js/db', dbPackageRoot)
      await linkPackageDependency(corePackageRoot, '@holo-js/events', eventsPackageRoot)
      await linkPackageDependency(corePackageRoot, '@holo-js/queue', queuePackageRoot)
      await linkPackageDependency(corePackageRoot, '@holo-js/queue-db', queueDbPackageRoot)
      await linkPackageDependency(corePackageRoot, '@holo-js/storage', storagePackageRoot)
      await linkPackageDependency(corePackageRoot, 'esbuild', resolve(repoRoot, 'packages/core/node_modules/esbuild'))
      buildWorkspacePackage('@holo-js/core', join(corePackageRoot, 'dist'))

      return {
        coreEntryUrl: pathToFileURL(join(corePackageRoot, 'dist/index.mjs')).href,
      }
    })()
  }

  return coreBuildPromise
}

async function loadAdapterModule() {
  if (!adapterModulePromise) {
    const { coreEntryUrl } = await ensureIsolatedCoreBuild()
    vi.doMock('@holo-js/core', () => import(coreEntryUrl))
    adapterModulePromise = import('../src')
  }

  return adapterModulePromise
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-adapter-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await mkdir(join(root, 'server/db/migrations'), { recursive: true })
  await mkdir(join(root, 'server/db/seeders'), { recursive: true })
  await mkdir(join(root, 'server/commands'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'SvelteKit App',
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
  const { resetSvelteKitHoloProject } = await loadAdapterModule()
  await resetSvelteKitHoloProject()
  adapterModulePromise = null
  vi.doUnmock('@holo-js/core')
  vi.resetModules()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}, 45000)

afterAll(async () => {
  await Promise.all(tempBuildRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('@holo-js/adapter-sveltekit', () => {
  it('initializes a singleton project and exposes typed config helpers', async () => {
    const {
      adapterSvelteKitInternals,
      createSvelteKitHoloHelpers,
      initializeSvelteKitHoloProject,
    } = await loadAdapterModule()
    const root = await createProject()
    const project = await initializeSvelteKitHoloProject<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'svelte-secret',
      },
    })

    expect(project.config.app.name).toBe('SvelteKit App')
    expect(project.runtime.initialized).toBe(true)
    expect(project.runtime.useConfig('services').services.secret).toBe('svelte-secret')

    const helpers = createSvelteKitHoloHelpers<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'svelte-secret',
      },
    })

    await expect(helpers.getApp()).resolves.toBe(project)
    await expect(helpers.getProject()).resolves.toBe(project)
    await expect(helpers.useConfig('services')).resolves.toEqual({
      services: {
        secret: 'svelte-secret',
      },
    })
    await expect(helpers.useConfig('services.services.secret')).resolves.toBe('svelte-secret')
    await expect(helpers.config('services.services.secret')).resolves.toBe('svelte-secret')
    expect(adapterSvelteKitInternals.getState().projectRoot).toBe(root)
  }, 45000)

  it('allows direct project creation and prefers config cache in production by default', async () => {
    const { createSvelteKitHoloProject } = await loadAdapterModule()
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

    const project = await createSvelteKitHoloProject<{ services: { services: { secret: string } } }>({
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
  }, 45000)

  it('rejects conflicting singleton roots and resets cleanly', async () => {
    const {
      adapterSvelteKitInternals,
      initializeSvelteKitHoloProject,
      resetSvelteKitHoloProject,
    } = await loadAdapterModule()
    const root = await createProject()
    const otherRoot = await createProject()

    await initializeSvelteKitHoloProject({ projectRoot: root })
    await expect(initializeSvelteKitHoloProject({ projectRoot: otherRoot })).rejects.toThrow(`SvelteKit Holo project already initialized for "${root}".`)

    await resetSvelteKitHoloProject()

    expect(adapterSvelteKitInternals.getState().project).toBeUndefined()
  }, 45000)

  it('resolves default options from process state when explicit values are omitted', () => {
    const load = loadAdapterModule()
    const cwd = process.cwd()
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    return load.then(({ adapterSvelteKitInternals }) => {
      const resolved = adapterSvelteKitInternals.resolveOptions()
      expect(resolved.projectRoot).toBe(cwd)
      expect(resolved.runtime.preferCache).toBe(true)
      expect(resolved.runtime.processEnv).toBe(process.env)
    }).finally(() => {
      process.env.NODE_ENV = previousNodeEnv
    })
  }, 45000)
})
