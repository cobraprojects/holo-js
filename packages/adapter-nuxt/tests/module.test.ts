import type { ModuleOptions } from '../src/module'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { loadNuxt } from '@nuxt/kit'
import { createApp, defineEventHandler } from 'h3'
import { serve } from './support/http'
import { createNativeNuxt } from './support/nuxt'
import { writeConfigCache } from '@holo-js/config'
import type * as HoloCoreModule from '@holo-js/core'

type RuntimeConfigShape = Record<string, unknown>
const packageEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const databaseEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/index.ts'))
const storageEntry = JSON.stringify(resolve(import.meta.dirname, '../../storage/src/index.ts'))
const tempDirs: string[] = []

const nativeNuxtInstances: Awaited<ReturnType<typeof loadNuxt>>[] = []

async function createNuxtHarness(rootDir: string, runtimeConfig: RuntimeConfigShape = {}) {
  const nuxt = await createNativeNuxt(rootDir, runtimeConfig)
  nativeNuxtInstances.push(nuxt)
  return nuxt
}

async function serverImportDirectories(nuxt: Awaited<ReturnType<typeof loadNuxt>>): Promise<readonly string[]> {
  const dirs: string[] = []
  await nuxt.callHook('nitro:config', { imports: { dirs } })
  return dirs
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-module-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  return root
}

async function loadAdapterModule() {
  vi.resetModules()
  const mod = await import('../src/module')
  return {
    module: {
      setup: async (options: ModuleOptions, nuxt: Awaited<ReturnType<typeof loadNuxt>>) => await nuxt.runWithContext(() => mod.default(options, nuxt)),
    },
    moduleInternals: mod.moduleInternals,
  }
}

async function loadComposables(runtimeConfig: RuntimeConfigShape) {
  const runtime = await import('../src/runtime/composables')
  runtime.configureHoloRuntimeConfig(runtimeConfig as Parameters<typeof runtime.configureHoloRuntimeConfig>[0])
  return runtime
}

const envKeys = [
  'DB_DRIVER',
  'DB_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_DATABASE',
  'DB_SCHEMA',
  'DB_SSL',
  'DB_LOGGING',
  'APP_KEY',
  'APP_URL',
  'APP_DEBUG',
  'APP_ENV',
] as const

const originalEnv = new Map<string, string | undefined>(
  envKeys.map(key => [key, process.env[key]]),
)

afterEach(async () => {
  await Promise.all(nativeNuxtInstances.splice(0).map(nuxt => nuxt.close()))
  const runtime = await import('../src/runtime/composables')
  runtime.resetHoloRuntimeConfig()
  vi.doUnmock('@nuxt/kit')
  vi.doUnmock('#app')
  vi.doUnmock('nitropack/runtime/plugin')
  vi.doUnmock('nitropack/runtime/config')
  vi.doUnmock('nitropack/runtime/context')
  vi.doUnmock('h3')
  vi.doUnmock('@holo-js/config')
  vi.doUnmock('@holo-js/db')
  vi.doUnmock('@holo-js/core')
  vi.doUnmock('@holo-js/storage')
  vi.doUnmock('../src/runtime/composables')
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  const core = await vi.importActual<typeof HoloCoreModule>('@holo-js/core')
  await core.resetHoloRuntime()

  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (typeof value === 'undefined') {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }

  return Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/adapter-nuxt module setup', () => {
  it('loads root configuration when Nuxt uses a separate application source directory', async () => {
    const root = await createProject()
    await mkdir(join(root, 'app'))
    await writeFile(join(root, 'config/app.mjs'), "export default { name: 'Root Config App' }\n")
    const nuxt = await createNuxtHarness(root)
    expect(nuxt.options.srcDir).not.toBe(nuxt.options.rootDir)
    const { module } = await loadAdapterModule()
    await module.setup({}, nuxt)
    expect(nuxt.options.runtimeConfig.public.holo).toMatchObject({ appName: 'Root Config App' })
    expect(nuxt.options.runtimeConfig.holo).toMatchObject({ projectRoot: root })
  })

  it('loads app and database config files from the project root and wires runtime integrations', async () => {
    const root = await createProject()
    await writeFile(join(root, '.env'), 'APP_URL=https://env.test\nDB_PASSWORD=top-secret\n', 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: 'Example App',
  key: 'base64:key',
  url: env('APP_URL', 'http://localhost:3000'),
  debug: false,
  env: 'production',
})
`, 'utf8')
    await writeFile(join(root, 'config/database.ts'), `
import { env } from ${packageEntry}
import { defineDatabaseConfig } from ${databaseEntry}

export default defineDatabaseConfig({
  defaultConnection: 'primary',
  connections: {
    primary: {
      driver: 'postgres',
      url: 'postgresql://db.internal/main',
      password: env('DB_PASSWORD'),
      schema: 'public',
      logging: true,
    },
  },
})
`, 'utf8')

    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)

    expect((nuxt.options.runtimeConfig.holo as Record<string, unknown>)).toMatchObject({
      appUrl: 'https://env.test',
      appDebug: false,
      appEnv: 'production',
      projectRoot: root,
    })
    expect((nuxt.options.runtimeConfig.public as Record<string, unknown>)).toMatchObject({
      holo: {
        appName: 'Example App',
      },
    })
    expect(nuxt.options.runtimeConfig.db).toEqual({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'postgres',
          url: 'postgresql://db.internal/main',
          password: 'top-secret',
          schema: 'public',
          logging: true,
        },
      },
    })
  })

  it('falls back to default config values when config files are absent', async () => {
    const root = await createProject()
    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)

    expect((nuxt.options.runtimeConfig.holo as Record<string, unknown>)).toMatchObject({
      appUrl: 'http://localhost:3000',
      appEnv: 'development',
      appDebug: true,
    })
    expect(nuxt.options.runtimeConfig.db).toEqual({
      defaultConnection: 'default',
      connections: {
        default: {
          driver: 'sqlite',
          url: './data/database.sqlite',
          schema: 'public',
          logging: false,
        },
      },
    })
    expect(nuxt.options.nitro.plugins).toContain(resolve(import.meta.dirname, '../src/runtime/plugins/init'))
    expect(nuxt.options.nitro.plugins).toContain(resolve(import.meta.dirname, '../src/runtime/plugins/forms'))
    const imports: Parameters<typeof nuxt.callHook<'imports:extend'>>[1] = []
    await nuxt.callHook('imports:extend', imports)
    expect(imports).toEqual([])
    expect(await serverImportDirectories(nuxt)).toContain(resolve(import.meta.dirname, '../src/runtime/server/auto-imports'))
    expect(await serverImportDirectories(nuxt)).toHaveLength(1)
    expect(nuxt.options.build.transpile).toContain(resolve(import.meta.dirname, '../src/runtime'))
    expect(nuxt.options.build.transpile).toContain('@holo-js/auth')

    const references: Array<{ types: string } | { path: string }> = []
    await nuxt.callHook('prepare:types', { references, declarations: [], nodeReferences: [], sharedReferences: [], tsConfig: {}, nodeTsConfig: {}, sharedTsConfig: {} })
    expect(references).toContainEqual({ types: '@holo-js/adapter-nuxt' })
    expect(references).toContainEqual({ path: resolve(root, '.holo-js/generated/auth.d.ts') })
    expect(references).toContainEqual({ path: resolve(root, '.holo-js/generated/authorization/types.d.ts') })
    expect(references).toContainEqual({ path: resolve(root, '.holo-js/generated/model-registry.d.ts') })
    expect(await readFile(resolve(root, '.holo-js/generated/auth.d.ts'), 'utf8')).toBe(
      '// Generated by holo prepare. Do not edit.\n\nexport {}\n',
    )
    expect(await readFile(resolve(root, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).toBe(
      '// Generated by holo prepare. Do not edit.\n\nexport {}\n',
    )
    expect(await readFile(resolve(root, '.holo-js/generated/model-registry.d.ts'), 'utf8')).toBe(
      '// Generated by holo prepare. Do not edit.\n\nexport {}\n',
    )
  })

  it('registers declaration artifacts generated by Holo plugins', async () => {
    const root = await createProject()
    const manifestRoot = resolve(root, '.holo-js/generated/.plugins')
    const generatedTypePath = resolve(root, '.holo-js/generated/panels/resource-type-bindings.d.ts')
    await mkdir(manifestRoot, { recursive: true })
    await mkdir(dirname(generatedTypePath), { recursive: true })
    await writeFile(generatedTypePath, 'export {}\n', 'utf8')
    await writeFile(resolve(manifestRoot, 'panels.json'), `${JSON.stringify({
      generatedArtifacts: [{ path: 'resource-type-bindings.d.ts' }, { path: 'resources.ts' }],
      pluginId: 'panels',
      version: 1,
    })}\n`, 'utf8')
    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)

    const references: Array<{ types: string } | { path: string }> = []
    await nuxt.callHook('prepare:types', { references, declarations: [], nodeReferences: [], sharedReferences: [], tsConfig: {}, nodeTsConfig: {}, sharedTsConfig: {} })
    expect(references).toContainEqual({ path: generatedTypePath })
  })

  it('decodes auth cookies and preserves response cookies through native HTTP', async () => {
    vi.resetModules()
    const runtime = await import('../src/runtime/composables')
    const app = createApp()
    app.use(defineEventHandler(async event => {
      const accessors = runtime.createNuxtAuthRequestAccessors(event)
      event.node.res.setHeader('set-cookie', 'theme=dark; Path=/')
      await accessors.appendResponseCookie?.('holo_session=session-1; Path=/; HttpOnly')
      await accessors.appendResponseCookie?.('holo_session_remember=remember-1; Path=/; HttpOnly')
      return {
        authorization: await accessors.getHeader('Authorization'),
        missingHeader: await accessors.getHeader('missing') ?? null,
        brokenCookie: await accessors.getCookie('broken') ?? null,
        missingCookie: await accessors.getCookie('missing') ?? null,
        token: await accessors.getCookie('auth-token'),
      }
    }))

    const response = await fetch(await serve(app), {
      headers: {
        authorization: 'Bearer native',
        cookie: '%=invalid-key; broken=%; invalid; auth-token=secret%20value',
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authorization: 'Bearer native',
      missingHeader: null,
      brokenCookie: null,
      missingCookie: null,
      token: 'secret value',
    })
    expect(response.headers.getSetCookie()).toEqual([
      'theme=dark; Path=/',
      'holo_session=session-1; Path=/; HttpOnly',
      'holo_session_remember=remember-1; Path=/; HttpOnly',
    ])
  })

  it('sends the native auth redirect with its session cookie', async () => {
    vi.resetModules()
    const runtime = await import('../src/runtime/composables')
    const app = createApp()
    app.use(defineEventHandler(async event => {
      const accessors = runtime.createNuxtAuthRequestAccessors(event)
      await accessors.appendResponseCookie?.('holo_session=session-1; Path=/; HttpOnly')
      await accessors.redirectResponse?.('/dashboard', 303)
    }))

    const response = await fetch(await serve(app), { method: 'POST', redirect: 'manual' })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/dashboard')
    expect(response.headers.getSetCookie()).toEqual(['holo_session=session-1; Path=/; HttpOnly'])
  })

  it.each(['.', 'app'])('registers project server models and schema when Nuxt source directory is %s', async sourceDirectory => {
    const root = await createProject()
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  paths: {
    generatedSchema: '.holo-js/generated/schema.generated.ts',
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/models/User.ts'), 'export default class User {}\nexport function prepareAuthCreateInput() {}\n', 'utf8')
    await writeFile(join(root, 'server/models/Admin.mts'), 'export default class Admin {}\nexport function prepareAuthCreateInput() {}\n', 'utf8')
    await writeFile(join(root, 'server/models/README.md'), '# ignored\n', 'utf8')

    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    nuxt.options.srcDir = join(root, sourceDirectory)
    nuxt.options.nitro.moduleSideEffects = ['/application/bootstrap']
    await mkdir(nuxt.options.srcDir, { recursive: true })

    await module.setup({}, nuxt)

    expect(await serverImportDirectories(nuxt)).toContain(resolve(import.meta.dirname, '../src/runtime/server/auto-imports'))
    expect(await serverImportDirectories(nuxt)).toContain(resolve(root, '.holo-js/generated/nuxt-server-imports'))
    expect(await serverImportDirectories(nuxt)).toHaveLength(2)
    expect(nuxt.options.nitro.plugins).toContain(resolve(root, '.holo-js/generated/nuxt-server-imports/plugin.ts'))
    expect(nuxt.options.nitro.moduleSideEffects).toEqual(['/application/bootstrap', resolve(root, '.holo-js/generated/schema.generated.ts')])
    expect(await readFile(join(root, '.holo-js/generated/nuxt-server-imports/models.ts'), 'utf8')).toBe([
      "import '../schema.generated'",
      '',
      "export { default as Admin } from '../../../server/models/Admin'",
      "export { default as User } from '../../../server/models/User'",
      '',
    ].join('\n'))
    expect(await readFile(join(root, '.holo-js/generated/nuxt-server-imports/plugin.ts'), 'utf8')).toBe([
      "import '../schema.generated'",
      "import './models'",
      '',
      'export default () => {}',
      '',
    ].join('\n'))
  })

  it('generates server model imports from the configured model path', async () => {
    const root = await createProject()
    await mkdir(join(root, 'app/models'), { recursive: true })
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  paths: {
    models: 'app/models',
    generatedSchema: '.holo-js/generated/schema.generated.ts',
  },
})
`, 'utf8')
    await writeFile(join(root, 'app/models/Profile.ts'), 'export default class Profile {}\n', 'utf8')

    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)

    expect(await serverImportDirectories(nuxt)).toContain(resolve(root, '.holo-js/generated/nuxt-server-imports'))
    expect(await readFile(join(root, '.holo-js/generated/nuxt-server-imports/models.ts'), 'utf8')).toBe([
      "import '../schema.generated'",
      '',
      "export { default as Profile } from '../../../app/models/Profile'",
      '',
    ].join('\n'))
  })

  it('registers the built s3 runtime driver path for object storage disks', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${storageEntry}

export default defineStorageConfig({
  defaultDisk: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
    },
    media: {
      driver: 's3',
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    },
  },
})
`, 'utf8')

    const { module } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)

    await module.setup({}, nuxt)

    expect(nuxt.options.nitro.storage?.['holo:media']).toMatchObject({
      driver: resolve(import.meta.dirname, '../src/runtime/drivers/s3.js'),
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
    })
  })

  it('traces installed runtime-loaded packages into Nitro production output', async () => {
    const root = await createProject()
    const { moduleInternals } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)
    const nitro = nuxt.options.nitro as typeof nuxt.options.nitro & {
      externals: {
        external: string[]
        inline: string[]
        traceInclude: string[]
      }
    }
    nitro.externals = {
      external: ['existing-external'],
      inline: ['existing-inline'],
      traceInclude: ['existing-package'],
    }
    const installed = new Map([
      ['@holo-js/db-sqlite', '/app/node_modules/@holo-js/db-sqlite/dist/index.mjs'],
      ['@holo-js/mail', '/app/node_modules/@holo-js/mail/dist/index.mjs'],
      ['@holo-js/storage', '/app/node_modules/@holo-js/storage/dist/index.mjs'],
      ['@holo-js/storage/runtime', '/app/node_modules/@holo-js/storage/dist/runtime/composables/index.mjs'],
      ['custom-holo-plugin', '/app/node_modules/custom-holo-plugin/index.mjs'],
    ])

    moduleInternals.addNitroRuntimeTraceIncludes(
      nuxt.options as never,
      root,
      ['custom-holo-plugin', 'missing-holo-plugin'],
      (_rootDir: string, packageName: string) => installed.get(packageName),
    )

    expect(nitro.externals.traceInclude).toEqual([
      'existing-package',
      '/app/node_modules/@holo-js/db-sqlite/dist/index.mjs',
      '/app/node_modules/@holo-js/mail/dist/index.mjs',
      '/app/node_modules/@holo-js/storage/dist/index.mjs',
      '/app/node_modules/@holo-js/storage/dist/runtime/composables/index.mjs',
      '/app/node_modules/custom-holo-plugin/index.mjs',
    ])
    expect(nitro.externals.external).toEqual(expect.arrayContaining([
      'existing-external',
      '@holo-js/core',
      '@holo-js/db',
      '@holo-js/security',
    ]))
    expect(nitro.externals.inline).toEqual([
      'existing-inline',
      '@holo-js/auth/nuxt',
      '@holo-js/auth/nuxt/server',
    ])
  })

  it('leaves workspace-linked runtime packages available without Nitro tracing', async () => {
    const root = await createProject()
    const workspacePackage = join(root, 'workspace-core')
    const installedPackage = join(root, 'node_modules/@holo-js/core')
    await mkdir(workspacePackage, { recursive: true })
    await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
    await symlink(workspacePackage, installedPackage, 'dir')
    const { module, moduleInternals } = await loadAdapterModule()
    const nuxt = await createNuxtHarness(root)
    await module.setup({}, nuxt)
    const nitro = nuxt.options.nitro as typeof nuxt.options.nitro & {
      externals?: { trace?: boolean }
      rollupConfig?: { preserveSymlinks?: boolean }
    }

    expect(moduleInternals.isProjectPackageLinked(root, '@holo-js/core')).toBe(true)
    expect(moduleInternals.resolveProjectPackageTraceEntry(root, '@holo-js/core')).toBeUndefined()
    expect(moduleInternals.resolveProjectPackageTraceEntry(root, '')).toBeUndefined()
    expect(nitro.externals?.trace).toBe(false)
    expect(nitro.rollupConfig?.preserveSymlinks).toBe(true)
  })

  it('detects Windows-style storage config paths', async () => {
    const mod = await import('../src/module')

    for (const extension of ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs']) {
      expect(mod.moduleInternals.hasLoadedConfigFile({
        loadedFiles: [
          `C:\\workspace\\app\\config\\storage.${extension}`,
        ],
      } as never, 'storage')).toBe(true)
    }
    expect(mod.moduleInternals.hasLoadedConfigFile({
      loadedFiles: ['C:\\workspace\\app\\config\\mail.ts'],
    } as never, 'storage')).toBe(false)
  })

  it('treats ERR_MODULE_NOT_FOUND storage-s3 imports as absent optional modules', async () => {
    const mod = await import('../src/module')

    expect(mod.moduleInternals.hasModuleNotFoundCode(
      Object.assign(new Error('Cannot find package "@holo-js/storage-s3" imported from "/tmp/app.mjs"'), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
      '@holo-js/storage-s3',
    )).toBe(true)

    expect(mod.moduleInternals.hasModuleNotFoundCode(
      Object.assign(new Error('Failed to load url `@holo-js/storage-s3` (resolved id: `@holo-js/storage-s3`). Does the file exist?'), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
      '@holo-js/storage-s3',
    )).toBe(true)
  })

  it('only matches missing-module errors for the expected optional package specifier', async () => {
    const mod = await import('../src/module')

    expect(mod.moduleInternals.hasModuleNotFoundCode(
      Object.assign(new Error('Cannot find package "@holo-js/storage-s3" imported from "/tmp/app.mjs"'), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
      '@holo-js/storage-s3',
    )).toBe(true)

    expect(mod.moduleInternals.hasModuleNotFoundCode(
      Object.assign(new Error('Failed to initialize storage-s3.'), {
        code: 'ERR_MODULE_NOT_FOUND',
        cause: Object.assign(new Error('Cannot find module "sharp" imported from "@holo-js/storage-s3".'), {
          code: 'ERR_MODULE_NOT_FOUND',
        }),
      }),
      '@holo-js/storage-s3',
    )).toBe(false)

    expect(mod.moduleInternals.hasModuleNotFoundCode(
      Object.assign(new Error('Failed to initialize storage-s3.'), {
        code: 'ERR_MODULE_NOT_FOUND',
        cause: Object.assign(new Error('Cannot find package "@holo-js/storage-s3" imported from "/tmp/app.mjs"'), {
          code: 'ERR_MODULE_NOT_FOUND',
        }),
      }),
      '@holo-js/storage-s3',
    )).toBe(true)
  })

  it('returns false for non-object and code-less optional-module errors', async () => {
    const mod = await import('../src/module')

    expect(mod.moduleInternals.hasModuleNotFoundCode(null, '@holo-js/storage-s3')).toBe(false)
    expect(mod.moduleInternals.hasModuleNotFoundCode({
      code: 'ERR_MODULE_NOT_FOUND',
    }, '@holo-js/storage-s3')).toBe(false)
    expect(mod.moduleInternals.hasModuleNotFoundCode(new Error('Cannot find package "@holo-js/storage-s3"'), '@holo-js/storage-s3')).toBe(false)
  })

  it('boots from cached configuration without evaluating the replaced live config in production', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/app.mjs'), "export default { name: 'Cached App', env: 'production', debug: false }\n")
    await writeConfigCache(root, { envName: 'production', processEnv: {} })
    await writeFile(join(root, 'config/app.mjs'), "throw new Error('Live configuration must not be evaluated')\n")
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const nuxt = await createNuxtHarness(root)
      const { module } = await loadAdapterModule()
      await module.setup({}, nuxt)
      expect(nuxt.options.runtimeConfig.public.holo).toMatchObject({ appName: 'Cached App' })
      expect(nuxt.options.runtimeConfig.holo).toMatchObject({ appEnv: 'production', appDebug: false })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('registers public local storage through the real Nuxt module loader', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/storage.mjs'), `export default {
      defaultDisk: 'local', routePrefix: '/assets',
      disks: { local: { driver: 'public', root: './storage/app/public', visibility: 'public' } },
    }`)
    const nuxt = await createNuxtHarness(root)
    const { module } = await loadAdapterModule()
    await module.setup({}, nuxt)
    await nuxt.callHook('modules:done')
    expect(nuxt.options.runtimeConfig.holoStorage).toMatchObject({ defaultDisk: 'local', routePrefix: '/assets' })
    expect(nuxt.options.serverHandlers).toContainEqual(expect.objectContaining({
      route: '/assets/**', handler: resolve(import.meta.dirname, '../src/runtime/server/routes/storage'),
    }))
  })

})

describe('useHoloDb', () => {
  it('preserves passwords for named runtimeConfig.db connections', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        defaultConnection: 'primary',
        connections: {
          primary: {
            driver: 'postgres',
            host: 'db.internal',
            username: 'app',
            password: 'secret',
            database: 'main',
          },
        },
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'postgres',
          url: undefined,
          host: 'db.internal',
          port: undefined,
          username: 'app',
          password: 'secret',
          database: 'main',
          schema: undefined,
          ssl: undefined,
          logging: false,
        },
      },
    })
  })

  it('prefers the named default connection when present without explicit default config', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        connections: {
          analytics: {
            driver: 'postgres',
            url: 'postgresql://analytics.internal/app',
          },
          default: {
            driver: 'mysql',
            url: 'mysql://default.internal/app',
          },
        },
      },
    })

    expect(useHoloDb().defaultConnection).toBe('default')
  })

  it('uses runtimeConfig.db values as-is without inheriting app metadata', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        connections: {
          default: {
            driver: 'postgres',
            host: 'db.internal',
            username: 'app',
            database: 'main',
          },
        },
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'default',
      connections: {
        default: {
          driver: 'postgres',
          url: undefined,
          host: 'db.internal',
          port: undefined,
          username: 'app',
          password: undefined,
          database: 'main',
          schema: undefined,
          ssl: undefined,
          logging: false,
        },
      },
    })
  })

  it('uses the only named connection as the default in the composable output', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        connections: {
          analytics: {
            driver: 'postgres',
            url: 'postgresql://analytics.internal/app',
          },
        },
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'analytics',
      connections: {
        analytics: {
          driver: 'postgres',
          url: 'postgresql://analytics.internal/app',
          host: undefined,
          port: undefined,
          username: undefined,
          password: undefined,
          database: undefined,
          schema: undefined,
          ssl: undefined,
          logging: false,
        },
      },
    })
  })

  it('supports env helpers, string URLs, and filename-based sqlite inference', async () => {
    const { useHoloDb, useHoloEnv, useHoloDebug } = await loadComposables({
      holo: {
        appEnv: 'test',
        appDebug: true,
      },
      db: {
        defaultConnection: 'analytics',
        connections: {
          analytics: {
            filename: './data/direct.sqlite',
            logging: true,
          },
          replica: 'postgresql://replica.internal/app',
        },
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'analytics',
      connections: {
        analytics: {
          driver: 'sqlite',
          url: './data/direct.sqlite',
          host: undefined,
          port: undefined,
          username: undefined,
          password: undefined,
          database: './data/direct.sqlite',
          schema: undefined,
          ssl: undefined,
          logging: true,
        },
        replica: {
          url: 'postgresql://replica.internal/app',
        },
      },
    })
    expect(useHoloEnv()).toBe('test')
    expect(useHoloDebug()).toBe(true)
  })

  it('supports db.defaultConnection with canonical connection properties', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        defaultConnection: 'warehouse',
        connections: {
          warehouse: {
            driver: 'mysql',
            username: 'reporter',
            password: 'secret',
            database: 'warehouse',
            logging: true,
          },
        },
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'warehouse',
      connections: {
        warehouse: {
          driver: 'mysql',
          url: undefined,
          host: undefined,
          port: undefined,
          username: 'reporter',
          password: 'secret',
          database: 'warehouse',
          schema: undefined,
          ssl: undefined,
          logging: true,
        },
      },
    })
  })

  it('supports empty direct holo connection groups and driverless object connections', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        connections: {
          analytics: {
            url: 'https://example.test/not-a-db-url',
          },
        },
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'analytics',
      connections: {
        analytics: {
          driver: undefined,
          url: 'https://example.test/not-a-db-url',
          host: undefined,
          port: undefined,
          username: undefined,
          password: undefined,
          database: undefined,
          schema: undefined,
          ssl: undefined,
          logging: false,
        },
      },
    })
  })

  it('returns an empty direct holo connection group with the default fallback name', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        connections: {},
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'default',
      connections: {},
    })
  })

  it('falls back to an empty group when runtimeConfig.db is absent', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'default',
      connections: {},
    })
  })

  it('falls back to empty connections when runtimeConfig.db omits them', async () => {
    const { useHoloDb } = await loadComposables({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        defaultConnection: 'primary',
      },
    })

    expect(useHoloDb()).toEqual({
      defaultConnection: 'primary',
      connections: {},
    })
  })

  it('throws a type error when runtime config bindings are unavailable', async () => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.doUnmock('#app')

    const runtime = await import('../src/runtime/composables')

    expect(() => runtime.useHoloEnv()).toThrow(TypeError)
    expect(() => runtime.useHoloDb()).toThrow('Holo runtime config is not configured.')
  })

  it('uses configured runtime config from shared globals and can reset it', async () => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.doUnmock('#app')

    const runtime = await import('../src/runtime/composables')

    runtime.configureHoloRuntimeConfig({
      holo: {
        appEnv: 'test',
        appDebug: true,
      },
      db: {
        connections: {
          default: {
            url: './configured.sqlite',
          },
        },
      },
    })

    expect(runtime.useHoloDb()).toEqual({
      defaultConnection: 'default',
      connections: {
        default: {
          driver: undefined,
          url: './configured.sqlite',
          host: undefined,
          port: undefined,
          username: undefined,
          password: undefined,
          database: undefined,
          schema: undefined,
          ssl: undefined,
          logging: false,
        },
      },
    })
    expect(runtime.useHoloEnv()).toBe('test')
    expect(runtime.useHoloDebug()).toBe(true)
    expect(typeof runtime.holo.getApp).toBe('function')

    runtime.resetHoloRuntimeConfig()

    expect(() => runtime.useHoloDb()).toThrow('Holo runtime config is not configured.')
  })

  it.each(['production', 'development', 'test'] as const)('boots a real SQLite project through holo.getApp in %s', async appEnv => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', appEnv)
    const root = await createProject()
    await writeFile(join(root, 'config/app.mjs'), `export default { name: 'Native Nuxt App', env: '${appEnv}', key: 'base64:key', url: 'http://localhost' }`)
    await writeFile(join(root, 'config/database.mjs'), `export default { defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } }`)
    const runtime = await import('../src/runtime/composables')
    runtime.configureHoloRuntimeConfig({ holo: { appEnv, appDebug: false, projectRoot: root } })

    const project = await runtime.holo.getApp()
    expect(project.projectRoot).toBe(root)
    expect(project.config.app.name).toBe('Native Nuxt App')
    expect(project.config.app.env).toBe(appEnv)
    expect(runtime.useHoloEnv()).toBe(appEnv)
    expect(await project.runtime.manager.connection('main').queryCompiled<{ value: number }>({
      sql: 'SELECT 42 AS value',
      source: 'test:native-nuxt:connection',
    })).toMatchObject({ rows: [{ value: 42 }] })

    const synchronousResult = runtime.runWithNuxtRequest({}, () => ({ mode: 'sync' as const }))
    const asynchronousResult = runtime.runWithNuxtRequest({}, async () => ({ mode: 'async' as const }))
    expectTypeOf(synchronousResult).toEqualTypeOf<Promise<{ mode: 'sync' }>>()
    expectTypeOf(asynchronousResult).toEqualTypeOf<Promise<{ mode: 'async' }>>()
    await expect(synchronousResult).resolves.toEqual({ mode: 'sync' })
    await expect(asynchronousResult).resolves.toEqual({ mode: 'async' })
  })

  it('boots the working directory when no runtime projectRoot is configured', async () => {
    vi.resetModules()
    const root = await createProject()
    await writeFile(join(root, 'config/app.mjs'), "export default { name: 'Working Directory App' }")
    await writeFile(join(root, 'config/database.mjs'), `export default { defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } }`)
    const previousCwd = process.cwd()
    const runtime = await import('../src/runtime/composables')
    runtime.configureHoloRuntimeConfig({ holo: { appEnv: 'development', appDebug: false } })
    try {
      process.chdir(root)
      const project = await runtime.holo.getApp()
      expect(project.projectRoot).toBe(await realpath(root))
      expect(project.config.app.name).toBe('Working Directory App')
    } finally {
      process.chdir(previousCwd)
    }
  })

})
