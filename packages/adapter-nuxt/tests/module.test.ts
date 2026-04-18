import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type RuntimeConfigShape = Record<string, unknown>
const packageEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const tempDirs: string[] = []

function createNuxtHarness(rootDir: string, runtimeConfig: RuntimeConfigShape = {}) {
  return {
    options: {
      runtimeConfig,
      build: {
        transpile: [] as string[],
      },
      srcDir: rootDir,
      rootDir,
    },
    hook: vi.fn(),
  }
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
    addServerHandler,
    addServerPlugin,
    addServerImportsDir,
  }))

  const mod = await import('../src/module')

  return {
    module: mod.default,
    addImports,
    addServerHandler,
    addServerImportsDir,
    addServerPlugin,
  }
}

async function loadComposables(runtimeConfig: RuntimeConfigShape) {
  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

  vi.doMock('#app', () => ({
    useRuntimeConfig: () => runtimeConfig,
  }))

  return import('../src/runtime/composables')
}

async function loadRootExports(runtimeConfig: RuntimeConfigShape) {
  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

  vi.doMock('@nuxt/kit', () => ({
    defineNuxtModule: (definition: unknown) => definition,
    createResolver: () => ({
      resolve: (value: string) => value,
    }),
    addImports: vi.fn(),
    addServerPlugin: vi.fn(),
    addServerImportsDir: vi.fn(),
    addServerHandler: vi.fn(),
  }))
  vi.doMock('#app', () => ({
    useRuntimeConfig: () => runtimeConfig,
  }))

  return import('../src')
}

async function loadRuntimeExports(runtimeConfig: RuntimeConfigShape) {
  vi.resetModules()

  const shutdown = vi.fn(async () => {})
  const initializeHoloAdapterProject = vi.fn(async () => ({
    runtime: {
      manager: {
        connection: () => ({ getDriver: () => 'sqlite' }),
      },
      shutdown,
    },
  }))

  vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  vi.doMock('#app', () => ({
    useRuntimeConfig: () => runtimeConfig,
  }))

  const configureHoloRuntimeConfig = vi.fn()

  vi.doMock('@holo-js/core', async (importOriginal) => {
    const actual = await importOriginal()

    return {
      ...actual,
      initializeHoloAdapterProject,
    }
  })

  vi.doMock('../src/runtime/composables', async (importOriginal) => {
    const actual = await importOriginal()

    return {
      ...actual,
      configureHoloRuntimeConfig,
    }
  })

  const runtime = await import('../src/runtime/composables')
  const pluginModule = await import('../src/runtime/plugins/init')

  return {
    runtime,
    plugin: pluginModule.default,
    shutdown,
    configureHoloRuntimeConfig,
    initializeHoloAdapterProject,
  }
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

afterEach(() => {
  vi.doUnmock('@nuxt/kit')
  vi.doUnmock('#app')
  vi.doUnmock('@holo-js/config')
  vi.doUnmock('@holo-js/db')
  vi.doUnmock('@holo-js/core')
  vi.doUnmock('@holo-js/storage')
  vi.doUnmock('../src/runtime/composables')
  vi.unstubAllGlobals()

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
  it('falls back to srcDir when rootDir and runtimeConfig are absent', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Src Dir App',
})
`, 'utf8')

    const { module } = await loadAdapterModule()
    const nuxt = createNuxtHarness(root)
    delete (nuxt.options as { rootDir?: string }).rootDir
    delete (nuxt.options as { runtimeConfig?: Record<string, unknown> }).runtimeConfig

    await module.setup({}, nuxt as never)

    expect((nuxt.options.runtimeConfig as Record<string, unknown>).holo).toMatchObject({
      appUrl: 'http://localhost:3000',
      appEnv: 'development',
      appDebug: true,
    })
    expect((nuxt.options.runtimeConfig as Record<string, unknown>).db).toBeDefined()
  })

  it('falls back to process.cwd when both rootDir and srcDir are absent', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Cwd App',
})
`, 'utf8')

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    const { module } = await loadAdapterModule()
    const nuxt = createNuxtHarness(root)
    delete (nuxt.options as { rootDir?: string }).rootDir
    delete (nuxt.options as { srcDir?: string }).srcDir

    await module.setup({}, nuxt as never)

    expect((nuxt.options.runtimeConfig as Record<string, unknown>).holo).toMatchObject({
      appUrl: 'http://localhost:3000',
      appEnv: 'development',
      appDebug: true,
    })

    cwd.mockRestore()
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
import { defineDatabaseConfig, env } from ${packageEntry}

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
    const nuxt = createNuxtHarness(root)

    await module.setup({}, nuxt as never)

    expect((nuxt.options.runtimeConfig.holo as Record<string, unknown>)).toMatchObject({
      appUrl: 'https://env.test',
      appDebug: false,
      appEnv: 'production',
      projectRoot: root,
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
    const { module, addImports, addServerImportsDir, addServerPlugin } = await loadAdapterModule()
    const nuxt = createNuxtHarness(root)

    await module.setup({}, nuxt as never)

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
    expect(addServerPlugin).toHaveBeenCalledWith('./runtime/plugins/init')
    expect(addImports).toHaveBeenCalledTimes(1)
    expect(addImports.mock.calls[0]?.[0]).toHaveLength(6)
    expect(addImports.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'holo', as: 'holo', from: './runtime/composables' }),
      expect.objectContaining({ name: 'useStorage', as: 'useStorage', from: './runtime/composables/storage' }),
      expect.objectContaining({ name: 'Storage', as: 'Storage', from: './runtime/composables/storage' }),
    ]))
    expect(addServerImportsDir).toHaveBeenCalledWith('./runtime/server/imports')
    expect(addServerImportsDir).toHaveBeenCalledWith(resolve(root, 'server/models'))
    expect(addServerImportsDir).toHaveBeenCalledTimes(2)
    expect(nuxt.options.build.transpile).toContain('./runtime')

    const prepareTypes = nuxt.hook.mock.calls.find(([name]) => name === 'prepare:types')?.[1]
    const references: Array<Record<string, string>> = []
    prepareTypes?.({ references })
    expect(references).toContainEqual({ types: '@holo-js/adapter-nuxt' })
  })

  it('registers the built s3 runtime driver path for object storage disks', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${packageEntry}

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
    const nuxt = createNuxtHarness(root)

    await module.setup({}, nuxt as never)

    expect(nuxt.options.nitro.storage['holo:media']).toMatchObject({
      driver: './runtime/drivers/s3.js',
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
    })
  })

  it('fails early when an s3 storage disk is configured without @holo-js/storage-s3', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${packageEntry}

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

    vi.doMock('@holo-js/storage-s3', () => ({
      default: undefined,
    }))

    try {
      const { module } = await loadAdapterModule()
      const nuxt = createNuxtHarness(root)
      await expect(module.setup({}, nuxt as never)).rejects.toThrow(
        '[@holo-js/adapter-nuxt] S3 storage disks require @holo-js/storage-s3 to be installed.',
      )
    } finally {
      vi.doUnmock('@holo-js/storage-s3')
    }
  })

  it('detects Windows-style storage config paths', async () => {
    const mod = await import('../src/module')

    expect(mod.moduleInternals.hasLoadedConfigFile({
      loadedFiles: [
        'C:\\workspace\\app\\config\\storage.ts',
      ],
    } as never, 'storage')).toBe(true)
  })

  it('treats ERR_MODULE_NOT_FOUND storage-s3 imports as absent optional modules', async () => {
    const mod = await import('../src/module')

    expect(mod.moduleInternals.hasModuleNotFoundCode(
      Object.assign(new Error('Cannot find package "@holo-js/storage-s3" imported from "/tmp/app.mjs"'), {
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

  it('rethrows non-missing optional storage-s3 import errors', async () => {
    vi.resetModules()
    vi.doMock('@holo-js/storage-s3', () => {
      return {
        get default() {
          throw new Error('boom')
        },
      }
    })

    try {
      const mod = await import('../src/module')
      await expect(mod.moduleInternals.importOptionalStorageS3Module()).rejects.toThrow('boom')
    } finally {
      vi.doUnmock('@holo-js/storage-s3')
      vi.resetModules()
    }
  })

  it('prefers cached config artifacts for production module setup', async () => {
    const root = await createProject()
    const loadConfigDirectory = vi.fn(async () => ({
      app: {
        name: 'Cached App',
        key: '',
        url: 'http://localhost:3000',
        debug: false,
        env: 'production',
        paths: {
          models: 'server/models',
          migrations: 'server/db/migrations',
          generatedSchema: 'server/db/schema.generated.ts',
          seeders: 'server/db/seeders',
          observers: 'server/observers',
          factories: 'server/db/factories',
          commands: 'server/commands',
          jobs: 'server/jobs',
        },
        models: [],
        migrations: [],
        seeders: [],
      },
      database: {
        defaultConnection: 'default',
        connections: {
          default: {
            driver: 'sqlite',
            url: ':memory:',
          },
        },
      },
      storage: {
        defaultDisk: 'local',
        routePrefix: '/storage',
        disks: {},
      },
      media: {},
      custom: {},
      all: {} as never,
      environment: {
        name: 'production',
        values: {},
        loadedFiles: [],
        warnings: [],
      },
      loadedFiles: [],
      warnings: [],
    }))

    vi.doMock('@holo-js/config', async (importOriginal) => {
      const actual = await importOriginal()
      return {
        ...actual,
        loadConfigDirectory,
      }
    })

    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    try {
      const { module } = await loadAdapterModule()
      const nuxt = createNuxtHarness(root)

      await module.setup({}, nuxt as never)

      expect(loadConfigDirectory).toHaveBeenCalledWith(root, {
        preferCache: true,
        processEnv: process.env,
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
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

  it('re-exports the root module surface', async () => {
    const root = await loadRootExports({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
    })

    expect(typeof root.default).toBe('object')
    expect(typeof root.holo).toBe('object')
    expect(typeof root.useHoloDb).toBe('function')
    expect(typeof root.useHoloEnv).toBe('function')
    expect(typeof root.useHoloDebug).toBe('function')
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

  it('routes holo.getApp through the shared adapter helper with runtime env names', async () => {
    vi.resetModules()
    vi.unstubAllGlobals()

    const runtimeConfig = {
      holo: {
        appEnv: 'test',
        projectRoot: '/tmp/nuxt-project',
      },
    }
    const initializeHoloAdapterProject = vi.fn(async () => ({
      projectRoot: '/tmp/nuxt-project',
      config: {
        app: {
          env: 'test',
        },
      },
      runtime: {},
    }))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/nuxt-runtime-cwd')
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
    vi.doMock('#app', () => ({
      useRuntimeConfig: () => runtimeConfig,
    }))
    vi.doMock('@holo-js/core', async (importOriginal) => {
      const actual = await importOriginal()

      return {
        ...actual,
        initializeHoloAdapterProject,
      }
    })

    try {
      const runtime = await import('../src/runtime/composables')
      await expect(runtime.holo.getApp()).resolves.toMatchObject({
        projectRoot: '/tmp/nuxt-project',
      })
      expect(runtime.useHoloEnv()).toBe('test')
      expect(initializeHoloAdapterProject).toHaveBeenCalledWith('/tmp/nuxt-project', {
        envName: 'test',
        preferCache: true,
        processEnv: process.env,
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      cwd.mockRestore()
    }
  })

  it('preserves non-testing runtime env names when resolving holo.getApp()', async () => {
    vi.resetModules()
    vi.unstubAllGlobals()

    const runtimeConfig = {
      holo: {
        appEnv: 'development',
        projectRoot: '/tmp/nuxt-project',
      },
    }
    const initializeHoloAdapterProject = vi.fn(async () => ({
      projectRoot: '/tmp/nuxt-project',
      config: {
        app: {
          env: 'development',
        },
      },
      runtime: {},
    }))

    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
    vi.doMock('#app', () => ({
      useRuntimeConfig: () => runtimeConfig,
    }))
    vi.doMock('@holo-js/core', async (importOriginal) => {
      const actual = await importOriginal()

      return {
        ...actual,
        initializeHoloAdapterProject,
      }
    })

    const runtime = await import('../src/runtime/composables')
    await runtime.holo.getApp()
    expect(initializeHoloAdapterProject).toHaveBeenCalledWith('/tmp/nuxt-project', expect.objectContaining({
      envName: 'development',
    }))
  })

  it('falls back to process.cwd() when holo.projectRoot is absent at runtime', async () => {
    vi.resetModules()
    vi.unstubAllGlobals()

    const runtimeConfig = {
      holo: {
        appEnv: 'development',
      },
    }
    const initializeHoloAdapterProject = vi.fn(async () => ({
      projectRoot: '/tmp/runtime-cwd',
      config: {
        app: {
          env: 'development',
        },
      },
      runtime: {},
    }))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/runtime-cwd')

    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
    vi.doMock('#app', () => ({
      useRuntimeConfig: () => runtimeConfig,
    }))
    vi.doMock('@holo-js/core', async (importOriginal) => {
      const actual = await importOriginal()

      return {
        ...actual,
        initializeHoloAdapterProject,
      }
    })

    try {
      const runtime = await import('../src/runtime/composables')
      await runtime.holo.getApp()
      expect(initializeHoloAdapterProject).toHaveBeenCalledWith('/tmp/runtime-cwd', expect.objectContaining({
        envName: 'development',
      }))
    } finally {
      cwd.mockRestore()
    }
  })
})

describe('runtime plugin', () => {
  it('initializes the adapter runtime and shuts it down on close', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const hook = vi.fn()
    const { runtime, plugin, configureHoloRuntimeConfig, initializeHoloAdapterProject, shutdown } = await loadRuntimeExports({
      holo: {
        appEnv: 'development',
        appDebug: false,
        projectRoot: '/tmp/nuxt-project',
      },
      db: {
        connections: {
          default: {
            driver: 'sqlite',
            url: './data/database.sqlite',
          },
        },
      },
    })

    expect(typeof runtime.useHoloDb).toBe('function')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/nuxt-runtime-cwd')

    try {
      await plugin({
        hooks: { hook },
      })
    } finally {
      cwd.mockRestore()
    }

    expect(configureHoloRuntimeConfig).toHaveBeenCalledWith({
      holo: {
        appEnv: 'development',
        appDebug: false,
        projectRoot: '/tmp/nuxt-project',
      },
      db: {
        connections: {
          default: {
            driver: 'sqlite',
            url: './data/database.sqlite',
          },
        },
      },
    })
    expect(initializeHoloAdapterProject).toHaveBeenCalledTimes(1)
    expect(initializeHoloAdapterProject).toHaveBeenCalledWith('/tmp/nuxt-project', {
      envName: 'development',
      preferCache: false,
      processEnv: process.env,
    })
    expect(log).toHaveBeenCalledWith('✅ Holo DB connected (sqlite)')

    const closeHandler = hook.mock.calls.find(([name]) => name === 'close')?.[1]
    await closeHandler?.()
    expect(shutdown).toHaveBeenCalledTimes(1)

    log.mockRestore()
  })

  it('swallows adapter runtime shutdown errors on close', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const hook = vi.fn()
    const { plugin, shutdown } = await loadRuntimeExports({
      holo: {
        appEnv: 'development',
        appDebug: false,
      },
      db: {
        connections: {
          default: {
            driver: 'sqlite',
            url: './data/database.sqlite',
          },
        },
      },
    })

    shutdown.mockRejectedValueOnce(new Error('already closed'))

    await plugin({
      hooks: { hook },
    })

    const closeHandler = hook.mock.calls.find(([name]) => name === 'close')?.[1]
    await expect(closeHandler?.()).resolves.toBeUndefined()

    log.mockRestore()
  })
})
