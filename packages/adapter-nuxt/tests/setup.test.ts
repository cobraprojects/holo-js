import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '../..')
const configEntry = JSON.stringify(resolve(packageDir, '../config/src/index.ts'))
const nitropackPackageDir = resolve(repoRoot, 'node_modules/.bun/node_modules/nitropack')
const tempDirs: string[] = []
const tempBuildRoots: string[] = []
let adapterBuildPromise: Promise<{ adapterOutDir: string }> | null = null
const dbRuntimeDependencyNames = ['better-sqlite3', 'mysql2', 'pg', 'ulid', 'uuid'] as const

type RuntimeConfigShape = Record<string, unknown>
type NuxtHarnessOptions = {
  rootDir?: string
  srcDir: string
  runtimeConfig?: RuntimeConfigShape & {
    holoStorage?: unknown
  }
  build: {
    transpile: string[]
  }
  nitro?: {
    storage?: Record<string, unknown>
  }
}

type NuxtHarness = {
  options: NuxtHarnessOptions
  hook: ReturnType<typeof vi.fn>
}

async function createTempBuildRoot(prefix: string): Promise<string> {
  const baseDir = resolve(repoRoot, '.vitest-builds')
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, `${prefix}-`))
  tempBuildRoots.push(root)
  return root
}

async function provisionTempPackage(sourcePackageDir: string, tempPackageDir: string): Promise<void> {
  await cp(sourcePackageDir, tempPackageDir, {
    recursive: true,
    filter(source) {
      return !source.includes('/dist/')
        && !source.endsWith('/dist')
        && !source.includes('/tests/')
        && !source.endsWith('/tests')
        && !source.includes('/node_modules/')
        && !source.endsWith('/node_modules')
    },
  })
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

async function stagePublishedPackage(sourceDir: string, targetDir: string, distDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, 'package.json'), await readFile(join(sourceDir, 'package.json'), 'utf8'))
  await cp(distDir, join(targetDir, 'dist'), { recursive: true })
}

async function runAdapterStub(): Promise<{ adapterOutDir: string }> {
  if (!adapterBuildPromise) {
    adapterBuildPromise = (async () => {
      const buildRoot = await createTempBuildRoot('adapter-nuxt')
      const dbPackageRoot = join(buildRoot, 'packages/db')
      const configPackageRoot = join(buildRoot, 'packages/config')
      const corePackageRoot = join(buildRoot, 'packages/core')
      const eventsPackageRoot = join(buildRoot, 'packages/events')
      const queuePackageRoot = join(buildRoot, 'packages/queue')
      const queueDbPackageRoot = join(buildRoot, 'packages/queue-db')
      const storagePackageRoot = join(buildRoot, 'packages/storage')
      const adapterPackageRoot = join(buildRoot, 'packages/adapter-nuxt')
      const tempRootNodeModules = join(buildRoot, 'node_modules')
      const tempRootTypes = join(tempRootNodeModules, '@types')
      const tempNodeModulesRoot = join(buildRoot, 'node_modules/@holo-js')

      await symlink(resolve(repoRoot, 'tsconfig.json'), join(buildRoot, 'tsconfig.json'))
      await mkdir(tempRootNodeModules, { recursive: true })
      await mkdir(tempRootTypes, { recursive: true })
      await symlink(resolve(repoRoot, 'node_modules/@types/node'), join(tempRootTypes, 'node'))
      await symlink(resolve(repoRoot, 'node_modules/@types/better-sqlite3'), join(tempRootTypes, 'better-sqlite3'))
      await symlink(resolve(packageDir, '../db/node_modules/@types/pg'), join(tempRootTypes, 'pg'))
      await symlink(resolve(packageDir, '../db/node_modules/tsup'), join(tempRootNodeModules, 'tsup'))
      await symlink(resolve(repoRoot, 'node_modules/typescript'), join(tempRootNodeModules, 'typescript'))
      await symlink(resolve(repoRoot, 'node_modules/.bun/node_modules/bullmq'), join(tempRootNodeModules, 'bullmq'))
      await symlink(resolve(packageDir, 'node_modules/@nuxt'), join(tempRootNodeModules, '@nuxt'))
      await symlink(nitropackPackageDir, join(tempRootNodeModules, 'nitropack'))
      for (const dependencyName of dbRuntimeDependencyNames) {
        await symlink(resolve(repoRoot, 'node_modules', dependencyName), join(tempRootNodeModules, dependencyName))
      }

      await provisionTempPackage(resolve(packageDir, '../db'), dbPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../config'), configPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../core'), corePackageRoot)
      await provisionTempPackage(resolve(packageDir, '../events'), eventsPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../queue'), queuePackageRoot)
      await provisionTempPackage(resolve(packageDir, '../queue-db'), queueDbPackageRoot)
      await provisionTempPackage(resolve(packageDir, '../storage'), storagePackageRoot)
      await provisionTempPackage(packageDir, adapterPackageRoot)

      await mkdir(join(corePackageRoot, 'node_modules'), { recursive: true })
      await symlink(resolve(packageDir, '../core/node_modules/esbuild'), join(corePackageRoot, 'node_modules', 'esbuild'))

      await mkdir(tempNodeModulesRoot, { recursive: true })
      await symlink(dbPackageRoot, join(tempNodeModulesRoot, 'db'))
      await symlink(configPackageRoot, join(tempNodeModulesRoot, 'config'))
      await symlink(corePackageRoot, join(tempNodeModulesRoot, 'core'))
      await symlink(eventsPackageRoot, join(tempNodeModulesRoot, 'events'))
      await symlink(queuePackageRoot, join(tempNodeModulesRoot, 'queue'))
      await symlink(queueDbPackageRoot, join(tempNodeModulesRoot, 'queue-db'))
      await symlink(storagePackageRoot, join(tempNodeModulesRoot, 'storage'))

      await runPackageBuild(resolve(packageDir, '../db/node_modules/.bin/tsup'), [], dbPackageRoot)
      await runPackageBuild(resolve(packageDir, '../queue/node_modules/.bin/tsup'), [], queuePackageRoot)
      await runPackageBuild(resolve(packageDir, '../queue/node_modules/.bin/tsup'), [], queueDbPackageRoot)
      await runPackageBuild(resolve(packageDir, '../config/node_modules/.bin/tsup'), [], configPackageRoot)
      await runPackageBuild(resolve(packageDir, '../storage/node_modules/.bin/tsup'), [], storagePackageRoot)
      await runPackageBuild(resolve(packageDir, '../events/node_modules/.bin/tsup'), [], eventsPackageRoot)
      await runPackageBuild(resolve(packageDir, '../core/node_modules/.bin/tsup'), [], corePackageRoot)
      await runPackageBuild(resolve(packageDir, 'node_modules/.bin/nuxt-module-build'), ['build'], adapterPackageRoot)

      return {
        adapterOutDir: join(adapterPackageRoot, 'dist'),
      }
    })()
  }

  return adapterBuildPromise
}

function createNuxtHarness(rootDir: string, runtimeConfig: RuntimeConfigShape = {}): NuxtHarness {
  return {
    options: {
      rootDir,
      srcDir: rootDir,
      runtimeConfig,
      build: {
        transpile: [] as string[],
      },
    },
    hook: vi.fn(),
  }
}

function runHook(
  nuxt: NuxtHarness,
  name: string,
): void {
  const callback = nuxt.hook.mock.calls.find(([hookName]) => hookName === name)?.[1]
  callback?.()
}

function getNitroStorage(nuxt: NuxtHarness): Record<string, unknown> | undefined {
  return nuxt.options.nitro?.storage
}

function getHoloStorageRuntimeConfig(nuxt: NuxtHarness): Record<string, unknown> | undefined {
  return nuxt.options.runtimeConfig?.holoStorage as Record<string, unknown> | undefined
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-storage-module-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  return root
}

async function loadAdapterModule() {
  vi.resetModules()

  const addImports = vi.fn()
  const addServerImportsDir = vi.fn()
  const addServerHandler = vi.fn()
  const addServerPlugin = vi.fn()

  vi.doMock('@nuxt/kit', () => ({
    defineNuxtModule: (definition: unknown) => definition,
    createResolver: () => ({
      resolve: (value: string) => value,
    }),
    addImports,
    addServerImportsDir,
    addServerHandler,
    addServerPlugin,
  }))

  const mod = await import('../src/module')

  return {
    module: mod.default,
    addImports,
    addServerImportsDir,
    addServerHandler,
    addServerPlugin,
  }
}

afterEach(async () => {
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
  it('emits the exported runtime entrypoints in stub builds', async () => {
    const build = await runAdapterStub()

    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/index.js'))).toBe(true)
    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/index.d.ts'))).toBe(true)
    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/storage.js'))).toBe(true)
    expect(existsSync(resolve(build.adapterOutDir, 'runtime/composables/storage.d.ts'))).toBe(true)
  }, 60000)

  it('publishes a runtime declaration that type-checks under NodeNext resolution', async () => {
    const build = await runAdapterStub()

    const tempDir = await mkdtemp(join(tmpdir(), 'holo-storage-types-'))
    const entryPath = join(tempDir, 'runtime-import.ts')

    try {
      await writeFile(
        entryPath,
        `import { Storage } from ${JSON.stringify(resolve(build.adapterOutDir, 'runtime/composables/storage.js'))}\nvoid Storage\n`,
      )

      expect(() => execFileSync(
        resolve(repoRoot, 'node_modules/.bin/tsc'),
        [
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
      await symlink(resolve(packageDir, '../validation/node_modules/valibot'), join(tempNodeModules, 'valibot'))

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

  it('publishes the init Nitro plugin with explicit Nitro runtime imports', async () => {
    const build = await runAdapterStub()

    const initPluginEntry = resolve(build.adapterOutDir, 'runtime/plugins/init.js')
    const publishedPlugin = await readFile(initPluginEntry, 'utf8')

    expect(publishedPlugin).toContain('from "nitropack/runtime/plugin"')
    expect(publishedPlugin).toContain('from "nitropack/runtime/config"')
  }, 60000)

  it('loads storage config files from the project root and wires nitro/runtime state', async () => {
    const root = await createProject()
    await writeFile(join(root, '.env'), 'STORAGE_DEFAULT_DISK=media\n', 'utf8')
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig, env } from ${configEntry}

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

    const { module, addImports, addServerImportsDir, addServerHandler, addServerPlugin } = await loadAdapterModule()
    const nuxt = createNuxtHarness(root)

    await module.setup({}, nuxt as never)
    runHook(nuxt, 'modules:done')

    expect(getNitroStorage(nuxt)).toEqual({
      'holo:local': {
        driver: 'fs',
        base: './storage/app',
      },
      'holo:public': {
        driver: 'fs',
        base: './storage/app/public',
      },
      'holo:assets': {
        driver: 'fs',
        base: './storage/assets',
      },
      'holo:media': {
        driver: './runtime/drivers/s3.js',
        bucket: 'media-bucket',
        region: 'us-east-1',
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'supersecretkey',
        sessionToken: 'session-token',
        forcePathStyleEndpoint: true,
      },
    })
    expect(getHoloStorageRuntimeConfig(nuxt)?.defaultDisk).toBe('media')
    expect(getHoloStorageRuntimeConfig(nuxt)?.routePrefix).toBe('/files')
    expect(nuxt.options.build.transpile).toContain('./runtime')
    expect(addImports).toHaveBeenCalledTimes(1)
    expect(addImports.mock.calls[0]?.[0]).toHaveLength(6)
    expect(addImports.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'holo', as: 'holo', from: './runtime/composables' }),
      expect.objectContaining({ name: 'useStorage', as: 'useStorage', from: './runtime/composables/storage' }),
      expect.objectContaining({ name: 'Storage', as: 'Storage', from: './runtime/composables/storage' }),
    ]))
    expect(addServerImportsDir).toHaveBeenCalledWith('./runtime/server/imports')
    expect(addServerImportsDir).toHaveBeenCalledTimes(1)
    expect(addServerHandler).toHaveBeenCalledWith({
      route: '/files/**',
      handler: './runtime/server/routes/storage.get',
    })
    expect(addServerPlugin).toHaveBeenCalledWith('./runtime/plugins/storage')
    expect(addServerPlugin).toHaveBeenCalledWith('./runtime/plugins/init')

    const prepareTypesHook = nuxt.hook.mock.calls.find(([name]) => name === 'prepare:types')?.[1]
    const references: Array<{ types: string }> = []
    prepareTypesHook?.({ references })
    expect(references).toEqual([{ types: '@holo-js/adapter-nuxt' }])
  }, 30000)

  it('falls back to default storage config when config/storage.ts is absent', async () => {
    const root = await createProject()
    const { module, addServerHandler } = await loadAdapterModule()
    const nuxt = createNuxtHarness(root)

    await module.setup({}, nuxt as never)
    runHook(nuxt, 'modules:done')

    expect(getNitroStorage(nuxt)).toEqual({
      'holo:local': {
        driver: 'fs',
        base: './storage/app',
      },
      'holo:public': {
        driver: 'fs',
        base: './storage/app/public',
      },
    })
    expect(getHoloStorageRuntimeConfig(nuxt)?.defaultDisk).toBe('local')
    expect(getHoloStorageRuntimeConfig(nuxt)?.routePrefix).toBe('/storage')
    expect(addServerHandler).toHaveBeenCalledWith({
      route: '/storage/**',
      handler: './runtime/server/routes/storage.get',
    })
  }, 30000)

  it('preserves existing holo nitro storage entries until finalize and skips the public handler when no public local disk exists', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${configEntry}

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

    const { module, addServerHandler } = await loadAdapterModule()
    const previousCwd = process.cwd()
    const nuxt = createNuxtHarness(root)
    delete (nuxt.options as { rootDir?: string }).rootDir
    delete (nuxt.options as { runtimeConfig?: Record<string, unknown> }).runtimeConfig
    ;(nuxt.options as { nitro?: { storage: Record<string, unknown> } }).nitro = {
      storage: {
        'holo:legacy': {
          driver: 'fs',
          base: './legacy',
        },
      },
    }

    try {
      process.chdir(root)
      await module.setup({}, nuxt as never)
    } finally {
      process.chdir(previousCwd)
    }

    expect(getNitroStorage(nuxt)).toEqual({
      'holo:legacy': {
        driver: 'fs',
        base: './legacy',
      },
    })

    delete (nuxt.options as { runtimeConfig?: Record<string, unknown> }).runtimeConfig
    runHook(nuxt, 'modules:done')

    expect(getHoloStorageRuntimeConfig(nuxt)?.defaultDisk).toBe('media')
    expect(getNitroStorage(nuxt)).toEqual({
      'holo:local': {
        driver: 'fs',
        base: './storage/app',
      },
      'holo:public': {
        driver: 'fs',
        base: './storage/app/public',
      },
      'holo:media': {
        driver: './runtime/drivers/s3.js',
        bucket: 'media-bucket',
        region: 'us-east-1',
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        accessKeyId: undefined,
        secretAccessKey: undefined,
        sessionToken: undefined,
        forcePathStyleEndpoint: false,
      },
    })
    expect(addServerHandler).toHaveBeenCalledWith({
      route: '/storage/**',
      handler: './runtime/server/routes/storage.get',
    })
  }, 30000)

  it('initializes nitro storage containers when nitro exists without a storage map', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${configEntry}

export default defineStorageConfig({
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
    const nuxt = createNuxtHarness(root)
    ;(nuxt.options as { nitro?: Record<string, unknown> }).nitro = {}
    delete (nuxt.options as { runtimeConfig?: Record<string, unknown> }).runtimeConfig

    await module.setup({}, nuxt as never)

    expect(getNitroStorage(nuxt)).toMatchObject({
      'holo:local': {
        driver: 'fs',
        base: './storage/app',
      },
      'holo:public': {
        driver: 'fs',
        base: './storage/app/public',
      },
      'holo:media': {
        driver: './runtime/drivers/s3.js',
      },
    })
  }, 30000)
})
