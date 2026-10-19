import { expect, it } from 'vitest'
import flux, { configureFluxClient, createFluxClient, fluxInternals, getFluxClient } from '../src'
import { startNativeTransport } from './support/native-transport'

it('delivers authorized whispers to other subscribers without echoing to the sender', async () => {
  const transport = await startNativeTransport()
  const manifest = {
    version: 1,
    generatedAt: '2026-10-12T00:00:00.000Z',
    events: [],
    channels: [{ name: 'App.Models.User.1', pattern: 'App.Models.User.1', type: 'private', params: [], whispers: ['typing.start'] }],
  } as const
  const senderConnector = transport.client.options.connector
  const recipientConnector = transport.createClient().options.connector
  if (!senderConnector || !recipientConnector) throw new Error('Missing native connectors')
  const senderClient = createFluxClient({ connector: senderConnector, manifest })
  const recipient = createFluxClient({ connector: recipientConnector, manifest })
  const sent: boolean[] = []
  const received: boolean[] = []
  const sender = senderClient.private('App.Models.User.1')
    .listenForWhisper('typing.start', payload => sent.push(Boolean(payload.editing)))
  recipient.private('App.Models.User.1')
    .listenForWhisper('typing.start', payload => received.push(Boolean(payload.editing)))
  recipient.channel('recipient.ready')
  await Promise.all([senderClient.connect(), recipient.connect()])
  await expect.poll(() => transport.subscriptions()).toBe(2)
  await sender.whisper('typing.start', { editing: true })
  await expect.poll(() => received).toEqual([true])
  expect(sent).toEqual([])
})

it('retains multiple real event and notification callbacks and removes only the leaving subscription', async () => {
  const transport = await startNativeTransport()
  const received: string[] = []
  const first = transport.client.private('App.Models.User.1')
    .listen('orders.updated', payload => received.push(`first:${payload.title}`))
    .listen('orders.updated', payload => received.push(`another:${payload.title}`))
    .notification(payload => received.push(`notice:${payload.type}`))
    .notification(payload => received.push(`other-notice:${payload.type}`))
  const second = transport.client.private('App.Models.User.1')
    .listen('orders.updated', payload => received.push(`second:${payload.title}`))
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('Created', { event: 'orders.updated', channels: ['private-App.Models.User.1'] })
  await expect.poll(() => received).toEqual(['first:Created', 'another:Created', 'second:Created'])
  await transport.publish('', { event: 'notifications.message', channels: ['private-App.Models.User.1'], payload: { type: 'OrderShipped' } })
  await expect.poll(() => received.slice(3)).toEqual(['notice:OrderShipped', 'other-notice:OrderShipped'])
  first.leaveChannel()
  await transport.publish('Updated', { event: 'orders.updated', channels: ['private-App.Models.User.1'] })
  await expect.poll(() => received.at(-1)).toBe('second:Updated')
  expect(await transport.subscriptions()).toBe(1)
  second.leaveChannel()
  await expect.poll(() => transport.subscriptions()).toBe(0)
})

it('accepts an application connector factory and delivers actual worker events', async () => {
  const transport = await startNativeTransport()
  const connector = transport.client.options.connector
  if (!connector) throw new Error('Missing native connector')
  const client = createFluxClient({ connectorFactory: () => connector })
  const delivered: string[] = []
  client.channel('feed').listen('feed.updated', payload => delivered.push(String(payload.title)))
  await client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('Native factory')
  await expect.poll(() => delivered).toEqual(['Native factory'])
  await client.disconnect()
  await expect.poll(() => transport.subscriptions()).toBe(0)
})

it('rejects connection attempts when the real worker is unavailable', async () => {
  const transport = await startNativeTransport()
  await transport.stop()
  await expect(transport.client.connect()).rejects.toThrow('WebSocket connection failed')
  expect(transport.client.getStatus()).toBe('disconnected')
})

it('rejects connection attempts when no broadcast app key is configured', async () => {
  const client = createFluxClient({
    connector: fluxInternals.createHoloWebSocketConnector({ host: '127.0.0.1', port: 9, key: '' }),
  })
  await expect(client.connect()).rejects.toThrow('Broadcast app key is not configured')
  expect(client.getStatus()).toBe('disconnected')
})

it('does not deliver private broadcasts when the real worker rejects channel authorization', async () => {
  const transport = await startNativeTransport()
  const delivered: string[] = []
  const barrier: string[] = []
  transport.client.private('unregistered').listen('feed.updated', payload => delivered.push(String(payload.title)))
  const observer = transport.createClient()
  observer.channel('barrier').listen('feed.updated', payload => barrier.push(String(payload.title)))
  await observer.connect()
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('Restricted', { channels: ['private-unregistered', 'barrier'] })
  await expect.poll(() => barrier).toEqual(['Restricted'])
  expect(delivered).toEqual([])
  expect(transport.client.getStatus()).toBe('connected')
})

it('retries a subscription the real worker refused when the channel is subscribed again', async () => {
  let allowed = false
  const transport = await startNativeTransport({ authorizeOrders: () => allowed })
  const delivered: string[] = []
  const barrier: string[] = []
  transport.client.private('orders.1').listen('order.shipped', payload => delivered.push(String(payload.title)))
  transport.client.channel('barrier').listen('order.shipped', payload => barrier.push(String(payload.title)))
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('Refused', { event: 'order.shipped', channels: ['private-orders.1', 'barrier'] })
  await expect.poll(() => barrier).toEqual(['Refused'])
  expect(delivered).toEqual([])
  allowed = true
  transport.client.private('orders.1')
  await expect.poll(() => transport.subscriptions()).toBe(2)
  await transport.publish('Shipped', { event: 'order.shipped', channels: ['private-orders.1', 'barrier'] })
  await expect.poll(() => delivered).toEqual(['Shipped'])
  expect(transport.client.getStatus()).toBe('connected')
})

it('leaves all subscriptions of one channel kind while retaining its other kind and unrelated channels', async () => {
  const transport = await startNativeTransport()
  configureFluxClient(transport.client)
  expect(getFluxClient()).toBe(transport.client)
  const received: string[] = []
  const first = flux.channel('App.Models.User.1').listen('feed.updated', () => received.push('public:first'))
  const second = flux.channel('App.Models.User.1').listen('feed.updated', () => received.push('public:second'))
  const privateChannel = flux.private('App.Models.User.1').listen('feed.updated', () => received.push('private'))
  flux.channel('barrier').listen('feed.updated', () => received.push('barrier'))
  await flux.connect()
  await expect.poll(() => transport.subscriptions()).toBe(3)
  first.leave()
  second.leaveChannel()
  first.leave()
  await expect.poll(() => transport.subscriptions()).toBe(2)
  await transport.publish('Remaining', { channels: ['App.Models.User.1', 'private-App.Models.User.1', 'barrier'] })
  await expect.poll(() => received).toEqual(['private', 'barrier'])
  privateChannel.leaveChannel()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await flux.disconnect()
  expect(flux.getStatus()).toBe('disconnected')
})

it('pauses and resumes an event list without losing registrations or duplicating delivery', async () => {
  const transport = await startNativeTransport()
  const received: string[] = []
  const barrier: string[] = []
  const feed = transport.client.channel('feed').listen(['feed.updated', 'feed.created'], payload => received.push(String(payload.title)))
  transport.client.channel('barrier').listen(['feed.updated', 'feed.created'], payload => barrier.push(String(payload.title)))
  expect(() => feed.listen('   ', () => undefined)).toThrow('must be a non-empty string')
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(2)
  await transport.publish('First')
  await expect.poll(() => received).toEqual(['First'])
  feed.stopListening()
  await transport.publish('Muted', { event: 'feed.created' })
  await expect.poll(() => barrier.at(-1)).toBe('Muted')
  expect(received).toEqual(['First'])
  feed.listen()
  await transport.publish('Resumed', { event: 'feed.created' })
  await expect.poll(() => received).toEqual(['First', 'Resumed'])
})
