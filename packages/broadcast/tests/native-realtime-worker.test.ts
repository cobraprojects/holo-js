import { once } from 'node:events'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import { normalizeBroadcastConfig, startBroadcastWorker } from '../src'
import { executeRealtimeMutation, executeRealtimeQuery, subscribeRealtimeQuery } from '../../realtime/src/server'
import { mutation, query } from '../../realtime/src'
import { openRealtimeDatabase } from '../../realtime/tests/helpers/native-database'

type Packet = { event: string; data: { id?: string; snapshot?: { data: { records: Array<{ id: number; score: number }> } }; result?: { data: { updated: number } } } }

async function startWorker(realtime: NonNullable<Parameters<typeof startBroadcastWorker>[0]['realtime']>) {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No native worker port available')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const worker = await startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'main', key: 'key', secret: 'secret' } },
      worker: { host: '127.0.0.1', port: address.port },
    }),
    realtime,
  })
  let stopped = false
  onTestFinished(async () => {
    if (!stopped) await worker.stop()
  })
  const socket = new WebSocket(`ws://${worker.host}:${worker.port}/app/key`)
  onTestFinished(() => socket.terminate())
  const packets: Packet[] = []
  socket.on('message', data => {
    const packet = JSON.parse(data.toString())
    packets.push({ ...packet, data: typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data })
  })
  await once(socket, 'open')
  await expect.poll(() => packets.some(packet => packet.event === 'pusher:connection_established')).toBe(true)
  return {
    socket, packets,
    baseUrl: `http://${worker.host}:${worker.port}`,
    send(id: string, action: string) {
      socket.send(JSON.stringify({ event: 'holo:realtime', data: { id, action, name: action === 'mutation' ? 'records.rename' : 'records.list', args: {} } }))
    },
    async stop() {
      await worker.stop()
      stopped = true
    },
  }
}

it('queries, subscribes, mutates and unsubscribes over native WebSockets using the real realtime SDK and SQLite', async () => {
  const { db } = await openRealtimeDatabase()
  const records = query({ name: 'records.list', access: 'public', handler: async () => ({ records: await db.table('records').orderBy('id').get() }) })
  const rename = mutation({ name: 'records.rename', access: 'public', handler: async () => ({ updated: (await db.table('records').where('id', 1).update({ score: 77 })).affectedRows }) })
  const worker = await startWorker({
    query: async () => await executeRealtimeQuery(records),
    mutate: async () => await executeRealtimeMutation(rename),
    subscribe: async (_name, _args, options) => await subscribeRealtimeQuery(records, {}, options),
  })
  worker.send('query', 'query')
  await expect.poll(() => worker.packets.find(packet => packet.data.id === 'query')?.data.snapshot?.data.records[0]?.score).toBe(10)
  worker.send('subscription', 'subscribe')
  await expect.poll(() => worker.packets.find(packet => packet.data.id === 'subscription')?.data.snapshot?.data.records[0]?.score).toBe(10)
  worker.send('mutation', 'mutation')
  await expect.poll(() => worker.packets.find(packet => packet.data.id === 'mutation')?.data.result?.data.updated).toBe(1)
  await expect.poll(() => worker.packets.some(packet => packet.data.id === 'subscription' && packet.event === 'holo:realtime:patch')).toBe(true)
  expect(await db.table('records').where('id', 1).first()).toMatchObject({ score: 77 })
  worker.send('subscription', 'unsubscribe')
  await expect.poll(() => worker.packets.some(packet => packet.event === 'holo:realtime:unsubscribed')).toBe(true)
  const patches = worker.packets.filter(packet => packet.event === 'holo:realtime:patch').length
  await db.table('records').where('id', 1).update({ score: 88 })
  worker.send('after-unsubscribe', 'query')
  await expect.poll(() => worker.packets.find(packet => packet.data.id === 'after-unsubscribe')?.data.snapshot?.data.records[0]?.score).toBe(88)
  expect(worker.packets.filter(packet => packet.event === 'holo:realtime:patch')).toHaveLength(patches)
})

it.each(['complete', 'fail'] as const)('closes native sockets and settles an in-flight real subscription that will %s during shutdown', async outcome => {
  const { db } = await openRealtimeDatabase()
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const entered = new Promise<void>(resolve => started = resolve)
  const pending = new Promise<void>(resolve => release = resolve)
  const records = query({
    name: 'records.list', access: 'public',
    handler: async () => {
      started?.()
      await pending
      return { records: await db.table(outcome === 'complete' ? 'records' : 'missing_records').get() }
    },
  })
  const worker = await startWorker({
    query: async () => await executeRealtimeQuery(records),
    mutate: async () => { throw new Error('No mutation is registered') },
    subscribe: async (_name, _args, options) => await subscribeRealtimeQuery(records, {}, options),
  })
  worker.send('pending', 'subscribe')
  await entered
  const closed = once(worker.socket, 'close')
  const stopped = worker.stop()
  try {
    expect((await closed)[0]).toBe(1001)
  } finally {
    release?.()
  }
  await stopped
  await expect(fetch(`${worker.baseUrl}/health`)).rejects.toThrow()
})
