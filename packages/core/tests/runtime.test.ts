import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, useConfig } from '@holo-js/config'
import { createSchemaService, DB } from '@holo-js/db'
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
  getQueueRuntime,
  listFailedQueueJobs,
  listRegisteredQueueJobs,
  persistFailedQueueJob,
  Queue,
  queueRuntimeInternals,
  registerQueueJob,
  resetQueueRegistry,
} from '@holo-js/queue'
import type * as HoloQueueModule from '@holo-js/queue'
import type * as PortableHoloModule from '../src/portable/holo'
import { createHoloAdapterProject, createHoloFrameworkAdapter, initializeHoloAdapterProject } from '../src'
import {
  createHolo,
  getHolo,
  ensureHolo,
  initializeHolo,
  loadGeneratedProjectRegistry,
  peekHolo,
  registryInternals,
  resetHoloRuntime,
  resolveGeneratedProjectRegistryPath,
  holoRuntimeInternals,
} from '../src/portable'
import { useStorage } from '@holo-js/storage/runtime'

const packageEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const tempDirs: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-runtime-'))
  tempDirs.push(root)
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
import { defineDatabaseConfig } from ${packageEntry}

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

async function writeQueueConfig(root: string, contents: string): Promise<void> {
  await writeFile(join(root, 'config/queue.ts'), contents, 'utf8')
}

async function writeRegistry(
  root: string,
  options: {
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
    models: [
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
  resetQueueRegistry()
  resetEventsRegistry()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/core portable runtime', () => {
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

  it('does not require @holo-js/queue-db for the implicit default sync queue runtime', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    const importOptionalModule = vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(
      async <TModule>(specifier: string): Promise<TModule | undefined> => {
        if (specifier === '@holo-js/queue-db') {
          return undefined
        }

        return await import(specifier) as TModule
      },
    )

    const runtime = await initializeHolo(root)
    expect(runtime.queue.config.default).toBe('sync')
    await runtime.shutdown()
    importOptionalModule.mockRestore()
  })

  it('does not import discovered queue jobs during default runtime initialization', async () => {
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

    const runtime = await initializeHolo(root)

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
    await expect(Queue.dispatchSync<{ value: number }, number>('reports.send-digest', { value: 21 })).resolves.toBe(42)
    await expect(Queue.dispatchSync<Record<string, never>, string>('cache.prune', {})).resolves.toBe('done')

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

    await expect(Queue.dispatchSync<{ value: number }, number>('reports.aliased', { value: 14 })).resolves.toBe(42)

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
    await expect(Queue.dispatchSync<Record<string, never>, string>('send-email', {})).resolves.toBe('custom-root')

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
    await expect(Queue.dispatchSync<Record<string, never>, string>('reports.send-digest', {})).resolves.toBe('manual')
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

    await expect(Queue.dispatchSync<Record<string, never>, string>('reports.send-digest', {})).resolves.toBe('project-version')

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
    await expect(Queue.dispatchSync<Record<string, never>, string>('reports.send-digest', {})).resolves.toBe('first-version')
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
    await expect(Queue.dispatchSync<Record<string, never>, string>('reports.send-digest', {})).resolves.toBe('second-version')
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
      await expect(Queue.dispatchSync<Record<string, never>, string>('reports.direct', {})).resolves.toBe('direct-import')
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
import { defineQueueConfig } from ${packageEntry}

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
import { defineQueueConfig } from ${packageEntry}

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
import { defineDatabaseConfig } from ${packageEntry}

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
import { defineQueueConfig } from ${packageEntry}

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

  it('loads the implicit database failed-job store when queue config is omitted', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${packageEntry}

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
import { defineQueueConfig } from ${packageEntry}

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

    const initialized = await initializeHoloAdapterProject(root)

    expect(initialized.runtime.initialized).toBe(true)
    expect(getHolo()).toBe(initialized.runtime)

    const reused = await initializeHoloAdapterProject(root)
    expect(reused.runtime).toBe(initialized.runtime)
    expect(reused.registry?.commands[0]?.name).toBe('inspire')
  })

  it('reconfigures queue runtime when framework adapters reuse the current singleton runtime', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeRegistry(root)
    await writeQueueConfig(root, `
import { defineQueueConfig } from ${packageEntry}

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

  it('disconnects initialized DB connections when queue runtime setup fails after DB boot', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    vi.resetModules()
    vi.doMock('@holo-js/queue', async () => {
      const actual = await vi.importActual('@holo-js/queue') as typeof HoloQueueModule
      return {
        ...actual,
        configureQueueRuntime() {
          throw new Error('queue init failed')
        },
      }
    })

    try {
      const portable = await import('../src/portable')
      const runtime = await portable.createHolo(root)

      await expect(runtime.initialize()).rejects.toThrow('queue init failed')
      expect(runtime.manager.connection().isConnected()).toBe(false)
      expect(() => portable.getHolo()).toThrow('Holo runtime is not initialized.')
      expect(() => useConfig('app')).toThrow('Holo config runtime is not configured.')
    } finally {
      vi.doUnmock('@holo-js/queue')
      vi.resetModules()
    }
  })

  it('fails runtime initialization when queue config is present but the queue package is missing', async () => {
    const root = await createProject()
    await writeBaseConfig(root)
    await writeQueueConfig(root, `
import { defineQueueConfig } from ${packageEntry}

export default defineQueueConfig({
  default: 'sync',
})
`)

    vi.resetModules()

    try {
      const portable = await import('../src/portable')
      const originalImportOptionalModule = portable.holoRuntimeInternals.moduleInternals.importOptionalModule
      vi.spyOn(portable.holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(async (specifier) => {
        if (specifier === '@holo-js/queue') {
          return undefined
        }

        return await originalImportOptionalModule(specifier)
      })

      const runtime = await portable.createHolo(root)

      await expect(runtime.initialize()).rejects.toThrow(
        '[@holo-js/core] Queue support requires @holo-js/queue to be installed.',
      )
      expect(runtime.manager.connection().isConnected()).toBe(false)
      expect(() => portable.getHolo()).toThrow('Holo runtime is not initialized.')
      expect(() => useConfig('app')).toThrow('Holo config runtime is not configured.')
    } finally {
      vi.restoreAllMocks()
      vi.resetModules()
    }
  })

  it('keeps runtime.queue readable when queue support is not installed and no queue config is present', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    vi.resetModules()

    try {
      const portable = await import('../src/portable')
      const originalImportOptionalModule = portable.holoRuntimeInternals.moduleInternals.importOptionalModule
      vi.spyOn(portable.holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(async (specifier) => {
        if (specifier === '@holo-js/queue') {
          return undefined
        }

        return await originalImportOptionalModule(specifier)
      })

      const runtime = await portable.createHolo(root)
      await runtime.initialize()

      expect(runtime.queue.config.default).toBe('sync')
      expect(runtime.queue.config.failed).toEqual(expect.objectContaining({
        driver: 'database',
        connection: 'default',
        table: 'failed_jobs',
      }))
      expect([...runtime.queue.drivers.values()]).toEqual([])

      await runtime.shutdown()
    } finally {
      vi.restoreAllMocks()
      vi.resetModules()
    }
  })

  it('treats Windows-style queue config paths as configured when queue support is missing', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof import('@holo-js/config')
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          app: actual.holoAppDefaults,
          database: {
            defaultConnection: 'default',
            connections: {
              default: {
                driver: 'sqlite',
                url: ':memory:',
                logging: false,
              },
            },
          },
          storage: actual.holoStorageDefaults,
          queue: actual.normalizeQueueConfigForHolo({
            default: 'sync',
            failed: false,
          }),
          media: {},
          custom: {},
          all: {} as never,
          environment: {
            name: 'development',
            values: {},
            loadedFiles: [],
            warnings: [],
          },
          loadedFiles: [
            'C:\\workspace\\app\\config\\queue.ts',
          ],
          warnings: [],
        })),
      }
    })

    try {
      const portable = await import('../src/portable')
      const originalImportOptionalModule = portable.holoRuntimeInternals.moduleInternals.importOptionalModule
      vi.spyOn(portable.holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(async (specifier) => {
        if (specifier === '@holo-js/queue') {
          return undefined
        }

        return await originalImportOptionalModule(specifier)
      })

      const runtime = await portable.createHolo(root)

      await expect(runtime.initialize()).rejects.toThrow(
        '[@holo-js/core] Queue support requires @holo-js/queue to be installed.',
      )
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.restoreAllMocks()
      vi.resetModules()
    }
  })

  it('treats Windows-style storage config paths as configured when storage support is missing', async () => {
    const root = await createProject()
    await writeBaseConfig(root)

    vi.resetModules()
    vi.doMock('@holo-js/config', async () => {
      const actual = await vi.importActual('@holo-js/config') as typeof import('@holo-js/config')
      return {
        ...actual,
        loadConfigDirectory: vi.fn(async () => ({
          app: actual.holoAppDefaults,
          database: {
            defaultConnection: 'default',
            connections: {
              default: {
                driver: 'sqlite',
                url: ':memory:',
                logging: false,
              },
            },
          },
          storage: actual.normalizeStorageConfig({
            disks: {
              local: {
                driver: 'local',
                root: './storage/app',
              },
            },
          }),
          queue: actual.holoQueueDefaultsNormalized,
          media: {},
          custom: {},
          all: {} as never,
          environment: {
            name: 'development',
            values: {},
            loadedFiles: [],
            warnings: [],
          },
          loadedFiles: [
            'C:\\workspace\\app\\config\\storage.ts',
          ],
          warnings: [],
        })),
      }
    })

    try {
      const portable = await import('../src/portable')
      const originalImportOptionalModule = portable.holoRuntimeInternals.moduleInternals.importOptionalModule
      vi.spyOn(portable.holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(async (specifier) => {
        if (specifier === '@holo-js/storage') {
          return undefined
        }

        return await originalImportOptionalModule(specifier)
      })

      const runtime = await portable.createHolo(root)

      await expect(runtime.initialize()).rejects.toThrow(
        '[@holo-js/core] Storage support requires @holo-js/storage to be installed.',
      )
    } finally {
      vi.doUnmock('@holo-js/config')
      vi.restoreAllMocks()
      vi.resetModules()
    }
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
import { defineDatabaseConfig } from ${packageEntry}

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
        generatedSchema: 'server/db/schema.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
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
        generatedSchema: 'server/db/schema.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
    })
  })
})
