import type { ModuleOptions } from '../src/module'
import type { TSReference, ViteConfig } from 'nuxt/schema'
import { buildNuxt } from '@nuxt/kit'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeNuxt, registeredServerPlugins } from './support/nuxt'
import {
  linkInstalledDependenciesForPackage,
  provisionTempPackage,
  symlinkPackageDependency,
  stagePublishedPackage,
} from '../../../tests/support/published-package'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '../..')
const configEntry = JSON.stringify(resolve(packageDir, '../config/src/index.ts'))
const storageEntry = JSON.stringify(resolve(packageDir, '../storage/src/index.ts'))
const nitropackPackageDir = resolve(repoRoot, 'node_modules/.bun/node_modules/nitropack')
const tempDirs: string[] = []
const nativeNuxtInstances: Awaited<ReturnType<typeof createNativeNuxt>>[] = []
const tempBuildRoots: string[] = []
let adapterBuildPromise: Promise<{ adapterOutDir: string }> | null = null

type RuntimeConfigShape = Record<string, unknown>
type NuxtHarness = Awaited<ReturnType<typeof createNativeNuxt>>

async function createTempBuildRoot(prefix: string): Promise<string> {
  const baseDir = resolve(repoRoot, '.vitest-builds')
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, `${prefix}-`))
  tempBuildRoots.push(root)
  return root
}

async function runPackageBuild(command: string, args: string[], targetPackageDir: string, outDir?: string): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  }

  if (outDir) {
    env.HOLO_BUILD_OUT_DIR = outDir
  }

  env.PATH = `${resolve(repoRoot, 'node_modules/.bin')}:${env.PATH ?? ''}`

  execFileSync(command, args, {
    cwd: targetPackageDir,
    env,
    stdio: 'pipe',
  })
}

async function runAdapterStub(): Promise<{ adapterOutDir: string }> {
  if (!adapterBuildPromise) {
    adapterBuildPromise = (async () => {
      const buildRoot = await createTempBuildRoot('adapter-nuxt')
      const dbPackageRoot = join(buildRoot, 'packages/db')
      const kernelPackageRoot = join(buildRoot, 'packages/kernel')
      const adapterSharedPackageRoot = join(buildRoot, 'packages/adapter-shared')
      const authPackageRoot = join(buildRoot, 'packages/auth')
      const cachePackageRoot = join(buildRoot, 'packages/cache')
      const configPackageRoot = join(buildRoot, 'packages/config')
      const corePackageRoot = join(buildRoot, 'packages/core')
      const mailPackageRoot = join(buildRoot, 'packages/mail')
      const mediaPackageRoot = join(buildRoot, 'packages/media')
      const notificationsPackageRoot = join(buildRoot, 'packages/notifications')
      const securityPackageRoot = join(buildRoot, 'packages/security')
      const sessionPackageRoot = join(buildRoot, 'packages/session')
      const validationPackageRoot = join(buildRoot, 'packages/validation')
      const broadcastPackageRoot = join(buildRoot, 'packages/broadcast')
      const eventsPackageRoot = join(buildRoot, 'packages/events')
      const queuePackageRoot = join(buildRoot, 'packages/queue')
      const queueDbPackageRoot = join(buildRoot, 'packages/queue-db')
      const storagePackageRoot = join(buildRoot, 'packages/storage')
      const adapterPackageRoot = join(buildRoot, 'packages/adapter-nuxt')
      const tempRootNodeModules = join(buildRoot, 'node_modules')
      const tempRootTypes = join(tempRootNodeModules, '@types')
      const tempNodeModulesRoot = join(buildRoot, 'node_modules/@holo-js')
      const optionalCorePackages = ['queue-redis', 'authorization', 'auth-social', 'auth-workos', 'auth-clerk']

      await symlink(resolve(repoRoot, 'tsconfig.json'), join(buildRoot, 'tsconfig.json'))
      await mkdir(tempRootNodeModules, { recursive: true })
      await mkdir(tempRootTypes, { recursive: true })
      await symlink(resolve(repoRoot, 'node_modules/@types/node'), join(tempRootTypes, 'node'))
      await symlink(resolve(repoRoot, 'node_modules/@types/better-sqlite3'), join(tempRootTypes, 'better-sqlite3'))
      await symlink(resolve(packageDir, '../db/node_modules/@types/pg'), join(tempRootTypes, 'pg'))
      await symlink(resolve(packageDir, '../db/node_modules/tsup'), join(tempRootNodeModules, 'tsup'))
      await symlink(resolve(repoRoot, 'node_modules/typescript'), join(tempRootNodeModules, 'typescript'))
      await symlink(resolve(packageDir, 'node_modules/@nuxt'), join(tempRootNodeModules, '@nuxt'))
      await symlink(resolve(packageDir, 'node_modules/h3'), join(tempRootNodeModules, 'h3'))
      await symlink(nitropackPackageDir, join(tempRootNodeModules, 'nitropack'))
      await linkInstalledDependenciesForPackage({
        repoRoot,
        nodeModulesRoot: tempRootNodeModules,
        packageJsonPath: resolve(packageDir, '../db/package.json'),
      })
      await linkInstalledDependenciesForPackage({
        repoRoot,
        nodeModulesRoot: tempRootNodeModules,
        packageJsonPath: resolve(packageDir, '../queue/package.json'),
        extraDependencyNames: ['bullmq'],
      })
      await linkInstalledDependenciesForPackage({
        repoRoot,
        nodeModulesRoot: tempRootNodeModules,
        packageJsonPath: resolve(packageDir, '../validation/package.json'),
      })
      await linkInstalledDependenciesForPackage({
        repoRoot,
        nodeModulesRoot: tempRootNodeModules,
        packageJsonPath: resolve(packageDir, '../broadcast/package.json'),
        extraDependencyNames: ['@types/ws'],
      })
      await linkInstalledDependenciesForPackage({
        repoRoot,
        nodeModulesRoot: tempRootNodeModules,
        packageJsonPath: resolve(packageDir, '../auth/package.json'),
        extraDependencyNames: ['next', 'nuxt', 'react', 'svelte'],
      })
      const featureBuildDependencies: Readonly<Record<string, readonly string[]>> = {
        cache: [],
        mail: ['nodemailer'],
        media: [],
        notifications: [],
        security: ['h3', 'ioredis', 'next'],
        session: ['ioredis'],
      }
      for (const [packageName, extraDependencyNames] of Object.entries(featureBuildDependencies)) {
        await linkInstalledDependenciesForPackage({
          repoRoot,
          nodeModulesRoot: tempRootNodeModules,
          packageJsonPath: resolve(packageDir, `../${packageName}/package.json`),
          extraDependencyNames,
        })
      }

      await provisionTempPackage(resolve(packageDir, '../db'), dbPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../kernel'), kernelPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../adapter-shared'), adapterSharedPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../auth'), authPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../cache'), cachePackageRoot)
      await provisionTempPackage(resolve(packageDir, '../config'), configPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../core'), corePackageRoot)
      await provisionTempPackage(resolve(packageDir, '../mail'), mailPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../media'), mediaPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../notifications'), notificationsPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../security'), securityPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../session'), sessionPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../validation'), validationPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../broadcast'), broadcastPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../events'), eventsPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../queue'), queuePackageRoot)
      await provisionTempPackage(resolve(packageDir, '../queue-db'), queueDbPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../storage'), storagePackageRoot)
      await provisionTempPackage(packageDir, adapterPackageRoot)

      await mkdir(tempNodeModulesRoot, { recursive: true })
      for (const packageName of optionalCorePackages) {
        const source = resolve(packageDir, `../${packageName}`)
        const target = join(buildRoot, 'packages', packageName)
        await linkInstalledDependenciesForPackage({
          repoRoot,
          nodeModulesRoot: tempRootNodeModules,
          packageJsonPath: join(source, 'package.json'),
        })
        await provisionTempPackage(source, target)
        await symlinkPackageDependency(tempRootNodeModules, `@holo-js/${packageName}`, target)
      }
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/db', dbPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/kernel', kernelPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/adapter-shared', adapterSharedPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/auth', authPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/cache', cachePackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/config', configPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/core', corePackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/mail', mailPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/media', mediaPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/notifications', notificationsPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/security', securityPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/session', sessionPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/validation', validationPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/broadcast', broadcastPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/events', eventsPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/queue', queuePackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/queue-db', queueDbPackageRoot)
      await symlinkPackageDependency(tempRootNodeModules, '@holo-js/storage', storagePackageRoot)

      await runPackageBuild(resolve(packageDir, '../kernel/node_modules/.bin/tsup'), [], kernelPackageRoot)
      await runPackageBuild(resolve(packageDir, '../config/node_modules/.bin/tsup'), [], configPackageRoot)
      await runPackageBuild(resolve(packageDir, '../adapter-shared/node_modules/.bin/tsup'), [], adapterSharedPackageRoot)
      await runPackageBuild(resolve(packageDir, '../db/node_modules/.bin/tsup'), [], dbPackageRoot)
      await runPackageBuild(resolve(packageDir, '../queue/node_modules/.bin/tsup'), [], queuePackageRoot)
      await runPackageBuild(resolve(packageDir, '../queue/node_modules/.bin/tsup'), [], queueDbPackageRoot)
      await runPackageBuild(resolve(packageDir, '../validation/node_modules/.bin/tsup'), [], validationPackageRoot)
      await runPackageBuild(resolve(packageDir, '../storage/node_modules/.bin/tsup'), [], storagePackageRoot)
      await runPackageBuild(resolve(packageDir, '../auth/node_modules/.bin/tsup'), [], authPackageRoot)
      await runPackageBuild(resolve(packageDir, '../cache/node_modules/.bin/tsup'), [], cachePackageRoot)
      await runPackageBuild(resolve(packageDir, '../mail/node_modules/.bin/tsup'), [], mailPackageRoot)
      await runPackageBuild(resolve(packageDir, '../media/node_modules/.bin/tsup'), [], mediaPackageRoot)
      await runPackageBuild(resolve(packageDir, '../notifications/node_modules/.bin/tsup'), [], notificationsPackageRoot)
      await runPackageBuild(resolve(packageDir, '../security/node_modules/.bin/tsup'), [], securityPackageRoot)
      await runPackageBuild(resolve(packageDir, '../session/node_modules/.bin/tsup'), [], sessionPackageRoot)
      await runPackageBuild(resolve(packageDir, '../broadcast/node_modules/.bin/tsup'), [], broadcastPackageRoot)
      await runPackageBuild(resolve(packageDir, '../events/node_modules/.bin/tsup'), [], eventsPackageRoot)
      for (const packageName of optionalCorePackages) {
        await runPackageBuild(resolve(packageDir, `../${packageName}/node_modules/.bin/tsup`), [], join(buildRoot, 'packages', packageName))
      }
      await runPackageBuild(resolve(packageDir, '../core/node_modules/.bin/tsup'), [], corePackageRoot)
      await runPackageBuild(resolve(packageDir, 'node_modules/.bin/nuxt-module-build'), ['build'], adapterPackageRoot)

      return {
        adapterOutDir: join(adapterPackageRoot, 'dist'),
      }
    })()
  }

  return adapterBuildPromise
}

async function createNuxtHarness(rootDir: string, runtimeConfig: RuntimeConfigShape = {}): Promise<NuxtHarness> {
  const nuxt = await createNativeNuxt(rootDir, runtimeConfig)
  nativeNuxtInstances.push(nuxt)
  return nuxt
}

function getNitroStorage(nuxt: NuxtHarness): Record<string, unknown> | undefined {
  return nuxt.options.nitro?.storage
}

function getOptimizeDepsInclude(nuxt: NuxtHarness): readonly string[] {
  return nuxt.options.vite?.optimizeDeps?.include ?? []
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-storage-module-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  return root
}

async function linkHoloPackage(root: string, name: string): Promise<void> {
  const scopedPackageDir = join(root, 'node_modules/@holo-js')
  await mkdir(scopedPackageDir, { recursive: true })
  await symlink(resolve(packageDir, `../${name}`), join(scopedPackageDir, name))
}

async function loadAdapterModule() {
  vi.resetModules()
  const mod = await import('../src/module')
  return {
    module: {
      setup: async (options: ModuleOptions, nuxt: NuxtHarness) => await nuxt.runWithContext(() => mod.default(options, nuxt)),
    },
    moduleInternals: mod.moduleInternals,
  }
}

afterEach(async () => {
  await Promise.all(nativeNuxtInstances.splice(0).map(nuxt => nuxt.close()))
  vi.doUnmock('@nuxt/kit')
  delete process.env.STORAGE_DEFAULT_DISK
  delete process.env.STORAGE_ROUTE_PREFIX

  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

afterAll(async () => {
  for (const dir of tempBuildRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/adapter-nuxt module setup', () => {
  beforeAll(async () => {
    await runAdapterStub()
  }, 300_000)

  it('registers isolated panel styles when the Panels plugin is active', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/app.ts'), `export default { plugins: ['@holo-js/panels'] }\n`)
    vi.resetModules()
    vi.doUnmock('@nuxt/kit')
    const { default: module } = await import('../src/module')
    const nuxt = await createNativeNuxt(root)
    nativeNuxtInstances.push(nuxt)

    await nuxt.runWithContext(() => module({}, nuxt))
    await nuxt.runWithContext(() => module({}, nuxt))

    expect(nuxt.options.css).toEqual(['@holo-js/panels-vue/style.css'])
  })

  it('emits the exported runtime entrypoints in stub builds', async () => {
    const build = await runAdapterStub()

    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/index.js'))).toBe(true)
    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/index.d.ts'))).toBe(true)
    expect(await readFile(resolve(build.adapterOutDir, 'runtime/composables/index.d.ts'), 'utf8')).toContain(
      'export declare function runWithNuxtRequest<TValue>(event: NuxtAuthRequestEvent, callback: () => TValue): Promise<Awaited<TValue>>',
    )
    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/storage.js'))).toBe(true)
    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/storage.d.ts'))).toBe(true)
    expect(existsSync(resolve(build.adapterOutDir, 'runtime/server/routes/broadcast-auth.post.js'))).toBe(true)
  }, 120000)

  it('publishes a runtime declaration that type-checks under NodeNext resolution', async () => {
    const build = await runAdapterStub()

    const tempDir = await mkdtemp(join(tmpdir(), 'holo-runtime-types-'))
    const entryPath = join(tempDir, 'runtime-import.mts')

    try {
      await symlinkPackageDependency(join(tempDir, 'node_modules'), '@holo-js/adapter-nuxt', dirname(build.adapterOutDir))
      await writeFile(
        entryPath,
        `import { configureNuxtRuntime, type NuxtRuntime } from '@holo-js/adapter-nuxt/runtime'
import { Storage } from '@holo-js/adapter-nuxt/storage'
type Equal<TLeft, TRight> = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2) ? true : false
const bindings: NuxtRuntime = {
  useEvent: () => undefined,
  createAuthorizationError: decision => {
    const preciseStatus: Equal<typeof decision.status, 200 | 403 | 404> = true
    const preciseMessage: Equal<typeof decision.message, string | undefined> = true
    void preciseStatus
    void preciseMessage
    return new Error(decision.message)
  },
}
const preciseBindings: Equal<Parameters<typeof configureNuxtRuntime>[0], NuxtRuntime> = true
configureNuxtRuntime(bindings)
void preciseBindings
void Storage
`,
      )

      expect(() => execFileSync(
        resolve(repoRoot, 'node_modules/.bin/tsc'),
        [
          '--ignoreConfig',
          '--strict',
          'true',
          '--skipLibCheck',
          '--types',
          'node',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--target',
          'es2022',
          '--noEmit',
          entryPath,
        ],
        {
          cwd: repoRoot,
          stdio: 'pipe',
        },
      )).not.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 60000)

  it('publishes a client declaration that type-checks under NodeNext resolution', async () => {
    const build = await runAdapterStub()
    const tempDir = await mkdtemp(join(tmpdir(), 'holo-storage-client-types-'))
    const tempNodeModules = join(tempDir, 'node_modules')
    const tempHoloNodeModules = join(tempNodeModules, '@holo-js')
    const buildRoot = await createTempBuildRoot('adapter-nuxt-client')
    const entryPath = join(tempDir, 'client-import.ts')

    try {
      await mkdir(tempHoloNodeModules, { recursive: true })
      await linkInstalledDependenciesForPackage({
        repoRoot,
        nodeModulesRoot: tempNodeModules,
        packageJsonPath: resolve(packageDir, '../validation/package.json'),
      })

      await runPackageBuild(resolve(packageDir, '../validation/node_modules/.bin/tsup'), [], resolve(packageDir, '../validation'), join(buildRoot, 'validation'))
      await runPackageBuild(resolve(packageDir, '../forms/node_modules/.bin/tsup'), [], resolve(packageDir, '../forms'), join(buildRoot, 'forms'))

      await Promise.all([
        stagePublishedPackage(resolve(packageDir, '../validation'), join(tempHoloNodeModules, 'validation'), join(buildRoot, 'validation')),
        stagePublishedPackage(resolve(packageDir, '../forms'), join(tempHoloNodeModules, 'forms'), join(buildRoot, 'forms')),
        stagePublishedPackage(packageDir, join(tempHoloNodeModules, 'adapter-nuxt'), build.adapterOutDir),
      ])

      await writeFile(
        entryPath,
        `import { useForm } from '@holo-js/adapter-nuxt/client'\nvoid useForm\n`,
      )

      expect(() => execFileSync(
        resolve(repoRoot, 'node_modules/.bin/tsc'),
        [
          '--ignoreConfig',
          '--strict',
          'false',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--target',
          'es2022',
          '--noEmit',
          entryPath,
        ],
        {
          cwd: tempDir,
          stdio: 'pipe',
        },
      )).not.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 60000)

  it('imports the published runtime entry in plain Node without requiring Nuxt aliases', async () => {
    const build = await runAdapterStub()

    const runtimeEntry = resolve(build.adapterOutDir, 'runtime/composables/index.js')
    const storageEntry = resolve(build.adapterOutDir, 'runtime/composables/storage.js')
    const output = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `const runtime = await import(${JSON.stringify(runtimeEntry)});`
        + `const storage = await import(${JSON.stringify(storageEntry)});`
        + `console.log(typeof runtime.holo);`
        + `console.log(typeof storage.Storage.disk);`
        + `try { storage.Storage.path('example.txt') } catch (error) { console.log(error instanceof Error ? error.message : String(error)) }`,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    )

    expect(output).toContain('function')
    expect(output).toContain('Storage runtime is not configured')
  }, 60000)

  it.each(['nitro', 'h3'] as const)('serves external public-runtime consumers with isolated cookies and native authorization errors in %s', async host => {
    const build = await runAdapterStub()
    const root = resolve(build.adapterOutDir, `../../nuxt-production-app-${host}`)
    await symlinkPackageDependency(join(root, 'node_modules'), '@holo-js/adapter-nuxt', dirname(build.adapterOutDir))
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'config/app.mjs'), `export default {
      key: 'nuxt-production-runtime-test-key-1234567890',
      paths: { generatedSchema: '.holo-js/generated/schema.generated.ts' },
    }`)
    await writeFile(join(root, 'config/auth.mjs'), 'export default {}')
    await mkdir(join(root, 'server/models'), { recursive: true })
    await writeFile(join(root, 'server/models/User.mjs'), `import { defineModel } from '@holo-js/db'
      export default defineModel('users')
    `)
    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await writeFile(join(root, '.holo-js/generated/schema.generated.ts'), `
      import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'
      const users = defineGeneratedTable('users', { id: column.id(), email: column.string(), password: column.string() })
      registerGeneratedTables({ users })
    `)
    await writeFile(join(root, 'config/database.mjs'), `export default {
      defaultConnection: 'main',
      connections: { main: { driver: 'sqlite', url: ':memory:' } },
    }`)
    await mkdir(join(root, 'server/api'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'nuxt.config.ts'), `export default {
      ssr: false,
      devtools: { enabled: false },
      nitro: { preset: 'node-listener', externals: { external: ['nuxt-runtime-consumer'] } },
    }`)
    const consumerRoot = join(root, 'node_modules/nuxt-runtime-consumer')
    await mkdir(consumerRoot, { recursive: true })
    await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ name: 'nuxt-runtime-consumer', type: 'module', exports: './index.mjs' }))
    await writeFile(join(consumerRoot, 'index.mjs'), `
      import { createNuxtAuthRequestAccessors, holo, runWithNuxtRequest } from '@holo-js/adapter-nuxt/runtime'
      import { defineAbility, deny, denyAsNotFound, forUser } from '@holo-js/authorization'
      export const handleRequest = event => runWithNuxtRequest(event, async () => {
        await holo.getAuth()
        const request = createNuxtAuthRequestAccessors()
        const identity = await request.getCookie('identity')
        if (identity === 'denied' || identity === 'hidden') {
          const name = 'nuxt.' + identity
          defineAbility(name, () => identity === 'hidden' ? denyAsNotFound('Hidden') : deny('Denied'))
          await forUser({ id: 'user' }).ability(name).authorize({})
        }
        await request.appendResponseCookie('observed=' + identity + '; Path=/')
        return { identity }
      })
    `)
    await writeFile(join(root, 'server/api/request.ts'), `
      import { handleRequest } from 'nuxt-runtime-consumer'
      export default defineEventHandler(handleRequest)
    `)
    if (host === 'nitro') {
      const nuxt = await createNativeNuxt(root)
      nativeNuxtInstances.push(nuxt)
      nuxt.options.modules.push('@holo-js/adapter-nuxt')
      await nuxt.ready()
      await buildNuxt(nuxt)
      await nuxt.close()
      nativeNuxtInstances.splice(nativeNuxtInstances.indexOf(nuxt), 1)
    }

    const listenerSetup = host === 'nitro'
      ? `import { listener } from ${JSON.stringify(join(root, '.output/server/index.mjs'))}`
      : `
        import { AsyncLocalStorage } from 'node:async_hooks'
        import { createApp, createError, defineEventHandler, toNodeListener } from 'h3'
        import { configureHoloRuntimeConfig, configureNuxtRuntime } from '@holo-js/adapter-nuxt/runtime'
        import { handleRequest } from 'nuxt-runtime-consumer'
        const events = new AsyncLocalStorage()
        configureNuxtRuntime({
          useEvent: () => events.getStore(),
          createAuthorizationError: decision => createError({ statusCode: decision.status, statusMessage: decision.message }),
        })
        configureHoloRuntimeConfig({ holo: { projectRoot: process.cwd() } })
        const app = createApp()
        app.use(defineEventHandler(event => events.run(event, () => handleRequest(event))))
        const listener = toNodeListener(app)
      `

    const output = execFileSync('node', ['--input-type=module', '--eval', `
      import { createServer } from 'node:http'
      ${listenerSetup}
      const server = createServer(listener)
      await new Promise(done => server.listen(0, '127.0.0.1', done))
      try {
        const results = await Promise.all(['first', 'second', 'denied', 'hidden'].map(async identity => {
          const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/request', {
            headers: { cookie: 'identity=' + identity },
          })
          return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() }
        }))
        console.log(JSON.stringify(results))
      } finally {
        server.closeAllConnections()
        await new Promise(done => server.close(done))
      }
    `], { cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'inherit'] })
    expect(JSON.parse(output.trim().split('\n').at(-1) ?? '')).toMatchObject([
      { status: 200, cookie: 'observed=first; Path=/', body: { identity: 'first' } },
      { status: 200, cookie: 'observed=second; Path=/', body: { identity: 'second' } },
      { status: 403, cookie: null, body: { statusCode: 403, statusMessage: 'Denied' } },
      { status: 404, cookie: null, body: { statusCode: 404, statusMessage: 'Hidden' } },
    ])
  }, 120_000)

  it('redirects a supplied request event from the published runtime in plain Node', async () => {
    const build = await runAdapterStub()
    const runtimeEntry = resolve(build.adapterOutDir, 'runtime/composables/index.js')
    const output = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `const { createServer } = await import('node:http');`
        + `const runtime = await import(${JSON.stringify(runtimeEntry)});`
        + `const server = createServer(async (req, res) => {`
        + `  try { await runtime.createNuxtAuthRequestAccessors({ node: { req, res } }).redirectResponse('/signed-in', 303) }`
        + `  catch (error) { res.statusCode = 500; res.end(String(error)) }`
        + `});`
        + `await new Promise(done => server.listen(0, done));`
        + `const response = await fetch('http://127.0.0.1:' + server.address().port + '/login', { redirect: 'manual' });`
        + `console.log(JSON.stringify({ status: response.status, location: response.headers.get('location'), body: await response.text() }));`
        + `server.close();`,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    )

    expect(JSON.parse(output)).toMatchObject({ status: 303, location: '/signed-in' })
  }, 60000)

  it('publishes Nitro runtime files that use the application Nitro and h3 through #imports', async () => {
    const build = await runAdapterStub()
    const runtimeFiles = (await readdir(resolve(build.adapterOutDir, 'runtime'), { recursive: true }))
      .filter(path => path.endsWith('.js'))
    const sources = await Promise.all(runtimeFiles.map(path => readFile(resolve(build.adapterOutDir, 'runtime', path), 'utf8')))

    expect(await readFile(resolve(build.adapterOutDir, 'runtime/plugins/init.js'), 'utf8')).toContain('from "#imports"')
    for (const source of sources) {
      expect(source).not.toMatch(/(?:from|import\()\s*["'](?:h3|nitropack)(?:\/[^"']*)?["']/)
    }
  }, 60000)

  it.each([
    { packages: [], expected: [] },
    { packages: ['validation'], expected: ['@holo-js/validation > valibot', '@holo-js/validation > @holo-js/kernel > file-type'] },
    { packages: ['forms', 'validation'], expected: [
      '@holo-js/forms > @holo-js/validation > valibot',
      '@holo-js/forms > @holo-js/validation > @holo-js/kernel > file-type',
      '@holo-js/validation > valibot',
      '@holo-js/validation > @holo-js/kernel > file-type',
    ] },
  ])('configures native Vite dependencies for installed packages $packages', async ({ packages, expected }) => {
    const root = await createProject()
    for (const name of packages) await linkHoloPackage(root, name)
    const nuxt = await createNuxtHarness(root)
    const { module } = await loadAdapterModule()

    await module.setup({}, nuxt)

    expect(getOptimizeDepsInclude(nuxt)).toEqual(expected)
  })

  it('merges Holo client optimizer dependencies without replacing user Vite options', async () => {
    const root = await createProject()
    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await writeFile(join(root, '.holo-js/generated/model-registry.d.ts'), 'export {}\n', 'utf8')
    await linkHoloPackage(root, 'forms')
    await linkHoloPackage(root, 'validation')

    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)
    nuxt.options.vite = {
      optimizeDeps: {
        include: [
          'vue',
          '@holo-js/validation > valibot',
        ],
        exclude: ['vue-demi'],
      },
    }

    await module.setup({}, nuxt)

    expect(getOptimizeDepsInclude(nuxt)).toEqual([
      'vue',
      '@holo-js/validation > valibot',
      '@holo-js/forms > @holo-js/validation > valibot',
      '@holo-js/forms > @holo-js/validation > @holo-js/kernel > file-type',
      '@holo-js/validation > @holo-js/kernel > file-type',
    ])
    expect(nuxt.options.vite.optimizeDeps?.exclude).toEqual(['vue-demi'])
  }, 30000)

  it('loads storage config files from the project root and wires nitro/runtime state', async () => {
    const root = await createProject()
    await writeFile(join(root, '.env'), 'STORAGE_DEFAULT_DISK=media\n', 'utf8')
    await writeFile(join(root, 'config/storage.ts'), `
import { env } from ${configEntry}
import { defineStorageConfig } from ${storageEntry}

export default defineStorageConfig({
  defaultDisk: env('STORAGE_DEFAULT_DISK', 'public'),
  routePrefix: '/files',
  disks: {
    assets: {
      driver: 'public',
      visibility: 'public',
      root: './storage/assets',
    },
    media: {
      driver: 's3',
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      sessionToken: 'session-token',
      forcePathStyleEndpoint: true,
    },
  },
})
`, 'utf8')

    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)
    await nuxt.callHook('modules:done')

    expect(getNitroStorage(nuxt)).toBeUndefined()
    expect(nuxt.options.build.transpile).toContain(resolve(packageDir, 'src/runtime'))
    expect(nuxt.options.serverHandlers).toContainEqual(expect.objectContaining({ route: '/files/**', handler: resolve(packageDir, 'src/runtime/server/routes/storage') }))
    expect(registeredServerPlugins(nuxt)).not.toContain(resolve(packageDir, 'src/runtime/plugins/storage'))
    expect(registeredServerPlugins(nuxt)).toContain(resolve(packageDir, 'src/runtime/plugins/init'))
    expect(registeredServerPlugins(nuxt)).toContain(resolve(packageDir, 'src/runtime/plugins/forms'))

    const references: TSReference[] = []
    await nuxt.callHook('prepare:types', { references, declarations: [], nodeReferences: [], sharedReferences: [], serverReferences: [], tsConfig: {}, nodeTsConfig: {}, sharedTsConfig: {}, serverTsConfig: {} })
    expect(references).toEqual([
      { types: '@holo-js/adapter-nuxt' },
      { path: join(root, '.holo-js/generated/auth.d.ts') },
      { path: join(root, '.holo-js/generated/authorization/types.d.ts') },
      { path: join(root, '.holo-js/generated/model-registry.d.ts') },
    ])
  }, 30000)

  it('falls back to default storage config when config/storage.ts is absent', async () => {
    const root = await createProject()
    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)
    await nuxt.callHook('modules:done')

    expect(getNitroStorage(nuxt)).toBeUndefined()
    expect(nuxt.options.serverHandlers).toContainEqual(expect.objectContaining({ route: '/storage/**', handler: resolve(packageDir, 'src/runtime/server/routes/storage') }))
  }, 30000)

  it('registers the internal broadcast routes when broadcast is installed', async () => {
    const root = await createProject()
    await linkHoloPackage(root, 'broadcast')
    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)

    expect(nuxt.options.serverHandlers).toContainEqual(expect.objectContaining({ route: '/broadcasting/config', handler: resolve(packageDir, 'src/runtime/server/routes/broadcast-config.get') }))
    expect(nuxt.options.serverHandlers).toContainEqual(expect.objectContaining({ route: '/broadcasting/auth', handler: resolve(packageDir, 'src/runtime/server/routes/broadcast-auth.post') }))
  }, 30000)

  it('registers realtime client transforms once and extends only client Vite configs', async () => {
    const root = await createProject()
    await linkHoloPackage(root, 'realtime')
    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)
    expect(nuxt.options.vite?.plugins).toHaveLength(1)
    expect(nuxt.options.plugins).toContainEqual(expect.objectContaining({ src: resolve(packageDir, 'src/runtime/plugins/realtime.ts'), mode: 'all' }))

    const serverConfig: ViteConfig = {}
    await nuxt.callHook('vite:extendConfig', serverConfig, { isServer: true, isClient: false })
    expect(serverConfig.plugins).toBeUndefined()
    const clientConfig: ViteConfig = {}
    await nuxt.callHook('vite:extendConfig', clientConfig, { isServer: false, isClient: true })
    expect(clientConfig.plugins).toHaveLength(1)

    await module.setup({}, nuxt)
    expect(nuxt.options.plugins.filter(plugin => typeof plugin !== 'string' && plugin.src === resolve(packageDir, 'src/runtime/plugins/realtime.ts'))).toHaveLength(1)
  }, 30000)

  it('leaves application Nitro storage mounts untouched', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${storageEntry}

export default defineStorageConfig({
  defaultDisk: 'media',
  disks: {
    media: {
      driver: 's3',
      bucket: 'media-bucket',
      region: 'us-east-1',
    },
  },
})
`, 'utf8')

    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)
    ;(nuxt.options as { nitro?: { storage: Record<string, unknown> } }).nitro = {
      storage: {
        'holo:legacy': {
          driver: 'fs',
          base: './legacy',
        },
      },
    }

    await module.setup({}, nuxt)

    expect(getNitroStorage(nuxt)).toEqual({
      'holo:legacy': {
        driver: 'fs',
        base: './legacy',
      },
    })

    await nuxt.callHook('modules:done')

    expect(getNitroStorage(nuxt)).toEqual({
      'holo:legacy': {
        driver: 'fs',
        base: './legacy',
      },
    })
    expect(nuxt.options.serverHandlers).toContainEqual(expect.objectContaining({ route: '/storage/**', handler: resolve(packageDir, 'src/runtime/server/routes/storage') }))
  }, 30000)
})
