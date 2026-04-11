import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeConfigCache } from '@holo-js/config'
import {
  HOLO_MINIMUM_ADAPTER_CAPABILITIES,
  adapterInternals,
  createHoloAdapterProject,
  type HoloAdapterProject,
  createHoloFrameworkAdapter,
  createHoloProjectAccessors,
  defineHoloAdapterCapabilities,
  getHolo,
  resetSingletonFrameworkProject,
  resetHoloRuntime,
  resolveHoloFrameworkOptions,
} from '../src'
import { Queue, listRegisteredQueueJobs } from '@holo-js/queue'
import { runtimeModuleInternals } from '../src/runtimeModule'
import { configureStorageRuntime, resetStorageRuntime, useStorage } from '@holo-js/storage/runtime'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const tempDirs: string[] = []

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-adapter-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await mkdir(join(root, 'server/db/migrations'), { recursive: true })
  await mkdir(join(root, 'server/db/seeders'), { recursive: true })
  await mkdir(join(root, 'server/commands'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Adapter App',
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
    secret: env('APP_SECRET', 'adapter-secret'),
  },
})
`, 'utf8')
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await resetSingletonFrameworkProject('__holoTestAdapter__')
  resetStorageRuntime()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/core adapter helpers', () => {
  it('resolves project roots and runtime defaults without host-specific behavior', () => {
    const cwd = process.cwd()
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    try {
      const defaults = resolveHoloFrameworkOptions()
      expect(defaults.projectRoot).toBe(cwd)
      expect(defaults.runtime.preferCache).toBe(true)
      expect(defaults.runtime.processEnv).toBe(process.env)

      const explicit = resolveHoloFrameworkOptions({
        projectRoot: '.',
        envName: 'test',
        preferCache: false,
        processEnv: { APP_SECRET: 'explicit' },
      })

      expect(explicit.projectRoot).toBe(resolve('.'))
      expect(explicit.runtime).toEqual({
        envName: 'test',
        preferCache: false,
        processEnv: { APP_SECRET: 'explicit' },
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('freezes adapter capabilities and exposes the shared minimum contract', () => {
    const custom = defineHoloAdapterCapabilities({
      ...HOLO_MINIMUM_ADAPTER_CAPABILITIES,
      hosting: 'runtime-agnostic',
    })

    expect(custom).toEqual(HOLO_MINIMUM_ADAPTER_CAPABILITIES)
    expect(Object.isFrozen(custom)).toBe(true)
    expect(HOLO_MINIMUM_ADAPTER_CAPABILITIES.rendering).toBe('framework-owned')
  })

  it('rejects traversal segments while resolving file-backed storage keys', () => {
    expect(adapterInternals.resolveStorageKeyPath('/tmp/holo-storage', 'nested:file.txt')).toBe(
      resolve('/tmp/holo-storage', 'nested', 'file.txt'),
    )
    expect(() => adapterInternals.resolveStorageKeyPath('/tmp/holo-storage', '..:escape.txt')).toThrow(
      'Storage paths must not contain ".." segments.',
    )
  })

  it('creates typed config accessors from a resolved project', async () => {
    const project = {
      projectRoot: '/tmp/adapter-project',
      config: {
        app: {
          name: 'Adapter App',
          env: 'development',
        },
        database: {
          defaultConnection: 'main',
          connections: {},
        },
        storage: {
          defaultDisk: 'local',
          disks: {},
        },
        custom: {
          services: {
            mailgun: {
              secret: 'typed-secret',
            },
          },
        },
        all: {
          app: {
            name: 'Adapter App',
            env: 'development',
          },
          database: {
            defaultConnection: 'main',
            connections: {},
          },
          storage: {
            defaultDisk: 'local',
            disks: {},
          },
          services: {
            mailgun: {
              secret: 'typed-secret',
            },
          },
        },
      },
      runtime: {
        useConfig: (key: string) => key === 'services.mailgun.secret'
          ? 'typed-secret'
          : { mailgun: { secret: key === 'services' ? 'typed-secret' : 'never' } },
        config: () => 'typed-secret',
      },
    } as unknown as HoloAdapterProject<{
      services: {
        mailgun: {
          secret: string
        }
      }
    }>
    const accessors = createHoloProjectAccessors(async () => project)

    await expect(accessors.getApp()).resolves.toBe(project)
    await expect(accessors.getProject()).resolves.toBe(project)
    await expect(accessors.getSession()).resolves.toBeUndefined()
    await expect(accessors.getAuth()).resolves.toBeUndefined()
    await expect(accessors.useConfig('services')).resolves.toEqual({
      mailgun: {
        secret: 'typed-secret',
      },
    })
    await expect(accessors.useConfig('services.mailgun.secret')).resolves.toBe('typed-secret')
    await expect(accessors.config('services.mailgun.secret')).resolves.toBe('typed-secret')
  })

  it('creates reusable singleton adapters with runtime-agnostic capabilities', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })

    expect(adapter.capabilities).toEqual(HOLO_MINIMUM_ADAPTER_CAPABILITIES)
    expect(adapter.internals.resolveOptions({
      projectRoot: '.',
      envName: 'test',
      preferCache: false,
    })).toEqual({
      projectRoot: resolve('.'),
      runtime: {
        envName: 'test',
        preferCache: false,
        processEnv: process.env,
      },
    })

    const root = await createProjectRoot()
    const project = await adapter.initializeProject<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'adapter-secret',
      },
    })

    expect(project.runtime.initialized).toBe(true)

    const helpers = adapter.createHelpers<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'adapter-secret',
      },
    })

    await expect(helpers.getApp()).resolves.toBe(project)
    await expect(helpers.getProject()).resolves.toBe(project)
    await expect(helpers.getSession()).resolves.toBeUndefined()
    await expect(helpers.getAuth()).resolves.toBeUndefined()
    await expect(helpers.useConfig('services')).resolves.toEqual({
      services: {
        secret: 'adapter-secret',
      },
    })
    await expect(helpers.useConfig('services.services.secret')).resolves.toBe('adapter-secret')
    await expect(helpers.config('services.services.secret')).resolves.toBe('adapter-secret')

    const otherRoot = await createProjectRoot()
    await expect(adapter.initializeProject({ projectRoot: otherRoot })).rejects.toThrow(
      `Test Holo project already initialized for "${root}".`,
    )

    const created = await adapter.createProject<{ services: { services: { secret: string } } }>({
      projectRoot: root,
      processEnv: {
        ...process.env,
        APP_SECRET: 'adapter-secret',
      },
    })
    expect(created.runtime.projectRoot).toBe(root)

    await adapter.resetProject()
    expect(adapter.internals.getState().project).toBeUndefined()
  })

  it('does not import discovered queue jobs when initializing an adapter project runtime directly by default', async () => {
    const root = await createProjectRoot()

    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await writeFile(join(root, 'server/jobs/report.ts'), 'export default { nope: true }\n', 'utf8')
    await writeFile(join(root, '.holo-js/generated/registry.json'), `${JSON.stringify({
      version: 1,
      generatedAt: new Date('2026-04-02T00:00:00.000Z').toISOString(),
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [
        {
          sourcePath: 'server/jobs/report.ts',
          name: 'report',
        },
      ],
    }, null, 2)}\n`, 'utf8')

    const loadEsbuildSpy = vi.spyOn(runtimeModuleInternals, 'loadEsbuild')
    const project = await createHoloAdapterProject(root)

    await expect(project.runtime.initialize()).resolves.toBeUndefined()
    expect(listRegisteredQueueJobs().map(job => job.name)).toEqual(['holo.events.invoke-listener'])
    expect(loadEsbuildSpy).not.toHaveBeenCalled()
  })

  it('loads discovered queue jobs when initializing an adapter project runtime directly with explicit registration', async () => {
    const root = await createProjectRoot()

    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await writeFile(join(root, 'server/jobs/report.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'ok'
  },
})
`, 'utf8')
    await writeFile(join(root, '.holo-js/generated/registry.json'), `${JSON.stringify({
      version: 1,
      generatedAt: new Date('2026-04-02T00:00:00.000Z').toISOString(),
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [
        {
          sourcePath: 'server/jobs/report.ts',
          name: 'report',
        },
      ],
    }, null, 2)}\n`, 'utf8')

    const project = await createHoloAdapterProject(root, {
      registerProjectQueueJobs: true,
    })
    await project.runtime.initialize()

    expect(listRegisteredQueueJobs().map(job => job.name)).toContain('report')
    await expect(Queue.dispatchSync<Record<string, never>, string>('report', {})).resolves.toBe('ok')
  })

  it('does not import discovered queue jobs during framework adapter initialization by default', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })
    const root = await createProjectRoot()

    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await writeFile(join(root, 'server/jobs/report.ts'), 'export default { nope: true }\n', 'utf8')
    await writeFile(join(root, '.holo-js/generated/registry.json'), `${JSON.stringify({
      version: 1,
      generatedAt: new Date('2026-04-02T00:00:00.000Z').toISOString(),
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [
        {
          sourcePath: 'server/jobs/report.ts',
          name: 'report',
        },
      ],
    }, null, 2)}\n`, 'utf8')

    const loadEsbuildSpy = vi.spyOn(runtimeModuleInternals, 'loadEsbuild')

    const project = await adapter.initializeProject({
      projectRoot: root,
    })

    expect(project.runtime.initialized).toBe(true)
    expect(listRegisteredQueueJobs().map(job => job.name)).toEqual(['holo.events.invoke-listener'])
    expect(loadEsbuildSpy).not.toHaveBeenCalled()
  })

  it('loads discovered queue jobs during framework adapter initialization with explicit registration', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })
    const root = await createProjectRoot()

    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await writeFile(join(root, 'server/jobs/report.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'ok'
  },
})
`, 'utf8')
    await writeFile(join(root, '.holo-js/generated/registry.json'), `${JSON.stringify({
      version: 1,
      generatedAt: new Date('2026-04-02T00:00:00.000Z').toISOString(),
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [
        {
          sourcePath: 'server/jobs/report.ts',
          name: 'report',
        },
      ],
    }, null, 2)}\n`, 'utf8')

    const loadEsbuildSpy = vi.spyOn(runtimeModuleInternals, 'loadEsbuild')

    const project = await adapter.initializeProject({
      projectRoot: root,
      registerProjectQueueJobs: true,
    })

    expect(project.runtime.initialized).toBe(true)
    expect(listRegisteredQueueJobs().map(job => job.name)).toContain('report')
    await expect(Queue.dispatchSync<Record<string, never>, string>('report', {})).resolves.toBe('ok')
    expect(loadEsbuildSpy).toHaveBeenCalled()
  })

  it('does not rebind storage runtime when only creating a project', async () => {
    const root = await createProjectRoot()
    const sentinelBackend = {
      getItemRaw: vi.fn(async () => null),
      setItemRaw: vi.fn(async () => {}),
      getItem: vi.fn(async () => null),
      hasItem: vi.fn(async () => false),
      removeItem: vi.fn(async () => {}),
      getKeys: vi.fn(async () => []),
    }

    configureStorageRuntime({
      getRuntimeConfig: () => ({
        holoStorage: {
          defaultDisk: 'sentinel',
          diskNames: ['sentinel'],
          routePrefix: '/storage',
          disks: {
            sentinel: {
              name: 'sentinel',
              driver: 'local',
              visibility: 'private',
              root: './storage/sentinel',
            },
          },
        },
      }),
      getStorage: () => sentinelBackend as never,
    })

    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })

    await adapter.createProject({ projectRoot: root })

    expect(useStorage('sentinel').getKeys).toBe(sentinelBackend.getKeys)
  })

  it('rehydrates the shared runtime when a cached project outlives runtime state', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })

    const root = await createProjectRoot()
    const project = await adapter.initializeProject({
      projectRoot: root,
    })

    expect(getHolo()).toBe(project.runtime)

    await resetHoloRuntime()

    expect(() => getHolo()).toThrow('Holo runtime is not initialized.')
    expect(project.runtime.initialized).toBe(false)

    const rehydrated = await adapter.createHelpers({
      projectRoot: root,
    }).getProject()

    expect(rehydrated.runtime.initialized).toBe(true)
    expect(getHolo()).toBe(rehydrated.runtime)
  })

  it('reloads the singleton project in dev mode when config files change', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })
    const root = await createProjectRoot()
    const configPath = join(root, 'config/app.ts')
    await writeConfigCache(root, {
      envName: 'development',
      processEnv: process.env,
    })

    const first = await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
      registerProjectQueueJobs: true,
    })

    expect(first.config.app.name).toBe('Adapter App')

    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))

    await writeFile(configPath, `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Reloaded App',
  env: 'development',
})
`, 'utf8')
    await writeConfigCache(root, {
      envName: 'development',
      processEnv: process.env,
    })

    const second = await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
      registerProjectQueueJobs: true,
    })

    expect(second.config.app.name).toBe('Reloaded App')
    expect(second).not.toBe(first)
  })

  it('reloads the singleton project in dev mode when discovered job sources change', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })
    const root = await createProjectRoot()

    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await writeFile(join(root, 'server/jobs/report.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'first'
  },
})
`, 'utf8')
    await writeFile(join(root, '.holo-js/generated/registry.json'), `${JSON.stringify({
      version: 1,
      generatedAt: new Date('2026-04-02T00:00:00.000Z').toISOString(),
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [
        {
          sourcePath: 'server/jobs/report.ts',
          name: 'report',
        },
      ],
    }, null, 2)}\n`, 'utf8')
    await writeConfigCache(root, {
      envName: 'development',
      processEnv: process.env,
    })

    const first = await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
      registerProjectQueueJobs: true,
    })

    await expect(Queue.dispatchSync<Record<string, never>, string>('report', {})).resolves.toBe('first')

    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))

    await writeFile(join(root, 'server/jobs/report.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'second'
  },
})
`, 'utf8')

    const second = await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
      registerProjectQueueJobs: true,
    })

    expect(second).not.toBe(first)
    await expect(Queue.dispatchSync<Record<string, never>, string>('report', {})).resolves.toBe('second')
  })

  it('picks up auth provider model changes in dev mode without restarting the process', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })
    const root = await createProjectRoot()

    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${configEntry}

export default defineSessionConfig({
  driver: 'file',
  stores: {
    file: {
      driver: 'file',
      path: './storage/framework/sessions',
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'config/auth.ts'), `
import { defineAuthConfig } from ${configEntry}

export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/models/User.ts'), `
let nextId = 1

export default {
  async find(id) {
    return id
  },
  where() {
    return {
      async first() {
        return null
      },
    }
  },
  async create(values) {
    return {
      id: nextId++,
      role: 'first',
      ...values,
    }
  },
  async update(id, values) {
    return {
      id,
      role: 'first',
      ...values,
    }
  },
}
`, 'utf8')

    const first = await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
    })

    await expect(first.runtime.auth?.register({
      email: 'first@app.test',
      password: 'secret',
      passwordConfirmation: 'secret',
    })).resolves.toMatchObject({
      role: 'first',
    })

    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))

    await writeFile(join(root, 'server/models/User.ts'), `
let nextId = 1

export default {
  async find(id) {
    return id
  },
  where() {
    return {
      async first() {
        return null
      },
    }
  },
  async create(values) {
    return {
      id: nextId++,
      role: 'second',
      ...values,
    }
  },
  async update(id, values) {
    return {
      id,
      role: 'second',
      ...values,
    }
  },
}
`, 'utf8')

    const second = await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
    })

    await expect(second.runtime.auth?.register({
      email: 'second@app.test',
      password: 'secret',
      passwordConfirmation: 'secret',
    })).resolves.toMatchObject({
      role: 'second',
    })
  })

  it('mounts the plain-node storage runtime and refreshes stale adapter runtime references', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })
    const root = await createProjectRoot()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))

      if (request.method === 'PUT') {
        return new Response(null, { status: 200 })
      }

      if (request.method === 'GET') {
        return new Response(JSON.stringify({ ok: true, key }), { status: 200 })
      }

      if (request.method === 'HEAD') {
        return new Response(null, { status: 200 })
      }

      if (request.method === 'DELETE') {
        return new Response(null, { status: 200 })
      }

      return new Response(null, { status: 500, statusText: `Unexpected method ${request.method}` })
    })
    vi.stubGlobal('fetch', fetchMock)
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${configEntry}

export default defineStorageConfig({
  defaultDisk: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
      visibility: 'private',
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

    const project = await adapter.initializeProject({
      projectRoot: root,
      preferCache: true,
    })

    const { useStorage } = await import('@holo-js/storage/runtime')
    const storage = useStorage('local') as typeof useStorage extends (...args: never[]) => infer T ? T : never
      & {
        getItemRaw(key: string): Promise<Uint8Array | null>
        setItemRaw(key: string, value: ArrayBuffer): Promise<void>
        getMeta<T = unknown>(key: string): Promise<T | null>
        setMeta(key: string, value: unknown): Promise<void>
        removeMeta(key: string): Promise<void>
        getKeys(base?: string): Promise<string[]>
        clear(base?: string): Promise<void>
        hasItem(key: string): Promise<boolean>
      }

    await expect(storage.getItemRaw('legacy:missing.bin')).resolves.toBeNull()

    const payload = Uint8Array.from([1, 2, 3, 4]).buffer
    await storage.setItemRaw('legacy:data.bin', payload)
    await storage.setMeta('legacy:data.bin', { etag: 'v1' })
    await storage.setItemRaw('legacy:json.bin', Uint8Array.from(Buffer.from(JSON.stringify({ ok: true }))))
    await storage.setItemRaw('legacy:array-buffer.bin', Uint8Array.from(Buffer.from(JSON.stringify({ raw: true }))).buffer)
    await storage.setItemRaw('legacy:buffer.bin', Buffer.from(JSON.stringify({ buffer: true })))

    expect(await storage.getMeta('legacy:data.bin')).toEqual({ etag: 'v1' })
    expect(await storage.getKeys()).toEqual(expect.arrayContaining(['legacy:data.bin', 'legacy:data.bin$']))
    expect(await storage.getKeys('legacy')).toEqual(expect.arrayContaining([
      'legacy:data.bin',
      'legacy:data.bin$',
    ]))
    expect(await storage.getItem('legacy:json.bin')).toEqual({ ok: true })
    expect(await storage.getItem('legacy:array-buffer.bin')).toEqual({ raw: true })
    expect(await storage.getItem('legacy:buffer.bin')).toEqual({ buffer: true })

    const raw = await storage.getItemRaw('legacy:data.bin')
    expect(Buffer.from(raw ?? new Uint8Array())).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(useStorage('local')).toBe(storage)
    const mediaStorage = useStorage('media')
    await expect(mediaStorage.setItem('remote:payload.json', { ok: true })).resolves.toBeUndefined()
    await expect(mediaStorage.getItem('remote:payload.json')).resolves.toEqual({
      ok: true,
      key: 'remote/payload.json',
    })
    await expect(mediaStorage.getMeta('remote:payload.json')).resolves.toEqual({})
    await expect(mediaStorage.hasItem('remote:payload.json')).resolves.toBe(true)
    await expect(mediaStorage.removeItem('remote:payload.json')).resolves.toBeUndefined()
    expect(useStorage('media')).toBe(mediaStorage)
    expect(fetchMock.mock.calls.map(([request]) => (request as Request).method)).toEqual([
      'PUT',
      'GET',
      'HEAD',
      'HEAD',
      'DELETE',
    ])
    expect((fetchMock.mock.calls[0]?.[0] as Request).url).toBe(
      'https://media-bucket.s3.us-east-1.amazonaws.com/remote/payload.json',
    )
    expect((fetchMock.mock.calls[0]?.[0] as Request).headers.get('authorization')).toContain(
      'Credential=AKIAEXAMPLE/',
    )
    expect(() => useStorage('ghost')).toThrow('Disk "ghost" is not configured.')
    await expect(storage.put('../escaped.txt', 'nope')).rejects.toThrow(
      'Storage paths must not contain ".." segments.',
    )

    await storage.removeMeta('legacy:data.bin')
    expect(await storage.getMeta('legacy:data.bin')).toBeNull()

    await storage.clear('legacy')
    expect(await storage.hasItem('legacy:data.bin')).toBe(false)

    const staleRuntime = { ...project.runtime } as typeof project.runtime
    ;(adapter.internals.getState() as { project?: typeof project }).project = {
      ...project,
      runtime: staleRuntime,
    }

    const refreshed = await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
    })

    expect(refreshed.runtime).toBe(getHolo())
    expect(adapter.internals.getState().project?.runtime).toBe(getHolo())

    await storage.clear()
    expect(await storage.getKeys()).toEqual([])
  })

  it('uses the default local storage root when a disk omits an explicit root', async () => {
    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoTestAdapter__',
      displayName: 'Test',
    })
    const root = await createProjectRoot()
    await writeFile(join(root, 'config/storage.ts'), `
import { defineStorageConfig } from ${configEntry}

export default defineStorageConfig({
  defaultDisk: 'local',
  disks: {
    local: {
      driver: 'local',
      visibility: 'private',
    },
  },
})
`, 'utf8')

    await adapter.initializeProject({
      projectRoot: root,
      preferCache: false,
    })

    const storage = useStorage('local')
    await storage.put('nested/file.txt', 'default root payload')

    await expect(readFile(resolve(root, './storage/app/nested/file.txt'), 'utf8')).resolves.toBe('default root payload')
  })
})
