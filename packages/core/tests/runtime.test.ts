import { symlinkPackageDependency } from '../../../tests/support/published-package'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRedisService } from '../../session/tests/support/redis'
import { config, loadConfigDirectory, useConfig } from '@holo-js/config'
import {
  createSchemaService,
  DB,
  getDatabaseDriverFactory,
} from '@holo-js/db'
import {
  broadcastRaw,
  normalizeBroadcastConfig,
  startBroadcastWorker,
  configureBroadcastRuntime,
  getBroadcastRuntimeBindings,
  resetBroadcastRuntime,
} from '@holo-js/broadcast'
import {
  configureNotificationsRuntime,
  defineNotification,
  getNotificationsRuntimeBindings,
  notify,
  resetNotificationsRuntime,
} from '@holo-js/notifications'
import { configureMailRuntime, listFakeSentMails, previewMail, resetFakeSentMails } from '@holo-js/mail'
import { mailRuntimeInternals } from '../../mail/src/runtime'
import {
  Event,
  defineEvent,
  defineListener,
  listRegisteredEvents,
  listRegisteredListeners,
  registerEvent,
  registerListener,
  resetEventsRegistry,
} from '@holo-js/events'
import {
  configureQueueRuntime,
  getQueueRuntime,
  listFailedQueueJobs,
  listRegisteredQueueJobs,
  persistFailedQueueJob,
  Queue,
  queueRuntimeInternals,
  registerQueueJob,
  resetQueueRegistry,
  holoQueueDefaults,
  normalizeQueueConfig,
} from '@holo-js/queue'
import {
  configureSecurityRuntime,
  createMemoryRateLimitStore,
  defaultRateLimitKey,
  limit,
  protect,
  rateLimit,
  getSecurityRuntimeBindings,
  resetSecurityRuntime,
} from '@holo-js/security'
import type * as PortableHoloModule from '../src/portable/holo'
import { createHoloAdapterProject, createHoloFrameworkAdapter, initializeHoloAdapterProject } from '../src'
import {
  configureHoloRenderingRuntime,
  createHolo,
  getHolo,
  ensureHolo,
  initializeHolo,
  loadGeneratedProjectRegistry,
  peekHolo,
  reconfigureOptionalHoloSubsystems,
  registryInternals,
  resetHoloRuntime,
  resolveGeneratedProjectRegistryPath,
  holoRuntimeInternals,
} from '../src/portable'
import { configureSessionRuntime, createFileSessionStore, getSessionRuntime, normalizeSessionConfig } from '@holo-js/session'
import { configureAuthRuntime, createAsyncAuthContext, getAuthRuntime, normalizeAuthConfig } from '@holo-js/auth'
import { useStorage } from '@holo-js/storage/runtime'
import * as sessionModule from '@holo-js/session'
import { holoStorageDefaults, normalizeStorageConfig } from '@holo-js/storage'

const packageEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const authPackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../auth/src/index.ts'))
const broadcastPackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../broadcast/src/index.ts'))
const cachePackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../cache/src/index.ts'))
const databasePackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/index.ts'))
const mailPackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../mail/src/index.ts'))
const queuePackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../queue/src/index.ts'))
const sessionPackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../session/src/index.ts'))
const kernelPackageEntry = JSON.stringify(resolve(import.meta.dirname, '../../kernel/src/index.ts'))
const tempDirs: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-runtime-'))
  tempDirs.push(root)
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../../broadcast'), join(root, 'node_modules/@holo-js/broadcast'))
  await symlink(resolve(import.meta.dirname, '../../db-mysql'), join(root, 'node_modules/@holo-js/db-mysql'))
  await symlink(resolve(import.meta.dirname, '../../db-postgres'), join(root, 'node_modules/@holo-js/db-postgres'))
  await symlink(resolve(import.meta.dirname, '../../db-sqlite'), join(root, 'node_modules/@holo-js/db-sqlite'))
  await symlink(resolve(import.meta.dirname, '../../db'), join(root, 'node_modules/@holo-js/db'))
  await symlink(resolve(import.meta.dirname, '../../security'), join(root, 'node_modules/@holo-js/security'))
  await symlink(resolve(import.meta.dirname, '../../queue-db'), join(root, 'node_modules/@holo-js/queue-db'))
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await mkdir(join(root, 'server/db/migrations'), { recursive: true })
  await mkdir(join(root, 'server/db/seeders'), { recursive: true })
  await mkdir(join(root, 'server/commands'), { recursive: true })
  await mkdir(join(root, 'server/jobs'), { recursive: true })
  await mkdir(join(root, 'server/events'), { recursive: true })
  await mkdir(join(root, 'server/listeners'), { recursive: true })
  return root
}

async function createNotificationTable(): Promise<void> {
  await createSchemaService(DB.connection()).createTable('notifications', (table) => {
      table.string('id').primaryKey()
      table.string('type').nullable()
      table.string('notifiable_type')
      table.string('notifiable_id')
      table.json('data').default({})
      table.timestamp('read_at').nullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')
      table.index(['notifiable_type', 'notifiable_id'])
      table.index(['read_at'])
    })

}

async function writeBaseConfig(root: string, databaseUrl = ':memory:'): Promise<void> {
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Runtime App',
  key: 'base64:key',
  url: 'https://runtime.test',
  debug: false,
  env: 'production',
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databasePackageEntry}

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: ${JSON.stringify(databaseUrl)},
      logging: false,
    },
  },
})
`, 'utf8')
}

async function writeServicesConfig(root: string): Promise<void> {
  await writeFile(join(root, '.env'), 'MAILGUN_SECRET=super-secret\n', 'utf8')
  await writeFile(join(root, 'config/services.ts'), `
import { defineConfig, env } from ${packageEntry}

export default defineConfig({
  mailgun: {
    secret: env('MAILGUN_SECRET'),
  },
})
`, 'utf8')
}

async function writeCacheConfig(root: string, contents = `
import { defineCacheConfig } from ${cachePackageEntry}

export default defineCacheConfig({
  default: 'memory',
  stores: {
    memory: {
      driver: 'memory',
    },
  },
})
`): Promise<void> {
  await writeFile(join(root, 'config/cache.ts'), contents, 'utf8')
}

async function writeQueueConfig(root: string, contents: string): Promise<void> {
  await writeFile(join(root, 'config/queue.ts'), contents, 'utf8')
}

async function writeRuntimePluginPackage(root: string, packageName: string, pluginContents: string, files: Record<string, string>): Promise<void> {
  const packageRoot = join(root, 'node_modules', ...packageName.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    holo: {
      plugin: './plugin.mjs',
    },
  }, null, 2), 'utf8')
  await writeFile(join(packageRoot, 'plugin.mjs'), pluginContents, 'utf8')

  for (const [fileName, contents] of Object.entries(files)) {
    await writeFile(join(packageRoot, fileName), contents, 'utf8')
  }
}

async function writeNotificationsConfig(root: string, contents?: string): Promise<void> {
  await symlinkPackageDependency(join(root, 'node_modules'), '@holo-js/notifications', resolve(import.meta.dirname, '../../notifications'))
  await writeFile(join(root, 'config/notifications.ts'), contents ?? `
import { defineNotificationsConfig } from '@holo-js/notifications'

export default defineNotificationsConfig({
  table: 'notifications',
})
`, 'utf8')
}

async function writeBroadcastConfig(root: string, contents?: string): Promise<void> {
  await writeFile(join(root, 'config/broadcast.ts'), contents ?? `
import { defineBroadcastConfig } from ${broadcastPackageEntry}

export default defineBroadcastConfig({
  default: 'log',
  connections: {
    log: {
      driver: 'log',
    },
  },
})
`, 'utf8')
}

async function writeMailConfig(root: string, contents?: string): Promise<void> {
  await writeFile(join(root, 'config/mail.ts'), contents ?? `
import { defineMailConfig } from ${mailPackageEntry}

export default defineMailConfig({
  default: 'fake',
  from: {
    email: 'noreply@app.test',
    name: 'Runtime App',
  },
  mailers: {
    fake: {
      driver: 'fake',
    },
  },
})
`, 'utf8')
}

async function writeSecurityConfig(root: string, contents?: string): Promise<void> {
  await writeFile(join(root, 'config/security.ts'), contents ?? `
import { defineSecurityConfig, ip, limit } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: {
    enabled: true,
  },
  rateLimit: {
    driver: 'file',
    file: {
      path: './storage/framework/rate-limits',
    },
    limiters: {
      login: limit.perMinute(5).by(({ request }) => ip(request)),
    },
  },
})
`, 'utf8')
}

async function writeRedisConfig(root: string, contents?: string): Promise<void> {
  await writeFile(join(root, 'config/redis.ts'), contents ?? `
import { defineRedisConfig } from ${kernelPackageEntry}

export default defineRedisConfig({
  default: 'default',
  connections: {
    default: {
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    },
  },
})
`, 'utf8')
}

async function writeAuthConfig(root: string): Promise<void> {
  await writeFile(join(root, 'config/auth.ts'), `
import { defineAuthConfig } from ${authPackageEntry}

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
  await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}

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
}

async function writeUserModel(root: string): Promise<void> {
  await writeFile(join(root, 'server/models/User.ts'), `
import { column, defineGeneratedTable, defineModel } from '@holo-js/db'

export default defineModel(defineGeneratedTable('users', {
  id: column.id(),
  name: column.string(),
  email: column.string(),
  password: column.string(),
}), {
  timestamps: false,
  fillable: ['name', 'email', 'password'],
  hidden: ['password'],
})
`, 'utf8')
}

async function writeRegistry(
  root: string,
  options: {
    readonly models?: readonly Record<string, unknown>[]
    readonly jobs?: readonly Record<string, unknown>[]
    readonly events?: readonly Record<string, unknown>[]
    readonly listeners?: readonly Record<string, unknown>[]
  } = {},
): Promise<void> {
  const registryPath = resolveGeneratedProjectRegistryPath(root)
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  await writeFile(registryPath, `${JSON.stringify({
    version: 1,
    generatedAt: '2026-03-31T00:00:00.000Z',
    paths: {
      models: 'server/models',
      migrations: 'server/db/migrations',
      seeders: 'server/db/seeders',
      commands: 'server/commands',
      jobs: 'server/jobs',
      events: 'server/events',
      listeners: 'server/listeners',
      generatedSchema: 'server/db/schema.ts',
    },
    models: options.models ?? [
      {
        sourcePath: 'server/models/User.ts',
        name: 'User',
        prunable: false,
      },
    ],
    migrations: [],
    seeders: [],
    commands: [
      {
        sourcePath: 'server/commands/Inspire.ts',
        name: 'inspire',
        aliases: ['about'],
        description: 'Show inspiration',
      },
    ],
    jobs: options.jobs ?? [],
    events: options.events ?? [],
    listeners: options.listeners ?? [],
  }, null, 2)}\n`, 'utf8')
}

afterEach(async () => {
  await resetHoloRuntime()
  resetFakeSentMails()
  resetBroadcastRuntime()
  resetNotificationsRuntime()
  resetSecurityRuntime()
  resetQueueRegistry()
  resetEventsRegistry()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/core portable runtime', () => {
  it.each([
    ['America/New_York', 'America/New_York', '2026-07-15T16:00:00.000Z'],
    ['UTC', 'UTC', '2026-07-15T12:00:00.000Z'],
    [undefined, 'UTC', '2026-07-15T12:00:00.000Z'],
  ])('applies APP_TIMEZONE %s during startup and restores the host timezone during shutdown', async (timezone, expectedTimezone, expectedDate) => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    await writeFile(join(root, '.env'), timezone === undefined ? '' : `APP_TIMEZONE=${timezone}\n`, 'utf8')
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  timezone: env('APP_TIMEZONE', 'UTC'),
})
`, 'utf8')
    const originalTimezone = process.env.TZ
    const originalOffset = new Date('2026-07-15T16:00:00Z').getTimezoneOffset()
    const runtime = await createHolo(root, { processEnv: {} })

    expect(process.env.TZ).toBe(originalTimezone)
    await runtime.initialize()

    expect(config('app.timezone')).toBe(expectedTimezone)
    expect(new Date('2026-07-15T12:00:00').toISOString()).toBe(expectedDate)
    expect(new Intl.DateTimeFormat('en').resolvedOptions().timeZone).toBe(expectedTimezone)
    await runtime.shutdown()

    expect(process.env.TZ).toBe(originalTimezone)
    expect(new Date('2026-07-15T16:00:00Z').getTimezoneOffset()).toBe(originalOffset)
  })

  it('creates and initializes the runtime from config files and generated registries', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeServicesConfig(root)
    await writeRegistry(root)

    const runtime = await createHolo<{
      services: {
        mailgun: {
          secret: string
        }
      }
    }>(root)

    expect(runtime.projectRoot).toBe(root)
    expect(runtime.initialized).toBe(false)
    expect(runtime.registry?.commands[0]?.name).toBe('inspire')
    expect(runtime.useConfig('services').mailgun.secret).toBe('super-secret')
    expect(runtime.useConfig('services.mailgun.secret')).toBe('super-secret')
    expect(runtime.config('services.mailgun.secret')).toBe('super-secret')
    expect(runtime.useConfig('storage').defaultDisk).toBe('local')
    expect(() => holoRuntimeInternals.getConfigValue('services.mailgun.secret')).toThrow('Holo config runtime is not configured.')
    expect(() => holoRuntimeInternals.getConfigSection('services')).toThrow('Holo config runtime is not configured.')

    await runtime.initialize()

    expect(runtime.initialized).toBe(true)
    expect(getHolo()).toBe(runtime)
    expect(useConfig('services')).toEqual({
      mailgun: {
        secret: 'super-secret',
      },
    })
    expect(useConfig('services.mailgun.secret')).toBe('super-secret')
    expect(config('services.mailgun.secret')).toBe('super-secret')
    expect(holoRuntimeInternals.getConfigSection('services')).toEqual({
      mailgun: {
        secret: 'super-secret',
      },
    })
    expect(holoRuntimeInternals.getConfigValue('services.mailgun.secret')).toBe('super-secret')
    expect(DB.getManager()).toBe(runtime.manager)
    expect(runtime.queue).toEqual(getQueueRuntime())
    expect(Queue.connection().name).toBe('sync')
    expect(queueRuntimeInternals.getQueueRuntimeState().config.default).toBe('sync')
    await useStorage('local').setItem('runtime:storage-check', { ok: true })
    await expect(useStorage('local').getItem('runtime:storage-check')).resolves.toEqual({ ok: true })
    const firstWrite = async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('bounded-local-stream')
    }
    await expect(useStorage('local').writeStream('runtime/stream.bin', firstWrite(), { overwrite: false })).resolves.toBe(true)
    await expect(useStorage('local').writeStream('runtime/stream.bin', firstWrite(), { overwrite: false })).resolves.toBe(false)
    const localStream = await useStorage('local').readStream('runtime/stream.bin', { chunkBytes: 4096 })
    const localChunks: Uint8Array[] = []
    for await (const chunk of localStream ?? []) localChunks.push(chunk)
    expect(Buffer.concat(localChunks).toString()).toBe('bounded-local-stream')
    const outsideStoragePath = join(root, 'outside-storage.txt')
    await writeFile(outsideStoragePath, 'outside-storage-root')
    await symlink(outsideStoragePath, join(root, 'storage/app/runtime/escape.bin'))
    await expect(useStorage('local').get('runtime/escape.bin')).rejects.toThrow(
      'Storage paths must stay inside the configured disk root.',
    )
    await expect(useStorage('local').readStream('runtime/escape.bin')).rejects.toThrow(
      'Storage paths must stay inside the configured disk root.',
    )
    await useStorage('local').writeStream('runtime/deferred.bin', firstWrite())
    const deferredStream = await useStorage('local').readStream('runtime/deferred.bin')
    await rm(join(root, 'storage/app/runtime/deferred.bin'))
    await expect(async () => {
      for await (const _chunk of deferredStream ?? []) {
        throw new Error('The removed stream should not yield data.')
      }
    }).rejects.toThrow('ENOENT')
    await writeFile(join(root, 'storage/app/not-a-directory'), 'file')
    await expect(useStorage('local').listFiles('not-a-directory')).rejects.toThrow('File pagination failed')

    registerQueueJob({
      async handle() {},
    }, {
      name: 'jobs.runtime-cleanup',
    })
    expect(listRegisteredQueueJobs().map(job => job.name)).toContain('jobs.runtime-cleanup')

    await runtime.shutdown()

    expect(runtime.initialized).toBe(false)
    expect(() => getHolo()).toThrow('Holo runtime is not initialized.')
    expect(() => useConfig('app')).toThrow('Holo config runtime is not configured.')
    expect(() => useStorage('local')).toThrow('Storage runtime is not configured.')
    expect(queueRuntimeInternals.getQueueRuntimeState().config.default).toBe('sync')
    expect(listRegisteredQueueJobs().map(job => job.name)).toContain('jobs.runtime-cleanup')
  })

  it('supports the global initialize and reset helpers', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    const runtime = await initializeHolo(root)

    expect(getHolo()).toBe(runtime)

    await resetHoloRuntime()

    expect(() => getHolo()).toThrow('Holo runtime is not initialized.')
  })

  it('rethrows non-module-resolution errors from optional imports', async () => {
    const root = await createProject()
    const brokenModulePath = join(root, 'broken-optional-module.mjs')
    await writeFile(brokenModulePath, 'export default {\n', 'utf8')

    await expect(
      holoRuntimeInternals.moduleInternals.importOptionalModule(pathToFileURL(brokenModulePath).href),
    ).rejects.toThrow()
  })

  it('treats ERR_MODULE_NOT_FOUND optional imports as absent modules', async () => {
    await expect(
      holoRuntimeInternals.moduleInternals.importOptionalModule('missing-optional-module'),
    ).resolves.toBeUndefined()
  })

  it('treats resolved optional-import load failures as absent modules', async () => {
    const root = await createProject()
    const packageDir = join(root, 'node_modules', 'resolved-optional-module')

    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: 'resolved-optional-module',
      type: 'module',
      exports: './missing.mjs',
    }), 'utf8')

    await expect(
      holoRuntimeInternals.moduleInternals.importOptionalModule('resolved-optional-module', {
        projectRoot: root,
      }),
    ).resolves.toBeUndefined()
  })

  it('rethrows optional imports when the missing module is only a transitive dependency', async () => {
    const root = await createProject()
    const packageDir = join(root, 'node_modules', 'resolved-optional-module')

    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: 'resolved-optional-module',
      type: 'module',
      exports: './index.mjs',
    }), 'utf8')
    await writeFile(join(packageDir, 'index.mjs'), `
import 'missing-transitive-dependency'

export default {}
`, 'utf8')

    await expect(
      holoRuntimeInternals.moduleInternals.importOptionalModule('resolved-optional-module', {
        projectRoot: root,
      }),
    ).rejects.toThrow(/missing-transitive-dependency/)
  })

  it('does not import discovered queue jobs when runtime queue registration is disabled', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/bad'), { recursive: true })
    await writeFile(join(root, 'server/jobs/bad/malformed.ts'), 'export default { nope: true }\n', 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/bad/malformed.ts',
        name: 'bad.malformed',
        connection: 'sync',
        queue: 'default',
      }],
    })

    const runtime = await initializeHolo(root, {
      registerProjectQueueJobs: false,
    })

    expect(listRegisteredQueueJobs().map(job => job.name)).toEqual(['holo.events.invoke-listener'])

    await runtime.shutdown()
  })

  it('registers discovered events and listeners during runtime initialization', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/events/user'), { recursive: true })
    await mkdir(join(root, 'server/events/audit'), { recursive: true })
    await mkdir(join(root, 'server/listeners/user'), { recursive: true })
    await mkdir(join(root, 'server/listeners/audit'), { recursive: true })
    await writeFile(join(root, 'server/events/user/registered.ts'), `
import { defineEvent } from '@holo-js/events'

export default defineEvent({
  name: 'user.registered',
})
`, 'utf8')
    await writeFile(join(root, 'server/events/audit/activity.ts'), `
import { defineEvent } from '@holo-js/events'

export default defineEvent({})
`, 'utf8')
    await writeFile(join(root, 'server/listeners/user/send-welcome.ts'), `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  async handle(event: { payload: { value: number } }) {
    globalThis.__holoRuntimeEventHits__ ??= []
    globalThis.__holoRuntimeEventHits__.push(event.payload.value * 2)
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/listeners/audit/record-activity.ts'), `
import { defineListener } from '@holo-js/events'
import ActivityRecorded from '../../events/audit/activity'

export default defineListener({
  listensTo: [ActivityRecorded],
  async handle(event: { payload: { value: number } }) {
    globalThis.__holoRuntimeDerivedEventHits__ ??= []
    globalThis.__holoRuntimeDerivedEventHits__.push(event.payload.value + 1)
  },
})
`, 'utf8')
    await writeRegistry(root, {
      events: [
        {
          sourcePath: 'server/events/user/registered.ts',
          name: 'user.registered',
          exportName: 'default',
        },
        {
          sourcePath: 'server/events/audit/activity.ts',
          name: 'audit.activity',
          exportName: 'default',
        },
      ],
      listeners: [
        {
          sourcePath: 'server/listeners/user/send-welcome.ts',
          id: 'user.send-welcome',
          eventNames: ['user.registered'],
          exportName: 'default',
        },
        {
          sourcePath: 'server/listeners/audit/record-activity.ts',
          id: 'audit.record-activity',
          eventNames: ['audit.activity'],
          exportName: 'default',
        },
      ],
    })

    const runtime = await initializeHolo(root)

    expect(listRegisteredEvents().map(entry => entry.name)).toContain('user.registered')
    expect(listRegisteredListeners().map(entry => entry.id)).toContain('user.send-welcome')
    await expect(Event.dispatch('user.registered', { value: 21 }).dispatch()).resolves.toMatchObject({
      eventName: 'user.registered',
      syncListeners: 1,
    })
    await expect(Event.dispatch('audit.activity', { value: 10 }).dispatch()).resolves.toMatchObject({
      eventName: 'audit.activity',
      syncListeners: 1,
    })
    expect((globalThis as typeof globalThis & { __holoRuntimeEventHits__?: number[] }).__holoRuntimeEventHits__).toEqual([42])
    expect((globalThis as typeof globalThis & { __holoRuntimeDerivedEventHits__?: number[] }).__holoRuntimeDerivedEventHits__).toEqual([11])

    await runtime.shutdown()

    expect(listRegisteredEvents().map(entry => entry.name)).not.toContain('user.registered')
    expect(listRegisteredEvents().map(entry => entry.name)).not.toContain('audit.activity')
    expect(listRegisteredListeners().map(entry => entry.id)).not.toContain('user.send-welcome')
    expect(listRegisteredListeners().map(entry => entry.id)).not.toContain('audit.record-activity')
    delete (globalThis as typeof globalThis & { __holoRuntimeEventHits__?: number[] }).__holoRuntimeEventHits__
    delete (globalThis as typeof globalThis & { __holoRuntimeDerivedEventHits__?: number[] }).__holoRuntimeDerivedEventHits__
  })

  it('integrates discovered events with queued and after-commit listeners through queue and DB transaction boundaries', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/events/user'), { recursive: true })
    await mkdir(join(root, 'server/listeners/user'), { recursive: true })
    await writeFile(join(root, 'server/events/user/registered.ts'), `
import { defineEvent } from '@holo-js/events'

export default defineEvent({
  name: 'user.registered',
})
`, 'utf8')
    await writeFile(join(root, 'server/listeners/user/audit-sync.ts'), `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  async handle(event: { payload: { token: string } }) {
    globalThis.__holoRuntimeEventHits__ ??= []
    globalThis.__holoRuntimeEventHits__.push(\`sync:\${event.payload.token}\`)
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/listeners/user/audit-queue.ts'), `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  afterCommit: true,
  async handle(event: { payload: { token: string } }) {
    globalThis.__holoRuntimeEventHits__ ??= []
    globalThis.__holoRuntimeEventHits__.push(\`queued:\${event.payload.token}\`)
  },
})
`, 'utf8')
    await writeRegistry(root, {
      events: [{
        sourcePath: 'server/events/user/registered.ts',
        name: 'user.registered',
        exportName: 'default',
      }],
      listeners: [
        {
          sourcePath: 'server/listeners/user/audit-sync.ts',
          id: 'user.audit-sync',
          eventNames: ['user.registered'],
          exportName: 'default',
        },
        {
          sourcePath: 'server/listeners/user/audit-queue.ts',
          id: 'user.audit-queue',
          eventNames: ['user.registered'],
          exportName: 'default',
        },
      ],
    })

    const runtime = await initializeHolo(root)

    await DB.transaction(async () => {
      const dispatchResult = await Event.dispatch('user.registered', {
        token: 'tx-commit',
      }).dispatch()

      expect(dispatchResult).toMatchObject({
        eventName: 'user.registered',
        deferred: true,
        syncListeners: 1,
        queuedListeners: 1,
      })
      expect((globalThis as typeof globalThis & { __holoRuntimeEventHits__?: string[] }).__holoRuntimeEventHits__).toEqual([
        'sync:tx-commit',
      ])
    })

    expect((globalThis as typeof globalThis & { __holoRuntimeEventHits__?: string[] }).__holoRuntimeEventHits__).toEqual([
      'sync:tx-commit',
      'queued:tx-commit',
    ])

    await expect(DB.transaction(async () => {
      const dispatchResult = await Event.dispatch('user.registered', {
        token: 'tx-rollback',
      }).dispatch()

      expect(dispatchResult).toMatchObject({
        eventName: 'user.registered',
        deferred: true,
        syncListeners: 1,
        queuedListeners: 1,
      })
      expect((globalThis as typeof globalThis & { __holoRuntimeEventHits__?: string[] }).__holoRuntimeEventHits__).toEqual([
        'sync:tx-commit',
        'queued:tx-commit',
        'sync:tx-rollback',
      ])

      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    expect((globalThis as typeof globalThis & { __holoRuntimeEventHits__?: string[] }).__holoRuntimeEventHits__).toEqual([
      'sync:tx-commit',
      'queued:tx-commit',
      'sync:tx-rollback',
    ])

    await runtime.shutdown()
    expect(listRegisteredEvents().map(entry => entry.name)).toEqual([])
    expect(listRegisteredListeners().map(entry => entry.id)).toEqual([])
    delete (globalThis as typeof globalThis & { __holoRuntimeEventHits__?: string[] }).__holoRuntimeEventHits__
  })

  it('fails runtime initialization when a discovered listener export is malformed', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/events/user'), { recursive: true })
    await mkdir(join(root, 'server/listeners/user'), { recursive: true })
    await writeFile(join(root, 'server/events/user/registered.ts'), `
import { defineEvent } from '@holo-js/events'

export default defineEvent({
  name: 'user.registered',
})
`, 'utf8')
    await writeFile(join(root, 'server/listeners/user/bad.ts'), 'export default { nope: true }\n', 'utf8')
    await writeRegistry(root, {
      events: [{
        sourcePath: 'server/events/user/registered.ts',
        name: 'user.registered',
        exportName: 'default',
      }],
      listeners: [{
        sourcePath: 'server/listeners/user/bad.ts',
        id: 'user.bad',
        eventNames: ['user.registered'],
        exportName: 'default',
      }],
    })

    await expect(initializeHolo(root)).rejects.toThrow(
      'Discovered listener "server/listeners/user/bad.ts" does not export a Holo listener.',
    )
    expect(listRegisteredEvents()).toEqual([])
    expect(listRegisteredListeners()).toEqual([])
  })

  it('fails runtime initialization when a discovered event export is malformed', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/events/user'), { recursive: true })
    await writeFile(join(root, 'server/events/user/bad.ts'), 'export default { nope: true }\n', 'utf8')
    await writeRegistry(root, {
      events: [{
        sourcePath: 'server/events/user/bad.ts',
        name: 'user.bad',
        exportName: 'default',
      }],
    })

    await expect(initializeHolo(root)).rejects.toThrow(
      'Discovered event "server/events/user/bad.ts" does not export a Holo event.',
    )
    expect(listRegisteredEvents()).toEqual([])
  })

  it('does not replace manually registered events or listeners during runtime boot', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/events/user'), { recursive: true })
    await mkdir(join(root, 'server/listeners/user'), { recursive: true })
    await writeFile(join(root, 'server/events/user/registered.ts'), `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`, 'utf8')
    await writeFile(join(root, 'server/listeners/user/send-welcome.ts'), `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'
export default defineListener({
  listensTo: [UserRegistered],
  async handle() {},
})
`, 'utf8')
    await writeRegistry(root, {
      events: [{
        sourcePath: 'server/events/user/registered.ts',
        name: 'user.registered',
        exportName: 'default',
      }],
      listeners: [{
        sourcePath: 'server/listeners/user/send-welcome.ts',
        id: 'user.send-welcome',
        eventNames: ['user.registered'],
        exportName: 'default',
      }],
    })

    registerEvent(defineEvent({ name: 'user.registered' }), { name: 'user.registered' })
    registerListener(defineListener({
      name: 'user.send-welcome',
      listensTo: ['user.registered'],
      async handle() {},
    }), { id: 'user.send-welcome' })

    const runtime = await initializeHolo(root)

    expect(listRegisteredEvents().find(entry => entry.name === 'user.registered')?.sourcePath).toBeUndefined()
    expect(listRegisteredListeners().find(entry => entry.id === 'user.send-welcome')?.sourcePath).toBeUndefined()

    await runtime.shutdown()
  })

  it('replaces previously discovered source-backed events and listeners during runtime boot', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/events/user'), { recursive: true })
    await mkdir(join(root, 'server/listeners/user'), { recursive: true })
    await writeFile(join(root, 'server/events/user/registered.ts'), `
import { defineEvent } from '@holo-js/events'
export default defineEvent({ name: 'user.registered' })
`, 'utf8')
    await writeFile(join(root, 'server/listeners/user/send-welcome.ts'), `
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'
export default defineListener({
  listensTo: [UserRegistered],
  async handle() {},
})
`, 'utf8')
    await writeRegistry(root, {
      events: [{
        sourcePath: 'server/events/user/registered.ts',
        name: 'user.registered',
        exportName: 'default',
      }],
      listeners: [{
        sourcePath: 'server/listeners/user/send-welcome.ts',
        id: 'user.send-welcome',
        eventNames: ['user.registered'],
        exportName: 'default',
      }],
    })

    registerEvent(defineEvent({ name: 'user.registered' }), {
      name: 'user.registered',
      sourcePath: 'server/events/user/registered.ts',
    })
    registerListener(defineListener({
      name: 'user.send-welcome',
      listensTo: ['user.registered'],
      async handle() {},
    }), {
      id: 'user.send-welcome',
      sourcePath: 'server/listeners/user/send-welcome.ts',
    })

    const runtime = await initializeHolo(root)

    expect(listRegisteredEvents().find(entry => entry.name === 'user.registered')?.sourcePath).toBe('server/events/user/registered.ts')
    expect(listRegisteredListeners().find(entry => entry.id === 'user.send-welcome')?.sourcePath).toBe('server/listeners/user/send-welcome.ts')

    await runtime.shutdown()
  })

  it('registers discovered default-export and named-export queue jobs during runtime initialization when explicitly enabled', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    await mkdir(join(root, 'server/jobs/cache'), { recursive: true })
    await writeFile(join(root, 'server/jobs/reports/send-digest.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle(payload: { value: number }) {
    return payload.value * 2
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/jobs/cache/prune.ts'), `
import { defineJob } from '@holo-js/queue'

export const pruneCache = defineJob({
  async handle() {
    return 'done'
  },
})
`, 'utf8')
    await writeRegistry(root, {
      jobs: [
        {
          sourcePath: 'server/jobs/reports/send-digest.ts',
          name: 'reports.send-digest',
          connection: 'sync',
          queue: 'default',
        },
        {
          sourcePath: 'server/jobs/cache/prune.ts',
          name: 'cache.prune',
          connection: 'sync',
          queue: 'default',
        },
      ],
    })

    const runtime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })

    expect(listRegisteredQueueJobs().map(job => job.name)).toEqual(expect.arrayContaining([
      'reports.send-digest',
      'cache.prune',
    ]))
    await expect(Queue.dispatchSync('reports.send-digest', { value: 21 })).resolves.toBe(42)
    await expect(Queue.dispatchSync('cache.prune', {})).resolves.toBe('done')

    await runtime.shutdown()
  })

  it('loads discovered TypeScript queue jobs that rely on project path aliases', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/support'), { recursive: true })
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    await writeFile(join(root, 'server/jobs/support/message.ts'), `
export function buildMessage(value: number) {
  return value * 3
}
`, 'utf8')
    await writeFile(join(root, 'server/jobs/reports/aliased.ts'), `
import { defineJob } from '@holo-js/queue'
import { buildMessage } from '@/server/jobs/support/message'

export default defineJob({
  async handle(payload: { value: number }) {
    return buildMessage(payload.value)
  },
})
`, 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/reports/aliased.ts',
        name: 'reports.aliased',
        connection: 'sync',
        queue: 'default',
      }],
    })

    const runtime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })

    await expect(Queue.dispatchSync('reports.aliased', { value: 14 })).resolves.toBe(42)

    await runtime.shutdown()
  })

  it('registers discovered queue jobs using the registry name for custom job roots', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'queue'), { recursive: true })
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Runtime App',
  key: 'base64:key',
  url: 'https://runtime.test',
  debug: false,
  env: 'production',
  paths: {
    jobs: 'queue',
  },
})
`, 'utf8')
    await writeFile(join(root, 'queue/send-email.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'custom-root'
  },
})
`, 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'queue/send-email.ts',
        name: 'send-email',
        connection: 'sync',
        queue: 'default',
      }],
    })

    const runtime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })

    expect(listRegisteredQueueJobs().map(job => job.name)).toContain('send-email')
    expect(listRegisteredQueueJobs().map(job => job.name)).not.toContain('queue.send-email')
    await expect(Queue.dispatchSync('send-email', {})).resolves.toBe('custom-root')

    await runtime.shutdown()
  })

  it('fails runtime initialization when an explicitly enabled discovered queue job does not export a Holo job', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/bad'), { recursive: true })
    await writeFile(join(root, 'server/jobs/bad/malformed.ts'), 'export default { nope: true }\n', 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/bad/malformed.ts',
        name: 'bad.malformed',
        connection: 'sync',
        queue: 'default',
      }],
    })

    await expect(initializeHolo(root, {
      registerProjectQueueJobs: true,
    })).rejects.toThrow(
      'Discovered job "server/jobs/bad/malformed.ts" does not export a Holo job.',
    )
    expect(listRegisteredQueueJobs().map(job => job.name)).toEqual(['holo.events.invoke-listener'])
  })

  it('cleans up previously registered discovered jobs when runtime initialization fails mid-load', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    await writeFile(join(root, 'server/jobs/reports/good.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'good'
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/jobs/reports/bad.ts'), 'export default { nope: true }\n', 'utf8')
    await writeRegistry(root, {
      jobs: [
        {
          sourcePath: 'server/jobs/reports/good.ts',
          name: 'reports.good',
          connection: 'sync',
          queue: 'default',
        },
        {
          sourcePath: 'server/jobs/reports/bad.ts',
          name: 'reports.bad',
          connection: 'sync',
          queue: 'default',
        },
      ],
    })

    await expect(initializeHolo(root, {
      registerProjectQueueJobs: true,
    })).rejects.toThrow(
      'Discovered job "server/jobs/reports/bad.ts" does not export a Holo job.',
    )
    expect(listRegisteredQueueJobs().map(job => job.name)).toEqual(['holo.events.invoke-listener'])
  })

  it('skips importing a discovered queue job when that job is already registered', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    await writeFile(join(root, 'server/jobs/reports/send-digest.ts'), 'export default { nope: true }\n', 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/reports/send-digest.ts',
        name: 'reports.send-digest',
        connection: 'sync',
        queue: 'default',
      }],
    })

    registerQueueJob({
      async handle() {
        return 'manual'
      },
    }, {
      name: 'reports.send-digest',
    })

    const runtime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })
    await expect(Queue.dispatchSync('reports.send-digest', {})).resolves.toBe('manual')
    await runtime.shutdown()
  })

  it('replaces stale discovered jobs that were already registered from a source path', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    await writeFile(join(root, 'server/jobs/reports/send-digest.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'project-version'
  },
})
`, 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/reports/send-digest.ts',
        name: 'reports.send-digest',
        connection: 'sync',
        queue: 'default',
      }],
    })

    registerQueueJob({
      async handle() {
        return 'stale-version'
      },
    }, {
      name: 'reports.send-digest',
      sourcePath: 'server/jobs/reports/send-digest.ts',
    })

    const runtime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })

    await expect(Queue.dispatchSync('reports.send-digest', {})).resolves.toBe('project-version')

    await runtime.shutdown()
  })

  it('reloads discovered queue jobs when the project is reinitialized with updated sources', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    const jobPath = join(root, 'server/jobs/reports/send-digest.ts')
    await writeFile(jobPath, `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'first-version'
  },
})
`, 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/reports/send-digest.ts',
        name: 'reports.send-digest',
        connection: 'sync',
        queue: 'default',
      }],
    })

    const firstRuntime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })
    await expect(Queue.dispatchSync('reports.send-digest', {})).resolves.toBe('first-version')
    await firstRuntime.shutdown()

    await writeFile(jobPath, `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'second-version'
  },
})
`, 'utf8')

    const secondRuntime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })
    await expect(Queue.dispatchSync('reports.send-digest', {})).resolves.toBe('second-version')
    await secondRuntime.shutdown()
  })

  it('removes discovered queue jobs from the global registry when the runtime shuts down', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    await writeFile(join(root, 'server/jobs/reports/send-digest.ts'), `
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle() {
    return 'runtime-owned'
  },
})
`, 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/reports/send-digest.ts',
        name: 'reports.send-digest',
        connection: 'sync',
        queue: 'default',
      }],
    })

    registerQueueJob({
      async handle() {
        return 'manual'
      },
    }, {
      name: 'jobs.manual',
    })

    const runtime = await initializeHolo(root, {
      registerProjectQueueJobs: true,
    })

    expect(listRegisteredQueueJobs().map(job => job.name)).toEqual(expect.arrayContaining([
      'jobs.manual',
      'reports.send-digest',
    ]))

    await runtime.shutdown()

    expect(listRegisteredQueueJobs().map(job => job.name).sort()).toEqual(['holo.events.invoke-listener', 'jobs.manual'])
  })

  it('imports discovered queue jobs without transient copies when the Vitest toggle is disabled', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await mkdir(join(root, 'server/jobs/reports'), { recursive: true })
    await writeFile(join(root, 'server/jobs/reports/direct.mjs'), `
export default {
  async handle() {
    return 'direct-import'
  },
}
`, 'utf8')
    await writeRegistry(root, {
      jobs: [{
        sourcePath: 'server/jobs/reports/direct.mjs',
        name: 'reports.direct',
        connection: 'sync',
        queue: 'default',
      }],
    })

    const originalVitest = process.env.VITEST
    process.env.VITEST = '0'

    try {
      const isolatedHoloModule = await import(`${pathToFileURL(resolve(import.meta.dirname, '../src/portable/holo.ts')).href}?direct-import=${Date.now()}`) as typeof PortableHoloModule
      const runtime = await isolatedHoloModule.initializeHolo(root, {
        registerProjectQueueJobs: true,
      })
      await expect(Queue.dispatchSync('reports.direct', {})).resolves.toBe('direct-import')
      await runtime.shutdown()
    } finally {
      if (typeof originalVitest === 'undefined') {
        delete process.env.VITEST
      } else {
        process.env.VITEST = originalVitest
      }
    }
  })

  it('boots queue with missing, partial, and database-backed queue config through the shared runtime', async () => {
    const missingRoot = await createProject()
    await writeBaseConfig(missingRoot)

    const missingRuntime = await initializeHolo(missingRoot)
    expect(missingRuntime.queue.config.default).toBe('sync')
    await missingRuntime.shutdown()

    const partialRoot = await createProject()
    await writeBaseConfig(partialRoot)
    await writeQueueConfig(partialRoot, `
import { defineQueueConfig } from ${queuePackageEntry}

export default defineQueueConfig({
  failed: false,
  connections: {
    sync: {
      driver: 'sync',
      queue: 'inline',
    },
  },
})
`)

    const partialRuntime = await initializeHolo(partialRoot)
    expect(partialRuntime.queue.config.default).toBe('sync')
    expect(partialRuntime.queue.config.failed).toBe(false)
    expect(Queue.connection().name).toBe('sync')
    await partialRuntime.shutdown()

    const databaseRoot = await createProject()
    await writeBaseConfig(databaseRoot)
    await writeQueueConfig(databaseRoot, `
import { defineQueueConfig } from ${queuePackageEntry}

export default defineQueueConfig({
  default: 'database',
  failed: {
    driver: 'database',
    connection: 'main',
    table: 'failed_jobs',
  },
  connections: {
    database: {
      driver: 'database',
      connection: 'main',
      table: 'jobs',
      queue: 'reports',
    },
  },
})
`)

    const databaseRuntime = await initializeHolo(databaseRoot)
    registerQueueJob({
      connection: 'database',
      queue: 'reports',
      async handle() {},
    }, {
      name: 'jobs.core-runtime',
    })

    await createSchemaService(DB.connection()).createTable('jobs', (table) => {
      table.string('id').primaryKey()
      table.string('job')
      table.string('connection')
      table.string('queue')
      table.text('payload')
      table.integer('attempts').default(0)
      table.integer('max_attempts').default(1)
      table.bigInteger('available_at')
      table.bigInteger('reserved_at').nullable()
      table.string('reservation_id').nullable()
      table.bigInteger('created_at')
    })
    await createSchemaService(DB.connection()).createTable('failed_jobs', (table) => {
      table.string('id').primaryKey()
      table.string('job_id')
      table.string('job')
      table.string('connection')
      table.string('queue')
      table.text('payload')
      table.text('exception')
      table.bigInteger('failed_at')
    })

    const dispatched = await Queue.connection().dispatch('jobs.core-runtime', { ok: true })
    expect(dispatched.connection).toBe('database')
    expect(databaseRuntime.queue.config.default).toBe('database')

    const queuedRows = await DB.table('jobs').orderBy('id').get() as Array<{ id: string, queue: string }>
    expect(queuedRows).toHaveLength(1)
    expect(queuedRows[0]).toMatchObject({
      id: dispatched.jobId,
      queue: 'reports',
    })

    await persistFailedQueueJob({
      reservationId: 'reservation-core-runtime',
      reservedAt: 150,
      envelope: {
        id: 'job-core-runtime',
        name: 'jobs.core-runtime',
        connection: 'database',
        queue: 'reports',
        payload: { ok: true },
        attempts: 1,
        maxAttempts: 2,
        createdAt: 100,
      },
    }, new Error('boom'))

    expect(await listFailedQueueJobs()).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        jobId: 'job-core-runtime',
        job: expect.objectContaining({
          name: 'jobs.core-runtime',
          connection: 'database',
          queue: 'reports',
        }),
        exception: expect.stringContaining('Error: boom'),
      }),
    ])

    await databaseRuntime.shutdown()
  })

  it('loads the database failed-job store when queue config relies on the default failed setting', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databasePackageEntry}

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
      logging: false,
    },
  },
})
`, 'utf8')
    await writeQueueConfig(root, `
import { defineQueueConfig } from ${queuePackageEntry}

export default defineQueueConfig({
  default: 'sync',
  connections: {
    sync: {
      driver: 'sync',
      queue: 'default',
    },
  },
})
`)

    const runtime = await initializeHolo(root)
    registerQueueJob({
      connection: 'sync',
      queue: 'default',
      async handle() {},
    }, {
      name: 'jobs.default-failed-store',
    })

    await createSchemaService(DB.connection()).createTable('failed_jobs', (table) => {
      table.string('id').primaryKey()
      table.string('job_id')
      table.string('job')
      table.string('connection')
      table.string('queue')
      table.text('payload')
      table.text('exception')
      table.bigInteger('failed_at')
    })

    const persisted = await persistFailedQueueJob({
      reservationId: 'reservation-default-failed-store',
      reservedAt: 150,
      envelope: {
        id: 'job-default-failed-store',
        name: 'jobs.default-failed-store',
        connection: 'sync',
        queue: 'default',
        payload: { ok: true },
        attempts: 1,
        maxAttempts: 2,
        createdAt: 100,
      },
    }, new Error('boom'))

    expect(persisted).toEqual(expect.objectContaining({
      jobId: 'job-default-failed-store',
      job: expect.objectContaining({
        name: 'jobs.default-failed-store',
        connection: 'sync',
        queue: 'default',
      }),
      exception: expect.stringContaining('Error: boom'),
    }))
    expect(await listFailedQueueJobs()).toEqual([
      expect.objectContaining({
        jobId: 'job-default-failed-store',
      }),
    ])

    await runtime.shutdown()
  })

  it('preserves plugin queue drivers when database failed-job storage is active', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Runtime App',
  key: 'base64:key',
  url: 'https://runtime.test',
  debug: false,
  env: 'production',
  plugins: ['holo-plugin-queue-core'],
})
`, 'utf8')
    await writeQueueConfig(root, `
import { defineQueueConfig } from ${queuePackageEntry}

export default defineQueueConfig({
  default: 'plugin',
  connections: {
    plugin: {
      driver: 'plugin',
      queue: 'plugin-jobs',
    },
  },
})
`)
    await writeRuntimePluginPackage(root, 'holo-plugin-queue-core', `
export default {
  id: 'queue-core',
  name: 'Queue Core',
  contributes: {
    queue: {
      drivers: {
        plugin: {
          runtime: './driver.mjs',
        },
      },
    },
  },
}
`, {
      'driver.mjs': `
export default {
  driver: 'plugin',
  create(connection) {
    return {
      name: connection.name,
      driver: connection.driver,
      mode: 'async',
      async dispatch(job) {
        return {
          jobId: \`plugin:\${job.id}\`,
          synchronous: false,
        }
      },
      async clear() {
        return 0
      },
      async reserve() {
        return null
      },
      async acknowledge() {},
      async release() {},
      async delete() {},
      async close() {},
    }
  },
}
`,
    })

    const runtime = await initializeHolo(root)
    registerQueueJob({
      connection: 'plugin',
      queue: 'plugin-jobs',
      async handle() {
        return 'queued'
      },
    }, {
      name: 'jobs.plugin-core',
    })

    await expect(Queue.connection().dispatch('jobs.plugin-core', { ok: true })).resolves.toMatchObject({
      connection: 'plugin',
      queue: 'plugin-jobs',
      synchronous: false,
    })

    await runtime.shutdown()
  })

  it('loads the implicit database failed-job store when queue config is omitted', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databasePackageEntry}

export default defineDatabaseConfig({
  connections: {
    default: {
      driver: 'sqlite',
      url: ':memory:',
      logging: false,
    },
  },
})
`, 'utf8')

    const runtime = await initializeHolo(root)

    await createSchemaService(DB.connection()).createTable('failed_jobs', (table) => {
      table.string('id').primaryKey()
      table.string('job_id')
      table.string('job')
      table.string('connection')
      table.string('queue')
      table.text('payload')
      table.text('exception')
      table.bigInteger('failed_at')
    })

    await persistFailedQueueJob({
      reservationId: 'reservation-implicit-failed-store',
      reservedAt: 150,
      envelope: {
        id: 'job-implicit-failed-store',
        name: 'jobs.implicit-failed-store',
        connection: 'sync',
        queue: 'default',
        payload: { ok: true },
        attempts: 1,
        maxAttempts: 2,
        createdAt: 100,
      },
    }, new Error('implicit boom'))

    expect(await listFailedQueueJobs()).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        jobId: 'job-implicit-failed-store',
        job: expect.objectContaining({
          name: 'jobs.implicit-failed-store',
          connection: 'sync',
          queue: 'default',
        }),
        exception: expect.stringContaining('Error: implicit boom'),
      }),
    ])

    await runtime.shutdown()
  })

  it('fails closed on malformed queue config before runtime boot begins', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeQueueConfig(root, `
import { defineQueueConfig } from ${queuePackageEntry}

export default defineQueueConfig({
  default: 'missing',
})
`)

    await expect(createHolo(root)).rejects.toThrow('default queue connection "missing" is not configured')
    expect(peekHolo()).toBeUndefined()
  })

  it('reuses initialized runtimes through peek and ensure helpers', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    expect(peekHolo()).toBeUndefined()

    const initialized = await initializeHolo(root)

    expect(peekHolo()).toBe(initialized)
    await expect(ensureHolo(root)).resolves.toBe(initialized)

    const otherRoot = await createProject()
    await writeBaseConfig(otherRoot)
    await expect(ensureHolo(otherRoot)).rejects.toThrow(`A Holo runtime is already initialized for "${root}".`)
  })

  it('creates adapter projects with loaded config, runtime, and generated registries', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)

    const project = await createHoloAdapterProject(root)

    expect(project.projectRoot).toBe(root)
    expect(project.config.app.name).toBe('Runtime App')
    expect(project.registry?.models[0]?.name).toBe('User')
    expect(project.runtime.projectRoot).toBe(root)
    expect(project.runtime.registry?.commands[0]?.name).toBe('inspire')
  })

  it('initializes adapter projects with the shared runtime singleton', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    const evaluationsPath = join(root, 'config-evaluations.txt')
    await writeFile(join(root, 'config/probe.ts'), `
import { appendFileSync } from 'node:fs'

appendFileSync(${JSON.stringify(evaluationsPath)}, 'evaluated\\n')

export default {}
`, 'utf8')

    const initialized = await initializeHoloAdapterProject(root)

    expect(await readFile(evaluationsPath, 'utf8')).toBe('evaluated\n')
    expect(initialized.runtime.initialized).toBe(true)
    expect(getHolo()).toBe(initialized.runtime)
    expect(initialized.config).toBe(initialized.runtime.loadedConfig)
    expect(initialized.registry).toBe(initialized.runtime.registry)

    await writeFile(join(root, 'config/app.ts'), `
export default { name: 'Changed App' }
`, 'utf8')
    await writeRegistry(root, {
      models: [{ sourcePath: 'server/models/Post.ts', name: 'Post', prunable: false }],
    })

    const reused = await initializeHoloAdapterProject(root)
    expect(await readFile(evaluationsPath, 'utf8')).toBe('evaluated\n')
    expect(reused.runtime).toBe(initialized.runtime)
    expect(reused.config).toBe(initialized.config)
    expect(reused.config.app.name).toBe('Runtime App')
    expect(reused.registry).toBe(initialized.registry)
    expect(reused.registry?.models[0]?.name).toBe('User')
    expect(reused.registry?.commands[0]?.name).toBe('inspire')
  })

  it('preloads discovered model modules during runtime initialization', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeFile(join(root, 'server/models/User.ts'), `
const state = globalThis.__holoCoreRuntimeModelPreload ??= {
  loaded: [],
}

state.loaded.push('User')

export default {
  definition: {
    name: 'User',
  },
}
`, 'utf8')
    await writeFile(join(root, 'server/models/Post.ts'), `
const state = globalThis.__holoCoreRuntimeModelPreload ??= {
  loaded: [],
}

state.loaded.push('Post')

export default {
  definition: {
    name: 'Post',
  },
}
`, 'utf8')
    await writeRegistry(root, {
      models: [
        {
          sourcePath: 'server/models/User.ts',
          name: 'User',
          prunable: false,
        },
        {
          sourcePath: 'server/models/Post.ts',
          name: 'Post',
          prunable: false,
        },
      ],
    })

    await initializeHolo(root)

    const state = globalThis as typeof globalThis & {
      __holoCoreRuntimeModelPreload?: {
        loaded: string[]
      }
    }

    try {
      expect(state.__holoCoreRuntimeModelPreload?.loaded).toEqual(['User', 'Post'])
    } finally {
      delete state.__holoCoreRuntimeModelPreload
    }
  })

  it('reconfigures queue runtime when framework adapters reuse the current singleton runtime', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    await writeQueueConfig(root, `
import { defineQueueConfig } from ${queuePackageEntry}

export default defineQueueConfig({
  default: 'database',
  connections: {
    database: {
      driver: 'database',
      connection: 'main',
      table: 'jobs',
      queue: 'adapter',
    },
  },
})
`)

    const adapter = createHoloFrameworkAdapter({
      stateKey: '__holoRuntimeQueueAdapter__',
      displayName: 'Runtime Queue',
    })
    const initialized = await adapter.initializeProject({
      projectRoot: root,
    })
    expect(initialized.runtime.queue.config.default).toBe('database')

    queueRuntimeInternals.getQueueRuntimeState().config = {
      ...queueRuntimeInternals.getQueueRuntimeState().config,
      default: 'sync',
    }

    const reused = await adapter.initializeProject({
      projectRoot: root,
    })
    expect(reused.runtime.queue.config.default).toBe('database')
    expect(Queue.connection().name).toBe('database')

    await adapter.resetProject()
  })

  it('handles missing and malformed generated registries without failing runtime creation', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    const withoutRegistry = await createHolo(root)
    expect(withoutRegistry.registry).toBeUndefined()

    const registryPath = resolveGeneratedProjectRegistryPath(root)
    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await writeFile(registryPath, '{invalid json', 'utf8')

    const malformedRegistry = await createHolo(root)
    expect(malformedRegistry.registry).toBeUndefined()
    expect(await loadGeneratedProjectRegistry(root)).toBeUndefined()

    await writeFile(registryPath, `${JSON.stringify({ version: 2 }, null, 2)}\n`, 'utf8')

    const invalidRegistry = await createHolo(root)
    expect(invalidRegistry.registry).toBeUndefined()
    expect(await loadGeneratedProjectRegistry(root)).toBeUndefined()
  })

  it('rejects double initialization and resets state after startup failures', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    const runtime = await createHolo(root)
    await runtime.shutdown()
    await runtime.initialize()

    await expect(runtime.initialize()).rejects.toThrow('Holo runtime is already initialized.')
    await expect(initializeHolo(root)).resolves.toBe(runtime)

    await runtime.shutdown()

    const failingRoot = await createProject()
    await writeBaseConfig(failingRoot, join(failingRoot, 'missing', 'database.sqlite'))
    const failingRuntime = await createHolo(failingRoot)

    await expect(failingRuntime.initialize()).rejects.toThrow()
    expect(() => getHolo()).toThrow('Holo runtime is not initialized.')
    expect(() => useConfig('app')).toThrow('Holo config runtime is not configured.')
  })

  it('clears the database runtime after PostgreSQL terminates its own active connection', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databasePackageEntry}
export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: ${JSON.stringify({
      driver: 'postgres',
      host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
      username: process.env.HOLO_POSTGRES_USER ?? 'postgres',
      password: process.env.HOLO_POSTGRES_PASSWORD,
      database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
    })},
  },
})
`, 'utf8')
    const runtime = await createHolo(root)
    await runtime.initialize()
    await expect(DB.connection().queryCompiled({
      sql: 'SELECT pg_terminate_backend(pg_backend_pid())',
      source: 'connection-termination',
    })).rejects.toThrow('terminating connection')
    await runtime.shutdown()
    expect(() => DB.getManager()).toThrow('DB facade is not configured')
    expect(getDatabaseDriverFactory('postgres')).toBeUndefined()
    expect(() => getHolo()).toThrow('Holo runtime is not initialized.')
  }, 15000)

  it('skips eager service boot during generated framework builds', async () => {
    const root = await createProject()
    await writeBaseConfig(root, join(root, 'missing', 'database.sqlite'))

    const runtime = await createHolo(root, {
      processEnv: {
        ...process.env,
        HOLO_INTERNAL_FRAMEWORK_BUILD: '1',
      },
    })

    await expect(runtime.initialize()).resolves.toBeUndefined()
    expect(runtime.initialized).toBe(true)
    expect(runtime.manager.connection().isConnected()).toBe(false)
    expect(getHolo()).toBe(runtime)
    expect(useConfig('app').name).toBe('Runtime App')

    await runtime.shutdown()

    const normalRuntime = await createHolo(root)
    await expect(normalRuntime.initialize()).rejects.toThrow()
  })

  it('loads plugin boot modules from the runtime config process environment', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig, env } from ${packageEntry}

export default defineAppConfig({
  name: 'Runtime App',
  key: 'base64:key',
  url: 'https://runtime.test',
  debug: false,
  env: 'production',
  plugins: env('HOLO_RUNTIME_PLUGINS', '').split(',').filter(Boolean),
})
`, 'utf8')
    await writeRuntimePluginPackage(root, 'holo-plugin-env-boot', `
export default {
  id: 'env-boot',
  name: 'Env Boot',
  contributes: {
    runtime: {
      boot: './boot.mjs',
    },
  },
}
`, {
      'boot.mjs': `
export default async function boot({ config }) {
  globalThis.__holoCoreEnvBoots__ = [
    ...(globalThis.__holoCoreEnvBoots__ ?? []),
    config.app.plugins.join(','),
  ]
}
`,
    })

    const runtimeGlobal = globalThis as typeof globalThis & {
      __holoCoreEnvBoots__?: string[]
    }
    runtimeGlobal.__holoCoreEnvBoots__ = []

    const runtime = await initializeHolo(root, {
      processEnv: {
        ...process.env,
        HOLO_RUNTIME_PLUGINS: 'holo-plugin-env-boot',
      },
      preferCache: false,
    })

    expect(runtime.loadedConfig.app.plugins).toEqual(['holo-plugin-env-boot'])
    expect(runtimeGlobal.__holoCoreEnvBoots__).toEqual(['holo-plugin-env-boot'])

    await runtime.shutdown()
    runtimeGlobal.__holoCoreEnvBoots__ = undefined
  })

  it('runs plugin boot modules once during adapter initialization', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Runtime App',
  key: 'base64:key',
  url: 'https://runtime.test',
  debug: false,
  env: 'production',
  plugins: ['holo-plugin-adapter-boot'],
})
`, 'utf8')
    await writeRuntimePluginPackage(root, 'holo-plugin-adapter-boot', `
export default {
  id: 'adapter-boot',
  name: 'Adapter Boot',
  contributes: {
    runtime: {
      boot: './boot.mjs',
    },
  },
}
`, {
      'boot.mjs': `
export default async function boot() {
  globalThis.__holoCoreAdapterBoots__ = (globalThis.__holoCoreAdapterBoots__ ?? 0) + 1
}
`,
    })

    const runtimeGlobal = globalThis as typeof globalThis & {
      __holoCoreAdapterBoots__?: number
    }
    runtimeGlobal.__holoCoreAdapterBoots__ = 0

    const project = await initializeHoloAdapterProject(root)

    expect(runtimeGlobal.__holoCoreAdapterBoots__).toBe(1)

    await project.runtime.shutdown()
    runtimeGlobal.__holoCoreAdapterBoots__ = undefined
  })

  it('ignores plugin boot modules without a callable default export', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Runtime App',
  key: 'base64:key',
  url: 'https://runtime.test',
  debug: false,
  env: 'production',
  plugins: ['holo-plugin-static-boot'],
})
`, 'utf8')
    await writeRuntimePluginPackage(root, 'holo-plugin-static-boot', `
export default {
  id: 'static-boot',
  name: 'Static Boot',
  contributes: {
    runtime: {
      boot: './boot.mjs',
    },
  },
}
`, {
      'boot.mjs': `
export const boot = 'static'
`,
    })

    const runtime = await initializeHolo(root)

    expect(runtime.loadedConfig.app.plugins).toEqual(['holo-plugin-static-boot'])

    await runtime.shutdown()
  })

  it('restores external CSRF policy and preserves real rate-limit buckets through managed runtime boot', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeSecurityConfig(root)
    configureSecurityRuntime({
      config: { csrf: { enabled: false }, rateLimit: { driver: 'memory', limiters: { login: limit.perMinute(5) } } },
      rateLimitStore: createMemoryRateLimitStore(),
    })
    const request = new Request('https://runtime.test/login', { method: 'POST' })
    await expect(protect(request)).resolves.toBeUndefined()
    await expect(rateLimit('login', { key: 'external' })).resolves.toMatchObject({ snapshot: { attempts: 1 } })
    const runtime = await createHolo(root)
    await runtime.initialize()
    await expect(protect(request)).rejects.toMatchObject({ status: 419 })
    await expect(rateLimit('login', { key: 'external' })).resolves.toMatchObject({ snapshot: { attempts: 2 } })
    await runtime.shutdown()
    await expect(protect(request)).resolves.toBeUndefined()
    await expect(rateLimit('login', { key: 'external' })).resolves.toMatchObject({ snapshot: { attempts: 3 } })
  })

  it('preserves externally configured rate-limit buckets when no security configuration exists', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    configureSecurityRuntime({
      config: { csrf: { enabled: false }, rateLimit: { driver: 'memory', limiters: { login: limit.perMinute(5) } } },
      rateLimitStore: createMemoryRateLimitStore(),
    })
    await expect(rateLimit('login', { key: 'external' })).resolves.toMatchObject({ snapshot: { attempts: 1 } })
    const runtime = await createHolo(root)
    await runtime.initialize()
    await expect(rateLimit('login', { key: 'external' })).resolves.toMatchObject({ snapshot: { attempts: 2 } })
    await runtime.shutdown()
    await expect(rateLimit('login', { key: 'external' })).resolves.toMatchObject({ snapshot: { attempts: 3 } })
  })

  it('uses a newly supplied real rate-limit store after a prior managed runtime shuts down', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeSecurityConfig(root)
    const firstRuntime = await createHolo(root)
    await firstRuntime.initialize()
    await firstRuntime.shutdown()
    configureSecurityRuntime({
      config: { csrf: { enabled: false }, rateLimit: { driver: 'memory', limiters: { login: limit.perMinute(5) } } },
      rateLimitStore: createMemoryRateLimitStore(),
    })
    await expect(rateLimit('login', { key: 'new-store' })).resolves.toMatchObject({ snapshot: { attempts: 1 } })
    const secondRuntime = await createHolo(root)
    await secondRuntime.initialize()
    await expect(rateLimit('login', { key: 'new-store' })).resolves.toMatchObject({ snapshot: { attempts: 2 } })
    await secondRuntime.shutdown()
    await expect(rateLimit('login', { key: 'new-store' })).resolves.toMatchObject({ snapshot: { attempts: 3 } })
  })

  it('rebuilds the security store when successive config loads change the driver', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeSecurityConfig(root, `
import { defineSecurityConfig, ip, limit } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: {
    enabled: true,
  },
  rateLimit: {
    driver: 'file',
    file: {
      path: './storage/framework/first-rate-limits',
    },
    limiters: {
      login: limit.perMinute(5).by(({ request }) => ip(request)),
    },
  },
})
`)

    const firstConfig = await loadConfigDirectory(root, {
      preferCache: false,
      processEnv: process.env,
    })

    await reconfigureOptionalHoloSubsystems(root, firstConfig)
    const firstBindings = getSecurityRuntimeBindings()
    const firstStore = firstBindings?.rateLimitStore

    expect(firstBindings?.config.rateLimit.driver).toBe('file')
    expect(firstStore).toBeDefined()

    await writeSecurityConfig(root, `
import { defineSecurityConfig, ip, limit } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: {
    enabled: true,
  },
  rateLimit: {
    driver: 'memory',
    limiters: {
      login: limit.perMinute(5).by(({ request }) => ip(request)),
    },
  },
})
`)

    const secondConfig = await loadConfigDirectory(root, {
      preferCache: false,
      processEnv: process.env,
    })

    await reconfigureOptionalHoloSubsystems(root, secondConfig)
    const secondBindings = getSecurityRuntimeBindings()

    expect(secondBindings?.config.rateLimit.driver).toBe('memory')
    expect(secondBindings?.rateLimitStore).toBeDefined()
    expect(secondBindings?.rateLimitStore).not.toBe(firstStore)
  })

  it('clears security runtime bindings when the security config file is removed', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeSecurityConfig(root)

    const withSecurityConfig = await loadConfigDirectory(root, {
      preferCache: false,
      processEnv: process.env,
    })

    await reconfigureOptionalHoloSubsystems(root, withSecurityConfig)
    expect(getSecurityRuntimeBindings()).toBeDefined()

    await rm(join(root, 'config/security.ts'))

    const withoutSecurityConfig = await loadConfigDirectory(root, {
      preferCache: false,
      processEnv: process.env,
    })

    await reconfigureOptionalHoloSubsystems(root, withoutSecurityConfig)

    expect(getSecurityRuntimeBindings()).toBeUndefined()
  })

  it('releases real Redis session connections after a second configured store fails authentication', async () => {
    const service = await startRedisService()
    const port = service.ports[0]
    const admin = service.clients[0]
    if (port === undefined || !admin) throw new Error('Expected an owned Redis server')
    await admin.acl('SETUSER', 'session-worker', 'on', '>secret', '~*', '+@all')
    const root = await createProject()
    await writeBaseConfig(root)
    const writeStores = async (password: string) => {
      await writeFile(join(root, 'config/redis.ts'), `
import { defineRedisConfig } from ${kernelPackageEntry}
export default defineRedisConfig({
  default: 'primary',
  connections: {
    primary: { host: '127.0.0.1', port: ${port}, username: 'session-worker', password: 'secret' },
    secondary: { host: '127.0.0.1', port: ${port}, username: 'session-worker', password: ${JSON.stringify(password)} },
  },
})
`, 'utf8')
      await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}
export default defineSessionConfig({
  driver: 'primary',
  stores: {
    primary: { driver: 'redis', connection: 'primary', prefix: 'primary:' },
    secondary: { driver: 'redis', connection: 'secondary', prefix: 'secondary:' },
  },
})
`, 'utf8')
    }
    await writeStores('incorrect')
    const failed = await createHolo(root)
    await expect(failed.initialize()).rejects.toThrow()
    expect(await admin.acl('LOG', 1)).toEqual([
      expect.arrayContaining(['reason', 'auth', 'username', 'session-worker']),
    ])
    await expect.poll(async () => await admin.client('LIST')).not.toContain('user=session-worker')
    expect(() => getHolo()).toThrow('Holo runtime is not initialized.')
    await writeStores('secret')
    const runtime = await createHolo(root, { preferCache: false })
    await runtime.initialize()
    if (!runtime.session) throw new Error('Expected the session runtime')
    const primary = await runtime.session.create({ store: 'primary', data: { message: 'first store' } })
    const secondary = await runtime.session.create({ store: 'secondary', data: { message: 'second store' } })
    await expect(runtime.session.read(primary.id, { store: 'primary' })).resolves.toMatchObject({ data: { message: 'first store' } })
    await expect(runtime.session.read(secondary.id, { store: 'secondary' })).resolves.toMatchObject({ data: { message: 'second store' } })
    await expect(runtime.session.read(primary.id, { store: 'secondary' })).resolves.toBeNull()
    await runtime.shutdown()
    await expect.poll(async () => await admin.client('LIST')).not.toContain('user=session-worker')
  }, 15000)

  it('creates usable file session stores relative to the project root', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}

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

    const loadedConfig = await loadConfigDirectory(root, {
      preferCache: false,
      processEnv: process.env,
    })

    const stores = await holoRuntimeInternals.createCoreSessionStores(root, loadedConfig, sessionModule)
    const fileStore = stores.file
    if (!fileStore) throw new Error('File session store is missing')
    const now = new Date()
    const record = {
      id: 'abc',
      store: 'file',
      data: { message: 'persisted' },
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    }
    await fileStore.write(record)
    await expect(fileStore.read(record.id)).resolves.toEqual(record)
    await expect(readFile(join(root, 'storage/framework/sessions/abc.json'), 'utf8')).resolves.toBeDefined()
    await fileStore.delete(record.id)
    await expect(fileStore.read(record.id)).resolves.toBeNull()
  })

  it('publishes through real workers, replaces stale generated bindings, and reports a closed native connection', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    const workers: Array<Awaited<ReturnType<typeof startBroadcastWorker>>> = []
    const sockets: WebSocket[] = []
    try {
      for (const appId of ['first', 'second']) {
        const reservation = createServer()
        reservation.listen(0, '127.0.0.1')
        await once(reservation, 'listening')
        const address = reservation.address()
        if (!address || typeof address === 'string') throw new Error('Expected a native broadcast port')
        await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
        const broadcastConfig = normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId, key: appId, secret: 'secret', options: { host: '127.0.0.1', port: address.port, scheme: 'http', useTLS: false } } }, worker: { host: '127.0.0.1', port: address.port } })
        const worker = await startBroadcastWorker({ config: broadcastConfig })
        workers.push(worker)
        const socket = new WebSocket(`ws://127.0.0.1:${worker.port}/app/${appId}`)
        sockets.push(socket)
        const packets: Array<{ event: string, channel?: string, data: string }> = []
        socket.addEventListener('message', message => packets.push(JSON.parse(String(message.data)) as { event: string, channel?: string, data: string }))
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve(), { once: true })
          socket.addEventListener('error', () => reject(new Error('Native broadcast connection failed')), { once: true })
        })
        socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'invoices' } }))
        await expect.poll(() => packets.some(packet => packet.event === 'pusher_internal:subscription_succeeded')).toBe(true)
        await writeBroadcastConfig(root, `import { defineBroadcastConfig } from ${broadcastPackageEntry}; export default defineBroadcastConfig(${JSON.stringify(broadcastConfig)})`)
        const runtime = await initializeHolo(root)
        const result = await broadcastRaw({ event: 'invoice.paid', channels: ['invoices'], payload: { invoiceId: appId } })
        expect(result).toMatchObject({ connection: 'main', driver: 'holo', queued: false, publishedChannels: ['invoices'] })
        await expect.poll(() => packets.find(packet => packet.event === 'invoice.paid')?.data).toBe(JSON.stringify({ invoiceId: appId }))
        const bindings = getBroadcastRuntimeBindings()
        if (appId === 'second') {
          await worker.stop()
          workers.splice(workers.indexOf(worker), 1)
          await expect(broadcastRaw({ event: 'invoice.paid', channels: ['invoices'], payload: { invoiceId: 'closed' } })).rejects.toMatchObject({
            message: `[@holo-js/core] Broadcast publish request could not reach the broadcast worker at http://127.0.0.1:${worker.port}.`,
            cause: { cause: { code: 'ECONNREFUSED' } },
          })
        }
        await runtime.shutdown()
        if (appId === 'first') configureBroadcastRuntime(bindings)
      }
    } finally {
      sockets.forEach(socket => socket.close())
      await Promise.all(workers.map(worker => worker.stop()))
    }
  }, 15000)

  it('aborts a broadcast publish over a real HTTP connection when the server does not respond', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    const server = createHttpServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a stalled HTTP server port')
    try {
      await writeBroadcastConfig(root, `import { defineBroadcastConfig } from ${broadcastPackageEntry}; export default defineBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'main', options: { host: '127.0.0.1', port: ${address.port}, scheme: 'http', useTLS: false } } } })`)
      await initializeHolo(root)
      await expect(broadcastRaw({ event: 'invoice.paid', channels: ['invoices'], payload: { invoiceId: 'stalled' } })).rejects.toThrow('timed out after 10000ms')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }, 15000)

  it('boots mail when configured and forwards the render-view seam into the mail runtime', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeMailConfig(root)

    const renderView = vi.fn(async ({ view, props }: { view: string, props?: Record<string, unknown> }) => {
      return `<section data-view="${view}">${String(props?.title ?? '')}</section>`
    })

    const runtime = await createHolo(root, {
      renderView,
    })

    await runtime.initialize()

    const preview = await previewMail({
      to: 'ava@example.com',
      subject: 'Rendered',
      render: {
        view: 'emails/welcome',
        props: {
          title: 'Welcome',
        },
      },
    })

    expect(preview.html).toBe('<section data-view="emails/welcome">Welcome</section>')
    expect(renderView).toHaveBeenCalledWith({
      view: 'emails/welcome',
      props: {
        title: 'Welcome',
      },
    })
  })

  it('boots auth with mail delivery when mail is configured without notifications', async () => {
    const root = await createProject()
    const databasePath = join(root, 'auth.sqlite')
    const database = new DatabaseSync(databasePath)
    database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL)')
    database.exec('CREATE TABLE auth_session_revocations (provider TEXT NOT NULL, user_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, retained_session_id TEXT, PRIMARY KEY (provider, user_id))')
    database.close()
    await writeBaseConfig(root, databasePath)
    await writeMailConfig(root)
    await writeAuthConfig(root)
    await writeUserModel(root)
    await writeSecurityConfig(root)

    const runtime = await createHolo(root)
    await runtime.initialize()

    const auth = runtime.auth
    if (!auth) throw new Error('Auth did not initialize')
    const registered = await auth.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    })
    expect(registered).toMatchObject({ id: 1, email: 'ava@example.com', name: 'Ava' })
    expect(registered).not.toHaveProperty('password')
    const userId = registered.id
    if (userId === undefined) throw new Error('Registration did not return its generated user id')
    const established = await runtime.runWithAuthRequestAccessors({}, () => auth.loginUsingId(userId))
    await runtime.runWithAuthRequestAccessors({ getCookie: name => name === 'holo_session' ? established.sessionId : undefined }, async () => {
      expect(await auth.id()).toBe(registered.id)
      expect(await defaultRateLimitKey(new Request('https://runtime.test/requests'))).toBe('user:1')
    })
  })

  it('bridges notification email delivery into mail when notifications and mail are both installed', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeMailConfig(root)
    await writeNotificationsConfig(root)

    const runtime = await initializeHolo(root)

    const notification = defineNotification({
      type: 'invoice-paid',
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Invoice paid',
            lines: [
              'Your invoice was paid.',
            ],
            metadata: {
              invoiceId: 'inv-1',
            },
          }
        },
      },
    })

    await notify({
      email: 'ava@example.com',
      name: 'Ava',
    }, notification)

    expect(listFakeSentMails()).toHaveLength(1)
    expect(listFakeSentMails()[0]!.mail).toMatchObject({
      subject: 'Invoice paid',
      to: [
        {
          email: 'ava@example.com',
          name: 'Ava',
        },
      ],
      text: 'Your invoice was paid.',
      metadata: {
        invoiceId: 'inv-1',
      },
    })
    expect(runtime.initialized).toBe(true)
  })

  it('bridges notification broadcast delivery into @holo-js/broadcast raw runtime', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeBroadcastConfig(root, `
import { defineBroadcastConfig } from ${broadcastPackageEntry}

export default defineBroadcastConfig({
  default: 'reverb',
  connections: {
    reverb: {
      driver: 'holo',
      key: 'app-key',
      secret: 'app-secret',
      appId: 'app-id',
      options: {
        host: '127.0.0.1',
        port: 8080,
        scheme: 'http',
        useTLS: false,
      },
    },
  },
})
`)
    await writeNotificationsConfig(root)

    const publish = vi.fn(async () => ({
      connection: 'reverb',
      driver: 'holo',
      queued: false,
      publishedChannels: ['private-users.user-1'],
      messageId: 'bridge-msg-1',
    }))
    configureBroadcastRuntime({
      publish,
    })

    const runtime = await initializeHolo(root)
    await notify({
      id: 'user-1',
      type: 'users',
      routeNotificationForBroadcast: () => ({ channels: ['private-users.user-1'] }),
    }, defineNotification({
      type: 'invoice-paid',
      via() {
        return ['broadcast']
      },
      build: {
        broadcast() {
          return {
            event: 'invoice.paid',
            data: {
              invoiceId: 'inv-1',
            },
          }
        },
      },
    }))

    expect(getNotificationsRuntimeBindings().broadcaster).toBeDefined()
    expect(getBroadcastRuntimeBindings().config?.default).toBe('reverb')
    expect(getBroadcastRuntimeBindings().publish).toBe(publish)
    expect(publish).toHaveBeenCalledWith({
      connection: 'reverb',
      event: 'invoice.paid',
      channels: ['private-users.user-1'],
      payload: {
        type: 'invoice-paid',
        data: {
          invoiceId: 'inv-1',
        },
      },
    }, expect.objectContaining({
      connection: 'reverb',
      driver: 'holo',
    }))

    await runtime.shutdown()
    expect(getBroadcastRuntimeBindings().publish).toBe(publish)
    expect(getBroadcastRuntimeBindings().config).toBeUndefined()
  })

  it('preserves existing mail and notification runtime bindings when core reconfigures them', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeMailConfig(root)
    await writeNotificationsConfig(root)

    const customSend = vi.fn(async (input: unknown) => ({
      messageId: 'custom-mail-send',
      mailer: 'fake',
      driver: 'fake',
      queued: false,
      provider: {
        input,
      },
    }))
    const customNotificationMailer = {
      send: vi.fn(async () => {}),
    }
    const store = holoRuntimeInternals.createCoreNotificationStore(await loadConfigDirectory(root, { preferCache: false }))

    configureMailRuntime({
      send: customSend,
    })
    configureNotificationsRuntime({
      mailer: customNotificationMailer,
      store,
    })

    const runtime = await createHolo(root)
    await runtime.initialize()
    await createNotificationTable()
    await notify({
      email: 'ava@example.com',
      name: 'Ava',
    }, defineNotification({
      type: 'invoice-paid-email',
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Invoice paid email',
          }
        },
      },
    }))
    await notify({
      id: 'user-1',
      type: 'users',
    }, defineNotification({
      type: 'invoice-paid-database',
      via() {
        return ['database']
      },
      build: {
        database() {
          return {
            data: {
              invoiceId: 'inv-1',
            },
          }
        },
      },
    }))
    expect(customNotificationMailer.send).toHaveBeenCalledWith({
      subject: 'Invoice paid email',
    }, expect.objectContaining({
      channel: 'email',
      route: {
        email: 'ava@example.com',
        name: 'Ava',
      },
    }))
    expect((await store.list({ recipient: { id: 'user-1', type: 'users' }, type: 'invoice-paid-database' }, { limit: 20, offset: 0 })).records).toMatchObject([{ data: { invoiceId: 'inv-1' } }])
    expect(mailRuntimeInternals.getRuntimeBindings().send).toBe(customSend)
    expect(getNotificationsRuntimeBindings().mailer).toBe(customNotificationMailer)
    expect(getNotificationsRuntimeBindings().store).toBe(store)
    expect(customSend).toHaveBeenCalledTimes(0)
    expect(listFakeSentMails()).toHaveLength(0)
  })

  it('preserves an external Session replacement and closes its previously owned real Redis connection', async () => {
    const service = await startRedisService()
    const client = service.clients[0]
    const port = service.ports[0]
    if (!client || !port) throw new Error('The native Redis service did not start')
    const connections = async () => String(await client.client('LIST')).trim().split('\n').length
    const baseline = await connections()
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRedisConfig(root, `
import { defineRedisConfig } from ${kernelPackageEntry}
export default defineRedisConfig({ default: 'default', connections: { default: { host: '127.0.0.1', port: ${port} } } })
`)
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}
export default defineSessionConfig({ driver: 'redis', stores: { redis: { driver: 'redis', host: '127.0.0.1', port: ${port} } } })
`, 'utf8')
    await reconfigureOptionalHoloSubsystems(root, await loadConfigDirectory(root))
    const ownedSession = await getSessionRuntime().create({ data: { owner: 'framework' } })
    await expect(getSessionRuntime().read(ownedSession.id)).resolves.toMatchObject({ data: { owner: 'framework' } })
    expect(await connections()).toBe(baseline + 1)
    configureSessionRuntime({
      config: normalizeSessionConfig(),
      stores: { file: createFileSessionStore(join(root, 'external-sessions')) },
    })
    const externalSession = await getSessionRuntime().create({ data: { owner: 'application' } })
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}
export default defineSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: 'owned-sessions' } } })
`, 'utf8')
    const runtime = await createHolo(root, { preferCache: false })
    await runtime.initialize()
    await runtime.shutdown()
    await expect(getSessionRuntime().read(externalSession.id)).resolves.toMatchObject({ data: { owner: 'application' } })
    await vi.waitFor(async () => expect(await connections()).toBe(baseline))
    await runtime.shutdown()
    expect(await connections()).toBe(baseline)
  })

  it('preserves an external Security replacement and releases the previously acquired owned store once', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeSecurityConfig(root, `
import { defineSecurityConfig } from '@holo-js/security'
export default defineSecurityConfig({ rateLimit: { driver: 'memory' } })
`)
    await reconfigureOptionalHoloSubsystems(root, await loadConfigDirectory(root))
    const ownedStore = getSecurityRuntimeBindings()?.rateLimitStore
    if (!ownedStore) throw new Error('Managed security store was not acquired')
    const closeOwned = vi.spyOn(ownedStore, 'close')
    const memoryStore = createMemoryRateLimitStore()
    let externalClosed = false
    const externalStore = {
      ...memoryStore,
      async close() { externalClosed = true; await memoryStore.close?.() },
    }
    configureSecurityRuntime({ config: {}, rateLimitStore: externalStore })
    await externalStore.hit('application', { maxAttempts: 10, decaySeconds: 60 })
    const runtime = await createHolo(root)
    await runtime.initialize()
    await runtime.shutdown()
    expect(closeOwned).toHaveBeenCalledTimes(1)
    expect(externalClosed).toBe(false)
    expect(getSecurityRuntimeBindings()?.rateLimitStore).toBe(externalStore)
    await expect(getSecurityRuntimeBindings()?.rateLimitStore?.hit('application', { maxAttempts: 10, decaySeconds: 60 })).resolves.toMatchObject({ snapshot: { attempts: 2 } })
    await runtime.shutdown()
    expect(closeOwned).toHaveBeenCalledTimes(1)
  })

  it.each(['shutdown', 'rollback'] as const)('releases real Redis and database connections after %s', async ending => {
    const service = await startRedisService()
    const client = service.clients[0]
    const port = service.ports[0]
    if (!client || !port) throw new Error('The native Redis service did not start')
    const connections = async () => String(await client.client('LIST')).trim().split('\n').length
    const baseline = await connections()
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRedisConfig(root, `
import { defineRedisConfig } from ${kernelPackageEntry}
export default defineRedisConfig({ default: 'default', connections: { default: { host: '127.0.0.1', port: ${port} } } })
`)
    await writeSecurityConfig(root, `
import { defineSecurityConfig } from '@holo-js/security'
export default defineSecurityConfig({ rateLimit: { driver: 'redis' } })
`)
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}
export default defineSessionConfig({ driver: 'redis', stores: { redis: { driver: 'redis', host: '127.0.0.1', port: ${port} } } })
`, 'utf8')
    if (ending === 'rollback') {
      await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}
export default defineAppConfig({ name: 'Runtime App', key: 'base64:key', url: 'https://runtime.test', plugins: ['holo-plugin-cleanup-failure'] })
`, 'utf8')
      await writeRuntimePluginPackage(root, 'holo-plugin-cleanup-failure', `
export default { id: 'cleanup-failure', name: 'Cleanup Failure', contributes: { runtime: { boot: './boot.mjs' } } }
`, { 'boot.mjs': `export default function boot() { throw new Error('startup failed') }` })
    }
    const runtime = await createHolo(root)
    if (ending === 'rollback') {
      await expect(runtime.initialize()).rejects.toThrow('startup failed')
    } else {
      await runtime.initialize()
      const session = await getSessionRuntime().create({ data: { owner: 'framework' } })
      await expect(getSessionRuntime().read(session.id)).resolves.toMatchObject({ data: { owner: 'framework' } })
      await expect(getSecurityRuntimeBindings()?.rateLimitStore?.hit('application', { maxAttempts: 10, decaySeconds: 60 })).resolves.toMatchObject({ snapshot: { attempts: 1 } })
      expect(await connections()).toBeGreaterThan(baseline)
      await runtime.shutdown()
    }
    expect(runtime.manager.connection().isConnected()).toBe(false)
    expect(() => useConfig('app')).toThrow('Holo config runtime is not configured.')
    await vi.waitFor(async () => expect(await connections()).toBe(baseline))
    await runtime.shutdown()
    expect(await connections()).toBe(baseline)
  })

  it('releases an already connected Redis session store when another native connection is unavailable', async () => {
    const service = await startRedisService()
    const client = service.clients[0]
    const port = service.ports[0]
    if (!client || !port) throw new Error('The native Redis service did not start')
    const connections = async () => String(await client.client('LIST')).trim().split('\n').length
    const baseline = await connections()
    const reservation = createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('No unavailable Redis port allocated')
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRedisConfig(root, `
import { defineRedisConfig } from ${kernelPackageEntry}
export default defineRedisConfig({ default: 'default', connections: { default: { host: '127.0.0.1', port: ${port} }, unavailable: { host: '127.0.0.1', port: ${address.port} } } })
`)
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}
export default defineSessionConfig({ driver: 'primary', stores: {
  primary: { driver: 'redis', connection: 'default' },
  secondary: { driver: 'redis', connection: 'unavailable' },
} })
`, 'utf8')
    const runtime = await createHolo(root)
    await expect(runtime.initialize()).rejects.toThrow(/ECONNREFUSED|Connection is closed/i)
    expect(runtime.manager.connection().isConnected()).toBe(false)
    await expect.poll(connections).toBe(baseline)
    await runtime.shutdown()
    expect(await connections()).toBe(baseline)
  })

  it.each(['redis', 'file', 'removed'] as const)('releases the previous real Redis store when security is reconfigured to %s', async driver => {
    const service = await startRedisService()
    const client = service.clients[0]
    const port = service.ports[0]
    if (!client || !port) throw new Error('The native Redis service did not start')
    const connections = async () => String(await client.client('LIST')).trim().split('\n').length
    const baseline = await connections()
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRedisConfig(root, `
import { defineRedisConfig } from ${kernelPackageEntry}
export default defineRedisConfig({ default: 'default', connections: { default: { host: '127.0.0.1', port: ${port} } } })
`)
    await writeSecurityConfig(root, "export default { rateLimit: { driver: 'redis', redis: { prefix: 'original:' } } }")
    await reconfigureOptionalHoloSubsystems(root, await loadConfigDirectory(root))
    const previous = getSecurityRuntimeBindings()?.rateLimitStore
    if (!previous) throw new Error('The configured Redis rate limiter was not acquired')
    await expect(previous.hit('account', { maxAttempts: 10, decaySeconds: 60 })).resolves.toMatchObject({ snapshot: { attempts: 1 } })
    expect(await connections()).toBe(baseline + 1)
    if (driver === 'removed') {
      await rm(join(root, 'config/security.ts'))
    } else {
      await writeSecurityConfig(root, `export default { rateLimit: { driver: '${driver}', redis: { prefix: 'replacement:' }, file: { path: './rate-limits' } } }`)
    }
    await reconfigureOptionalHoloSubsystems(root, await loadConfigDirectory(root, { preferCache: false }))
    await expect(previous.hit('account', { maxAttempts: 10, decaySeconds: 60 })).rejects.toThrow(/closed/i)
    if (driver === 'removed') {
      expect(getSecurityRuntimeBindings()).toBeUndefined()
    } else {
      await expect(getSecurityRuntimeBindings()?.rateLimitStore?.hit('account', { maxAttempts: 10, decaySeconds: 60 })).resolves.toMatchObject({ snapshot: { attempts: 1 } })
    }
    await expect.poll(connections).toBe(baseline + (driver === 'redis' ? 1 : 0))
    await resetHoloRuntime()
    await expect.poll(connections).toBe(baseline)
  })

  it('preserves an external Queue driver and its live configuration across the Holo lifetime', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    let closed = false
    configureQueueRuntime({
      config: { default: 'sync', connections: { sync: { driver: 'sync', queue: 'external' } } },
      driverFactories: [{
        driver: 'sync',
        create(connection) {
          return {
            name: connection.name,
            driver: connection.driver,
            mode: 'sync',
            async dispatch(job) {
              if (closed) throw new Error('External driver was closed')
              return { jobId: job.id, synchronous: true }
            },
            async clear() { return 0 },
            async close() { closed = true },
          }
        },
      }],
    })
    registerQueueJob({ async handle() {} }, { name: 'external.job' })
    await Queue.dispatch('external.job', {}).dispatch()
    const runtime = await createHolo(root)
    await runtime.initialize()
    await runtime.shutdown()
    await expect(Queue.dispatch('external.job', {}).dispatch()).resolves.toMatchObject({ queue: 'external' })
    expect(closed).toBe(false)
  })

  it.each(['shutdown', 'rollback'] as const)('restores usable external Auth and Session bindings after %s', async (ending) => {
    const root = await createProject()
    await writeBaseConfig(root)
    const externalStore = createFileSessionStore(join(root, 'external-sessions'))
    configureSessionRuntime({
      config: normalizeSessionConfig(),
      stores: { file: externalStore },
    })
    const externalSession = getSessionRuntime()
    const sessionId = await externalSession.create({ data: { owner: 'application' } })
    configureAuthRuntime({
      config: normalizeAuthConfig(),
      context: createAsyncAuthContext(),
      session: externalSession,
      providers: {},
    })
    await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from ${sessionPackageEntry}
export default defineSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: 'owned-sessions' } } })
`, 'utf8')
    if (ending === 'rollback') {
      await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}
export default defineAppConfig({ name: 'Runtime App', key: 'base64:key', url: 'https://runtime.test', plugins: ['holo-plugin-failed-boot'] })
`, 'utf8')
      await writeRuntimePluginPackage(root, 'holo-plugin-failed-boot', `
export default { id: 'failed-boot', name: 'Failed Boot', contributes: { runtime: { boot: './boot.mjs' } } }
`, { 'boot.mjs': `export default function boot() { throw new Error('project initialization failed') }` })
    }
    const runtime = await createHolo(root)
    if (ending === 'rollback') {
      await expect(runtime.initialize()).rejects.toThrow('project initialization failed')
    } else {
      await runtime.initialize()
      await runtime.shutdown()
    }
    expect(await getSessionRuntime().read(sessionId.id)).toMatchObject({ data: { owner: 'application' } })
    await expect(getAuthRuntime().check()).resolves.toBe(false)
  })

  it('restores existing mail and notification runtime bindings after shutdown', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeMailConfig(root)
    await writeNotificationsConfig(root)

    const customSend = vi.fn(async () => ({
      messageId: 'custom-mail-send',
      mailer: 'fake',
      driver: 'fake',
      queued: false,
    }))
    const customNotificationMailer = {
      send: vi.fn(async () => {}),
    }
    const store = holoRuntimeInternals.createCoreNotificationStore(await loadConfigDirectory(root, { preferCache: false }))

    configureMailRuntime({
      send: customSend,
    })
    configureNotificationsRuntime({
      mailer: customNotificationMailer,
      store,
    })

    const runtime = await createHolo(root)
    await runtime.initialize()
    await runtime.shutdown()

    expect(mailRuntimeInternals.getRuntimeBindings()).toMatchObject({
      send: customSend,
    })
    expect(getNotificationsRuntimeBindings()).toMatchObject({
      mailer: customNotificationMailer,
      store,
    })
  })

  it('restores existing mail and notification runtime bindings after failed initialization', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeMailConfig(root)
    await writeNotificationsConfig(root)
    await mkdir(join(root, 'server/events/user'), { recursive: true })
    await writeFile(join(root, 'server/events/user/bad.ts'), 'export default { nope: true }\n', 'utf8')
    await writeRegistry(root, {
      events: [{
        sourcePath: 'server/events/user/bad.ts',
        name: 'user.bad',
        exportName: 'default',
      }],
    })

    const customSend = vi.fn(async () => ({
      messageId: 'custom-mail-send',
      mailer: 'fake',
      driver: 'fake',
      queued: false,
    }))
    const customNotificationMailer = {
      send: vi.fn(async () => {}),
    }
    const store = holoRuntimeInternals.createCoreNotificationStore(await loadConfigDirectory(root, { preferCache: false }))

    configureMailRuntime({
      send: customSend,
    })
    configureNotificationsRuntime({
      mailer: customNotificationMailer,
      store,
    })

    await expect(initializeHolo(root)).rejects.toThrow(
      'Discovered event "server/events/user/bad.ts" does not export a Holo event.',
    )

    expect(mailRuntimeInternals.getRuntimeBindings()).toMatchObject({
      send: customSend,
    })
    expect(getNotificationsRuntimeBindings()).toMatchObject({
      mailer: customNotificationMailer,
      store,
    })
  })

  it('creates a DB-backed notification store for configured notifications tables', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeNotificationsConfig(root)

    const runtime = await initializeHolo(root)

    await createNotificationTable()

    const store = holoRuntimeInternals.createCoreNotificationStore(runtime.loadedConfig)
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const notificationRecords = [
      {
        id: 'notif-1',
        type: 'invoice-paid',
        notifiableType: 'users',
        notifiableId: 'user-1',
        data: { invoiceId: 'inv-1', metadata: { archivedAt: null }, tenant: { id: 'tenant-1' } },
        readAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'notif-2',
        type: 'invoice-paid',
        notifiableType: 'users',
        notifiableId: 'user-1',
        data: { invoiceId: 'inv-2', metadata: { archivedAt: null }, tenant: { id: 'tenant-1' } },
        readAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'notif-other-recipient',
        type: 'invoice-paid',
        notifiableType: 'users',
        notifiableId: 'user-2',
        data: { metadata: { archivedAt: null }, tenant: { id: 'tenant-1' } },
        readAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'notif-other-type',
        type: 'subscription-renewed',
        notifiableType: 'users',
        notifiableId: 'user-1',
        data: { metadata: { archivedAt: null }, tenant: { id: 'tenant-1' } },
        readAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'notif-other-tenant',
        type: 'invoice-paid',
        notifiableType: 'users',
        notifiableId: 'user-1',
        data: { metadata: { archivedAt: null }, tenant: { id: 'tenant-2' } },
        readAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'notif-missing-null',
        type: 'invoice-paid',
        notifiableType: 'users',
        notifiableId: 'user-1',
        data: { tenant: { id: 'tenant-1' } },
        readAt: null,
        createdAt,
        updatedAt: createdAt,
      },
    ] as const
    for (const record of notificationRecords) {
      await store.create(record)
    }
    await expect(store.create(notificationRecords[0]!)).resolves.toBeUndefined()
    await expect(store.create({
      ...notificationRecords[0]!,
      notifiableId: 'user-collision',
    })).rejects.toThrow('Notification persistence collision failed closed')

    const query = {
      recipient: { id: 'user-1', type: 'users' },
      type: 'invoice-paid',
      dataMatches: [
        { path: ['tenant', 'id'], value: 'tenant-1' },
        { path: ['metadata', 'archivedAt'], value: null },
      ],
    } as const
    await expect(store.list(query, { limit: 1, offset: 0 })).resolves.toMatchObject({
      records: [{ id: 'notif-2' }],
      limit: 1,
      offset: 0,
      total: 2,
      unread: 1,
    })
    await expect(store.list(query, { limit: 1, offset: 1 })).resolves.toMatchObject({
      records: [{ id: 'notif-1' }],
      limit: 1,
      offset: 1,
      total: 2,
      unread: 1,
    })
    await expect(store.unread(query, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [{ id: 'notif-1' }],
      limit: 20,
      offset: 0,
      total: 1,
      unread: 1,
    })

    await expect(store.list({ ...query, id: 'notif-1' }, { limit: 1, offset: 0 })).resolves.toMatchObject({ records: [{ id: 'notif-1' }], total: 1, unread: 1 })
    for (const id of ['notif-other-recipient', 'notif-other-tenant', 'missing']) {
      await expect(store.list({ ...query, id }, { limit: 1, offset: 0 })).resolves.toMatchObject({ records: [], total: 0, unread: 0 })
    }
    const allIds = notificationRecords.map(record => record.id)
    expect((await store.find(query, allIds)).map(record => record.id).sort()).toEqual(['notif-1', 'notif-2'])
    await expect(store.find({ ...query, id: 'notif-1' }, allIds)).resolves.toMatchObject([{ id: 'notif-1' }])
    await expect(store.find(query, ['notif-other-recipient', 'notif-other-tenant', 'missing'])).resolves.toEqual([])
    await expect(store.find(query, [])).resolves.toEqual([])
    await expect(store.markAllAsRead(query)).resolves.toBe(1)
    await expect(store.markAllAsRead(query)).resolves.toBe(0)
    const markedPage = await store.list(query, { limit: 20, offset: 0 })
    expect(markedPage.records.find(record => record.id === 'notif-2')?.readAt).toEqual(createdAt)
    await expect(store.markAsRead(query, allIds)).resolves.toBe(2)
    await expect(store.unread(query, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [],
      total: 0,
      unread: 0,
    })
    await expect(store.markAsUnread(query, allIds)).resolves.toBe(2)
    await expect(store.delete(query, allIds)).resolves.toBe(2)
    for (const record of notificationRecords.slice(0, 2)) await store.create(record)
    await expect(store.clear(query)).resolves.toBe(2)
    await expect(store.clear(query)).resolves.toBe(0)
    await expect(store.list(query, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [],
      total: 0,
      unread: 0,
    })
    await expect(store.list({ recipient: { id: 'user-1', type: 'users' } }, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [
        { id: 'notif-other-type' },
        { id: 'notif-other-tenant' },
        { id: 'notif-missing-null' },
      ],
      total: 3,
      unread: 3,
    })
    await expect(store.list({ recipient: { id: 'user-2', type: 'users' } }, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [{ id: 'notif-other-recipient' }],
      total: 1,
      unread: 1,
    })

    await runtime.shutdown()
  })

  it('reads numeric notification recipients through the real database store', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeNotificationsConfig(root)
    const runtime = await initializeHolo(root)
    await createNotificationTable()
    const store = holoRuntimeInternals.createCoreNotificationStore(runtime.loadedConfig)
    await store.create({
      id: 'notif-numeric',
      type: 'invoice-paid',
      notifiableType: 'users',
      notifiableId: 42,
      data: { invoiceId: 'inv-1' },
      readAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    const query = { recipient: { id: 42, type: 'users' } }
    await expect(store.list(query, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [{ id: 'notif-numeric', notifiableId: '42', data: { invoiceId: 'inv-1' } }],
      total: 1,
      unread: 1,
    })
    await expect(store.unread(query, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [{ id: 'notif-numeric', notifiableId: '42' }],
      total: 1,
    })
    await expect(store.list({ recipient: { id: '42', type: 'users' } }, { limit: 20, offset: 0 })).resolves.toMatchObject({
      records: [{ id: 'notif-numeric', notifiableId: '42' }],
      total: 1,
    })
    await expect(store.list({ recipient: { id: 43, type: 'users' } }, { limit: 20, offset: 0 })).resolves.toMatchObject({ records: [], total: 0 })
    await runtime.shutdown()
  })

  it('rejects initializing a second runtime instance while another runtime is current', async () => {
    const firstRoot = await createProject()
    await writeBaseConfig(firstRoot)
    const secondRoot = await createProject()
    await writeBaseConfig(secondRoot)

    const first = await createHolo(firstRoot)
    await first.initialize()

    const second = await createHolo(secondRoot)
    await expect(second.initialize()).rejects.toThrow('A Holo runtime is already initialized for this process.')
  })

  it('reuses pending initialization for the same root and rejects different pending roots', async () => {
    const runtimeState = globalThis as typeof globalThis & {
      __holoRuntime__?: {
        current?: unknown
        pending?: Promise<unknown>
        pendingProjectRoot?: string
      }
    }
    const root = resolve('/tmp/holo-runtime-pending')
    let releasePending: (() => void) | undefined
    const pending = new Promise<{ projectRoot: string }>((resolvePending) => {
      releasePending = () => resolvePending({ projectRoot: root })
    })

    runtimeState.__holoRuntime__ = {
      pending,
      pendingProjectRoot: root,
    }

    const sameRoot = initializeHolo(root)
    await expect(initializeHolo('/tmp/holo-runtime-other')).rejects.toThrow(
      `A Holo runtime is already initializing for "${root}".`,
    )

    releasePending?.()
    await expect(sameRoot).resolves.toEqual({ projectRoot: root })
    runtimeState.__holoRuntime__ = undefined
  })

  it('rejects direct initialization for a different project root while another runtime is current', async () => {
    const runtimeState = globalThis as typeof globalThis & {
      __holoRuntime__?: {
        current?: {
          projectRoot: string
          shutdown(): Promise<void>
        }
        pending?: Promise<unknown>
        pendingProjectRoot?: string
      }
    }
    const root = resolve('/tmp/holo-runtime-current')

    runtimeState.__holoRuntime__ = {
      current: {
        projectRoot: root,
        async shutdown() {},
      },
    }

    await expect(initializeHolo('/tmp/holo-runtime-other')).rejects.toThrow(
      `A Holo runtime is already initialized for "${root}".`,
    )

    runtimeState.__holoRuntime__ = undefined
  })

  it('rejects named connections that omit a driver but declare network settings', async () => {
    const root = await createProject()
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${packageEntry}

export default defineAppConfig({
  name: 'Broken App',
})
`, 'utf8')
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databasePackageEntry}

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      host: 'db.internal',
    },
  },
})
`, 'utf8')

    await expect(createHolo(root)).rejects.toThrow(
      'Connection "main" must declare a database driver when using host, port, username, password, or ssl settings.',
    )
  })
})

describe('@holo-js/core registry loader', () => {
  it('resolves and validates the generated registry path', async () => {
    const root = await createProject()
    await writeRegistry(root)

    expect(resolveGeneratedProjectRegistryPath(root)).toBe(join(root, '.holo-js/generated/registry.json'))
    expect(registryInternals.isGeneratedProjectRegistry({
      version: 1,
      generatedAt: '2026-03-31T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        generatedSchema: 'server/db/schema.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
    })).toBe(true)
    expect(registryInternals.isGeneratedProjectRegistry({
      version: 2,
      paths: {},
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
    })).toBe(false)
    expect(registryInternals.isGeneratedProjectRegistry(null)).toBe(false)
  })

  it('accepts legacy generated registries that predate queue job discovery', async () => {
    const root = await createProject()
    const registryPath = resolveGeneratedProjectRegistryPath(root)

    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await writeFile(registryPath, `${JSON.stringify({
      version: 1,
      generatedAt: '2026-03-31T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        generatedSchema: 'server/db/schema.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
    }, null, 2)}\n`, 'utf8')

    expect(registryInternals.isGeneratedProjectRegistry({
      version: 1,
      generatedAt: '2026-03-31T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: 'server/db/schema.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
      authorizationPolicies: [],
      authorizationAbilities: [],
    })).toBe(true)

    await expect(loadGeneratedProjectRegistry(root)).resolves.toEqual({
      version: 1,
      generatedAt: '2026-03-31T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: 'server/db/schema.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
      broadcast: [],
      channels: [],
      authorizationPolicies: [],
      authorizationAbilities: [],
    })
  })
})
