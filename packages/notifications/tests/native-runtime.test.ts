import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import { normalizeDatabaseConfig } from '@holo-js/db'
import { runQueueWorker } from '@holo-js/queue'
import { createCoreNotificationStore } from '../../core/src/portable/notificationPersistence'
import { createSQLiteQueueHarness, type SQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'
import migration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044032_create_notifications'
import {
  configureNotificationsRuntime,
  defineNotification,
  listNotifications,
  type NotificationChannel,
  normalizeNotificationsConfig,
  notify,
  notifyMany,
  notifyUsing,
  registerNotificationChannel,
  resetNotificationChannelRegistry,
  resetNotificationsRuntime,
} from '../src'

declare module '../src/contracts' {
  interface HoloNotificationChannelRegistry {
    readonly flaky: NotificationChannel<unknown, unknown, void>
  }
}

let harness: SQLiteQueueHarness
const recipient = { id: 'native-recipient', type: 'users' }
const query = { recipient, type: 'native.delivery' }
const definition = {
  type: 'native.delivery',
  via: () => ['database'] as const,
  build: { database: () => ({ data: { delivered: true } }) },
}

beforeEach(async () => {
  harness = await createSQLiteQueueHarness()
  await migration.up({ schema: harness.schema, db: harness.connection })
  configureNotificationsRuntime({
    config: normalizeNotificationsConfig({ queue: { connection: 'database', queue: 'configured', afterCommit: true } }),
    store: createCoreNotificationStore({
      database: normalizeDatabaseConfig({ defaultConnection: 'default', connections: { default: { driver: 'sqlite', url: ':memory:' } } }),
      notifications: normalizeNotificationsConfig(),
    }),
  })
})

afterEach(async () => {
  resetNotificationsRuntime()
  await harness.cleanup()
})

it('keeps immediate and lazy iterable delivery out of the queue despite configured queue defaults', async () => {
  let consumed = false
  function* targets() {
    consumed = true
    yield recipient
    yield { ...recipient, id: 'second-recipient' }
  }
  const pending = notifyMany(targets(), defineNotification(definition))
  expect(consumed).toBe(false)
  expect((await listNotifications(query, { limit: 20, offset: 0 })).total).toBe(0)
  expect((await pending).channels.map(result => result.queued)).toEqual([false, false])
  expect(consumed).toBe(true)
  expect((await listNotifications(query, { limit: 20, offset: 0 })).total).toBe(1)
  expect(await harness.readJobRows()).toEqual([])
})

it('resolves queue and delay precedence through reservation and delivery rather than a fake dispatcher', async () => {
  const notification = defineNotification({
    ...definition,
    queue: () => ({ connection: 'database', queue: 'definition' }),
    delay: () => 60,
  })
  const result = await notify(recipient, notification).onQueue('fluent').delay(30).delayFor('database', 0)
  expect(result.channels).toEqual([{ channel: 'database', targetIndex: 0, queued: true, success: true }])
  expect((await listNotifications(query, { limit: 20, offset: 0 })).total).toBe(0)
  expect((await runQueueWorker({ connection: 'database', queueNames: ['configured', 'definition'], stopWhenEmpty: true })).processed).toBe(0)
  expect((await runQueueWorker({ connection: 'database', queueNames: ['fluent'], stopWhenEmpty: true })).processed).toBe(1)
  expect((await listNotifications(query, { limit: 20, offset: 0 })).records[0]?.data).toEqual({ delivered: true })
  expect(await harness.readJobRows()).toEqual([])
})

it('rejects invalid queue resolvers and recipients without persisting delivery or jobs', async () => {
  for (const queue of [{ queue: ' ' }, { delay: -1 }]) {
    const result = await notify(recipient, defineNotification({ ...definition, queue: () => queue }))
    expect(result.channels[0]).toMatchObject({ success: false, queued: false, error: expect.any(Error) })
  }
  for (const delay of [-1, Number.NaN, new Date('invalid')]) {
    const result = await notify(recipient, defineNotification({ ...definition, delay: () => delay }))
    expect(result.channels[0]).toMatchObject({ success: false, queued: false, error: expect.any(Error) })
  }
  for (const id of ['', ' ', Number.NaN]) {
    const result = await notify({ ...recipient, id }, defineNotification(definition))
    expect(result.channels[0]).toMatchObject({ success: false, error: expect.any(Error) })
  }
  expect(() => notify(recipient, defineNotification(definition)).deduplicate('line\nbreak')).toThrow('printable ASCII')
  await expect(notify(recipient, defineNotification({ ...definition, via: () => ['broadcast'], build: { broadcast: () => ({ data: {} }) } })).deduplicate('key').dispatch()).rejects.toThrow('built-in database')
  expect((await listNotifications(query, { limit: 20, offset: 0 })).total).toBe(0)
  expect(await harness.readJobRows()).toEqual([])
})

it('delivers a queued plugin notification after runtime reload using the actual database worker', async () => {
  const project = await mkdtemp(join(tmpdir(), 'holo-native-notification-plugin-'))
  onTestFinished(() => rm(project, { recursive: true, force: true }))
  const plugin = join(project, 'node_modules/holo-plugin-delivery')
  const receipt = join(project, 'receipt.json')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'holo-plugin-delivery', type: 'module', holo: { plugin: './plugin.mjs' } }))
  await writeFile(join(plugin, 'plugin.mjs'), "export default { id: 'delivery', contributes: { notifications: { channels: { plugin: { runtime: './channel.mjs' } } } } }")
  await writeFile(join(plugin, 'channel.mjs'), `import { writeFile } from 'node:fs/promises'
export default { async send(context) { await writeFile(${JSON.stringify(receipt)}, JSON.stringify({ route: context.route, payload: context.payload })) } }`)
  configureNotificationsRuntime({ projectRoot: project, plugins: ['holo-plugin-delivery'] })
  const result = await notifyUsing().channel('plugin', { token: 'recipient' }).notify(defineNotification({
    type: 'native.plugin',
    queue: true,
    via: () => ['plugin'] as const,
    build: { plugin: () => ({ text: 'Queued plugin delivery' }) },
  })).onConnection('database').onQueue('plugin')
  expect(result.channels).toEqual([{ channel: 'plugin', targetIndex: 0, queued: true, success: true }])
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
  resetNotificationsRuntime()
  resetNotificationChannelRegistry()
  configureNotificationsRuntime({ projectRoot: project, plugins: ['holo-plugin-delivery'] })
  expect((await runQueueWorker({ connection: 'database', queueNames: ['plugin'], stopWhenEmpty: true })).processed).toBe(1)
  expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({ route: { token: 'recipient' }, payload: { text: 'Queued plugin delivery' } })
})

it.each([
  { id: ' ', type: 'users' },
  { id: 'recipient', type: 'x'.repeat(201) },
  { id: 'x'.repeat(201), type: 'users' },
  { id: Number.POSITIVE_INFINITY, type: 'users' },
])('rejects invalid anonymous database routes without inserting notifications: %j', async route => {
  const result = await notifyUsing().channel('database', route).notify(defineNotification(definition))
  expect(result.channels[0]).toMatchObject({ channel: 'database', success: false, error: expect.any(Error) })
  expect((await listNotifications(query, { limit: 20, offset: 0 })).total).toBe(0)
  expect(await harness.readJobRows()).toEqual([])
})

it('persists queued notification tries and retries a failed delivery after its backoff', async () => {
  let sends = 0
  registerNotificationChannel('flaky', {
    async send() {
      sends += 1
      if (sends === 1) throw new Error('transient')
    },
  })
  onTestFinished(() => resetNotificationChannelRegistry())
  const notification = defineNotification({
    type: 'native.flaky',
    via: () => ['flaky'] as const,
    build: { flaky: () => ({ data: { delivered: true } }) },
    queue: () => ({ connection: 'database', queue: 'flaky', tries: 2, backoff: 1 }),
  })
  await notify(recipient, notification)
  expect((await harness.readJobRows())[0]?.max_attempts).toBe(2)
  expect(await runQueueWorker({ connection: 'database', queueNames: ['flaky'], once: true }))
    .toMatchObject({ processed: 0, released: 1, failed: 0 })
  await new Promise(resolve => setTimeout(resolve, 1100))
  expect(await runQueueWorker({ connection: 'database', queueNames: ['flaky'], once: true })).toMatchObject({ processed: 1, failed: 0 })
  expect(sends).toBe(2)
})

it('validates notification queue tries and backoff in configuration', () => {
  expect(normalizeNotificationsConfig({ queue: { tries: 3, backoff: [1, 5] } }).queue).toMatchObject({ tries: 3, backoff: [1, 5] })
  expect(() => normalizeNotificationsConfig({ queue: { tries: 0 } }))
    .toThrow('[@holo-js/notifications] Notifications queue tries must be an integer greater than or equal to 1.')
  expect(() => normalizeNotificationsConfig({ queue: { backoff: [] } }))
    .toThrow('[@holo-js/notifications] Notifications queue backoff must be an integer greater than or equal to 0 or a non-empty array of them.')
})

it('honors delay returned by a queue resolver and lets fluent delay override it', async () => {
  const notification = defineNotification({ ...definition, queue: () => ({ queue: 'delayed', delay: 60 }) })
  await notify(recipient, notification)
  expect((await runQueueWorker({ connection: 'database', queueNames: ['delayed'], stopWhenEmpty: true })).processed).toBe(0)
  expect((await listNotifications(query, { limit: 20, offset: 0 })).total).toBe(0)
  await notify(recipient, notification).delay(0)
  expect((await runQueueWorker({ connection: 'database', queueNames: ['delayed'], stopWhenEmpty: true })).processed).toBe(1)
  expect((await listNotifications(query, { limit: 20, offset: 0 })).total).toBe(1)
})
