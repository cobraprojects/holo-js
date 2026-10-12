import { get } from 'svelte/store'
import { expect, it } from 'vitest'
import type { BroadcastJsonObject } from '@holo-js/broadcast'
import { configureFluxClient } from '@holo-js/flux'
import { startNativeTransport } from '../../flux/tests/support/native-transport'
import { useFlux, useFluxConnectionStatus, useFluxModel, useFluxNotification, useFluxPresence, useFluxPrivate, useFluxPublic } from '../src'

it('receives real broadcasts through the default client and stops delivery after leaving', async () => {
  const transport = await startNativeTransport()
  configureFluxClient(transport.client)
  const delivered: string[] = []
  const received: string[] = []
  const barrier = transport.client.channel('barrier').listen('feed.updated', payload => received.push(String(payload.title)))
  const controls = useFluxPublic('feed', 'feed.updated', payload => delivered.push(String(payload.title)))
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(2)
  await transport.publish('First post')
  await expect.poll(() => delivered).toEqual(['First post'])
  controls.stopListening()
  await transport.publish('Muted post')
  await expect.poll(() => received.at(-1)).toBe('Muted post')
  controls.listen()
  await transport.publish('Second post')
  await expect.poll(() => delivered).toEqual(['First post', 'Second post'])
  controls.leaveChannel()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('After leaving')
  await expect.poll(() => received.at(-1)).toBe('After leaving')
  expect(delivered).toEqual(['First post', 'Second post'])
  barrier.leaveChannel()
  await expect.poll(() => transport.subscriptions()).toBe(0)
})

it('delivers native broadcast notifications and stops them when the subscription unmounts', async () => {
  const transport = await startNativeTransport()
  const delivered: BroadcastJsonObject[] = []
  const unmounts: Array<() => void> = []
  useFluxNotification('App.Models.User.1', payload => delivered.push(payload), {
    client: transport.client,
    onUnmount: cleanup => unmounts.push(cleanup),
  })
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  const notification = { type: 'OrderShipped', data: { orderId: 'order-1' } }
  await transport.publish('', { event: 'notifications.message', channels: ['private-App.Models.User.1'], payload: notification })
  await expect.poll(() => delivered).toEqual([notification])
  for (const cleanup of unmounts) cleanup()
  await expect.poll(() => transport.subscriptions()).toBe(0)
  await transport.publish('', { event: 'notifications.message', channels: ['private-App.Models.User.1'], payload: { type: 'OrderShipped', data: { orderId: 'order-2' } } })
  expect(delivered).toEqual([notification])
})

it('shares native private channels across helper aliases until their last listener leaves', async () => {
  const transport = await startNativeTransport()
  const delivered: string[] = []
  const options = { client: transport.client }
  const first = useFlux('App.Models.User.1', ['orders.updated', 'orders.shipped'], payload => delivered.push(`first:${payload.title}`), options)
  const second = useFluxPrivate('App.Models.User.1', 'orders.updated', payload => delivered.push(`second:${payload.title}`), options)
  const model = useFluxModel('App.Models.User.1', 'orders.updated', payload => delivered.push(`model:${payload.title}`), options)
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('Created', { event: 'orders.updated', channels: ['private-App.Models.User.1'] })
  await expect.poll(() => delivered).toEqual(['first:Created', 'second:Created', 'model:Created'])
  second.leaveChannel()
  model.leaveChannel()
  await transport.publish('Shipped', { event: 'orders.shipped', channels: ['private-App.Models.User.1'] })
  await expect.poll(() => delivered.at(-1)).toBe('first:Shipped')
  expect(await transport.subscriptions()).toBe(1)
  first.leaveChannel()
  await expect.poll(() => transport.subscriptions()).toBe(0)
})

it('updates real connection stores and removes callbacks when the native store unsubscribes', async () => {
  const { client } = await startNativeTransport()
  const changes: string[] = []
  const status = useFluxConnectionStatus({ client, onChange: value => changes.push(value) })
  const readings: string[] = []
  const unsubscribe = status.subscribe(value => readings.push(value))
  expect(get(status)).toBe('idle')
  await client.connect()
  await expect.poll(() => get(status)).toBe('connected')
  expect(readings).toEqual(['idle', 'connecting', 'connected'])
  unsubscribe()
  await client.disconnect()
  expect(changes).toEqual(['connecting', 'connected'])
  expect(readings).toEqual(['idle', 'connecting', 'connected'])
})

it('updates its native presence store after real joins and leaves and resumes after pausing', async () => {
  const transport = await startNativeTransport()
  const presence = useFluxPresence<{ id: string }>('chat.1', {}, { client: transport.client })
  await transport.client.connect()
  await expect.poll(() => get(presence.members)).toHaveLength(1)
  const membership = transport.client.presence('chat.1')
  const second = transport.createClient()
  second.presence('chat.1')
  await second.connect()
  await expect.poll(() => get(presence.members)).toHaveLength(2)
  const connectedMembers = [...get(presence.members)]
  presence.stopListening()
  await second.disconnect()
  await expect.poll(() => membership.members).toHaveLength(1)
  expect(get(presence.members)).toEqual(connectedMembers)
  presence.listen()
  await expect.poll(() => get(presence.members)).toHaveLength(1)
  expect(get(presence.members)[0]).toEqual(connectedMembers[0])
  membership.leaveChannel()
  presence.leaveChannel()
  await expect.poll(() => transport.subscriptions()).toBe(0)
})
