import { readFile, rm } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

export async function assertExampleAppNotificationBehavior(projectRoot, DB, runMaintenance) {
  const require = createRequire(join(projectRoot, 'package.json'))
  const {
    defineNotification, notify, notifyMany, listNotifications, unreadNotifications,
    markNotificationsAsRead, markAllNotificationsAsRead, markNotificationsAsUnread,
    deleteNotifications, clearNotifications, notificationsRuntimeInternals,
  } = await import(pathToFileURL(require.resolve('@holo-js/notifications')).href)
  await assertQueuedMail(projectRoot, require, DB, runMaintenance)
  const startedAt = Date.now()
  const recipient = { id: `notifications-${randomUUID()}`, type: 'users' }
  const other = { id: `notifications-${randomUUID()}`, type: 'users' }
  const query = { recipient, type: 'native.behavior' }
  const otherQuery = { recipient: other, type: 'native.behavior' }
  const pagination = { limit: 20, offset: 0 }
  const definition = {
    type: 'native.behavior',
    via: () => ['database'],
    build: { database: target => ({ data: { tenant: { id: 'native-tenant' }, text: target.text ?? 'delivered' } }) },
  }
  const notification = defineNotification(definition)
  const list = scope => listNotifications(scope, pagination)
  try {
    await notifyMany([recipient, other], notification).deduplicate('native-key')
    await notify(recipient, notification).deduplicate('native-key')
    assert.equal((await list(query)).total, 1)
    assert.equal((await list(otherQuery)).total, 1)
    await notify(recipient, notification)
    const page = await list({ ...query, dataMatches: [{ path: ['tenant', 'id'], value: 'native-tenant' }] })
    assert.equal(page.total, 2)
    assert.equal(page.unread, 2)
    for (const record of page.records) {
      assert.ok(Number.isFinite(record.createdAt.getTime()))
      assert.ok(record.createdAt.getTime() >= startedAt - 1000)
      assert.ok(Number.isFinite(record.updatedAt.getTime()))
    }
    assert.deepEqual(page.records.map(record => record.data), [
      { tenant: { id: 'native-tenant' }, text: 'delivered' },
      { tenant: { id: 'native-tenant' }, text: 'delivered' },
    ])
    const ids = page.records.map(record => record.id)
    const foreignId = (await list(otherQuery)).records[0].id
    assert.equal((await list({ ...query, id: foreignId })).total, 0)
    assert.deepEqual((await notificationsRuntimeInternals.findNotifications(query, [...ids, foreignId])).map(record => record.id).sort(), [...ids].sort())
    assert.deepEqual(await notificationsRuntimeInternals.findNotifications(query, [foreignId]), [])
    assert.equal(await markNotificationsAsRead(query, [ids[0], ids[0], foreignId]), 1)
    assert.equal((await unreadNotifications(query, pagination)).total, 1)
    assert.equal(await markAllNotificationsAsRead(query), 1)
    assert.equal(await markAllNotificationsAsRead(query), 0)
    assert.equal((await unreadNotifications(query, pagination)).total, 0)
    for (const record of (await list(query)).records) {
      assert.ok(record.readAt instanceof Date && Number.isFinite(record.readAt.getTime()))
      assert.ok(record.readAt.getTime() >= startedAt - 1000)
    }
    assert.equal(await markNotificationsAsUnread(query, [ids[0], foreignId]), 1)
    assert.equal(await deleteNotifications(query, [ids[0], foreignId]), 1)
    assert.equal(await clearNotifications(query), 1)
    assert.equal((await list(otherQuery)).total, 1)
    await assert.rejects(list({ ...query, dataMatches: [{ path: ['__proto__'], value: 'invalid' }] }), /unsafe|invalid|prototype|path/i)
    await assert.rejects(listNotifications(query, { limit: -1, offset: 0 }))
    await assert.rejects(listNotifications(query, { limit: 101, offset: 0 }))
    await assert.rejects(listNotifications(query, { limit: 20, offset: -1 }))
    await assert.rejects(list({ ...query, dataMatches: [{ path: ['tenant'], value: { id: 'invalid' } }] }), /JSON scalars/)
    await assert.rejects(list({ ...query, id: ' ' }), /query ids/)
    await assert.rejects(list({ ...query, type: 42 }), /strings/)
    await assert.rejects(markNotificationsAsRead(query, Array.from({ length: 101 }, (_, index) => `invalid-${index}`)), /at most 100/)
    await assert.rejects(notificationsRuntimeInternals.findNotifications(query, [' ']), /Notification id at index 0 must be a non-empty string/)
    assert.equal((await list(query)).total, 0)

    const partial = await notify(recipient, defineNotification({
      ...definition,
      via: () => ['database', 'broadcast'],
      build: { ...definition.build, broadcast: () => ({ data: {} }) },
    }))
    assert.deepEqual(partial.channels.map(result => [result.channel, result.success]), [['database', true], ['broadcast', false]])
    assert.equal((await list(query)).total, 1)
    await clearNotifications(query)
    await notify(recipient, notification).afterCommit()
    assert.equal((await list(query)).total, 1)
    await clearNotifications(query)

    const committed = { ...recipient, text: 'before-commit' }
    await DB.transaction(async () => {
      await notify(committed, notification).afterCommit()
      assert.equal((await list(query)).total, 0)
      committed.text = 'after-commit'
    })
    assert.equal((await list(query)).records[0].data.text, 'after-commit')
    await clearNotifications(query)
    await assert.rejects(DB.transaction(async () => {
      await notify(recipient, notification).afterCommit()
      throw new Error('notification rollback')
    }), /notification rollback/)
    assert.equal((await list(query)).total, 0)

    const queued = defineNotification({ ...definition, queue: true })
    await notify(recipient, queued).onConnection('database').onQueue('native-notifications')
    assert.equal((await list(query)).total, 0)
    assert.match(runMaintenance('queue:work', '--connection', 'database', '--queue', 'native-notifications', '--once'), /processed=1 released=0 failed=0/)
    assert.equal((await list(query)).total, 1)
    await clearNotifications(query)
    await notify(recipient, queued).onConnection('database').onQueue('native-notifications').delay(1)
    const { runQueueWorker } = await import(pathToFileURL(require.resolve('@holo-js/queue')).href)
    assert.equal((await runQueueWorker({ connection: 'database', queueNames: ['native-notifications'], stopWhenEmpty: true })).processed, 0)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.match(runMaintenance('queue:work', '--connection', 'database', '--queue', 'native-notifications', '--once'), /processed=1 released=0 failed=0/)
    assert.equal((await list(query)).total, 1)
    await assertNotificationBroadcast(notify, defineNotification, runMaintenance)
  } finally {
    await clearNotifications(query)
    await clearNotifications(otherQuery)
    await DB.table('jobs').where('queue', 'native-notifications').delete()
  }
}

async function assertQueuedMail(projectRoot, require, DB, runMaintenance) {
  const { defineMail, sendMail } = await import(pathToFileURL(require.resolve('@holo-js/mail')).href)
  const result = await sendMail(defineMail({ to: 'native@example.test', subject: 'Native worker mail', text: 'Delivered by a fresh CLI worker' }))
    .using('preview').onConnection('database').onQueue('native-mail')
  const artifactPath = join(projectRoot, '.holo-js/runtime/mail-preview', `${result.messageId}.json`)
  try {
    assert.equal(result.queued, true)
    await assert.rejects(readFile(artifactPath), { code: 'ENOENT' })
    assert.match(runMaintenance('queue:work', '--connection', 'database', '--queue', 'native-mail', '--once'), /processed=1 released=0 failed=0/)
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
    assert.equal(artifact.mail.subject, 'Native worker mail')
    assert.equal(artifact.mail.text, 'Delivered by a fresh CLI worker')
    assert.equal(artifact.context.queued, true)
  } finally {
    await rm(artifactPath, { force: true })
    await DB.table('jobs').where('queue', 'native-mail').delete()
  }
}

async function assertNotificationBroadcast(notify, defineNotification, runMaintenance) {
  const socket = new WebSocket(`ws://${process.env.BROADCAST_HOST}:${process.env.BROADCAST_PORT}/app/${process.env.BROADCAST_APP_KEY ?? 'app-key'}`)
  const packets = []
  socket.addEventListener('message', event => packets.push(JSON.parse(String(event.data))))
  const receive = async name => {
    while (!packets.some(packet => packet.event === name)) await once(socket, 'message', { signal: AbortSignal.timeout(5000) })
    return packets.find(packet => packet.event === name)
  }
  const definition = {
    type: 'native.broadcast',
    via: () => ['broadcast'],
    build: { broadcast: target => ({ event: target.event, data: { delivered: target.event } }) },
  }
  const target = { routeNotificationForBroadcast: () => ['native.notifications'], event: 'native.immediate-notification' }
  try {
    await receive('pusher:connection_established')
    socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'native.notifications' } }))
    await receive('pusher_internal:subscription_succeeded')
    await notify(target, defineNotification(definition))
    assert.deepEqual(JSON.parse((await receive(target.event)).data), { type: definition.type, data: { delivered: target.event } })
    const queuedEvent = 'native.queued-notification'
    const queued = await notify({ ...target, event: queuedEvent }, defineNotification({ ...definition, queue: true })).onConnection('database').onQueue('native-notifications')
    assert.deepEqual(queued.channels, [{ channel: 'broadcast', targetIndex: 0, queued: true, success: true }])
    assert.ok(!packets.some(packet => packet.event === queuedEvent))
    assert.match(runMaintenance('queue:work', '--connection', 'database', '--queue', 'native-notifications', '--once'), /processed=1 released=0 failed=0/)
    assert.deepEqual(JSON.parse((await receive(queuedEvent)).data), { type: definition.type, data: { delivered: queuedEvent } })
  } finally {
    socket.close()
  }
}
