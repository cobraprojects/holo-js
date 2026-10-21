import { effectScope, nextTick } from 'vue'
import { expect, it } from 'vitest'
import { configureFluxClient } from '@holo-js/flux'
import { startNativeTransport } from '../../flux/tests/support/native-transport'
import { useFlux, useFluxConnectionStatus, useFluxNotification, useFluxPresence, useFluxPublic } from '../src'

it('receives native broadcasts and notifications through the default client until scope disposal', async () => {
  const transport = await startNativeTransport()
  configureFluxClient(transport.client)
  const events: string[] = []
  const notifications: string[] = []
  const barrier: string[] = []
  transport.client.channel('barrier').listen('feed.updated', payload => barrier.push(String(payload.title)))
  const scope = effectScope()
  const controls = scope.run(() => {
    useFluxNotification('App.Models.User.1', payload => notifications.push(String(payload.type)))
    return useFluxPublic('feed', 'feed.updated', payload => events.push(String(payload.title)))
  })
  if (!controls) throw new Error('Missing scope subscription')
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(3)
  await transport.publish('First post')
  await expect.poll(() => events).toEqual(['First post'])
  controls.stopListening()
  await transport.publish('Muted post')
  await expect.poll(() => barrier.at(-1)).toBe('Muted post')
  expect(events).toEqual(['First post'])
  controls.listen()
  await transport.publish('Second post')
  await expect.poll(() => events).toEqual(['First post', 'Second post'])
  await transport.publish('', { event: 'notifications.message', channels: ['private-App.Models.User.1'], payload: { type: 'OrderShipped' } })
  await expect.poll(() => notifications).toEqual(['OrderShipped'])
  scope.stop()
  await nextTick()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('After disposal')
  await expect.poll(() => barrier.at(-1)).toBe('After disposal')
  expect(events).toEqual(['First post', 'Second post'])
})

it('reacts to real presence joins and leaves, pauses updates, and resumes the current membership', async () => {
  const transport = await startNativeTransport()
  const scope = effectScope()
  const state = scope.run(() => ({
    presence: useFluxPresence<{ id: string }>('chat.1', {}, { client: transport.client }),
    status: useFluxConnectionStatus({ client: transport.client }),
  }))
  if (!state) throw new Error('Missing presence scope')
  await transport.client.connect()
  await expect.poll(() => state.presence.members).toHaveLength(1)
  const membership = transport.client.presence('chat.1')
  expect(state.status.value).toBe('connected')
  const second = transport.createClient()
  second.presence('chat.1')
  await second.connect()
  await expect.poll(() => state.presence.members).toHaveLength(2)
  const connectedMembers = [...state.presence.members]
  state.presence.stopListening()
  await second.disconnect()
  await expect.poll(() => membership.members).toHaveLength(1)
  expect(state.presence.members).toEqual(connectedMembers)
  state.presence.listen()
  await expect.poll(() => state.presence.members).toHaveLength(1)
  expect(state.presence.members[0]).toEqual(connectedMembers[0])
  membership.leaveChannel()
  scope.stop()
  await expect.poll(() => transport.subscriptions()).toBe(0)
})

it('uses explicit cleanup outside a Vue scope to stop native delivery', async () => {
  const transport = await startNativeTransport()
  const delivered: string[] = []
  const unmounts: Array<() => void> = []
  useFluxPublic('feed', 'feed.updated', payload => delivered.push(String(payload.title)), {
    client: transport.client,
    onUnmount: cleanup => unmounts.push(cleanup),
  })
  await transport.client.connect()
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('Before cleanup')
  await expect.poll(() => delivered).toEqual(['Before cleanup'])
  for (const cleanup of unmounts) cleanup()
  await expect.poll(() => transport.subscriptions()).toBe(0)
  await transport.publish('After cleanup')
  expect(delivered).toEqual(['Before cleanup'])
})

it('calls onError when the real worker refuses a private channel the composable subscribes to', async () => {
  const transport = await startNativeTransport({ authorizeOrders: () => false })
  const errors: string[] = []
  const scope = effectScope()
  scope.run(() => useFlux('orders.1', 'order.shipped', () => {}, { client: transport.client, onError: error => errors.push(error.message) }))
  await transport.client.connect()
  await expect.poll(() => errors).toEqual([
    '[@holo-js/flux] Subscription to orders.1 was refused: Unable to authorize the channel subscription.',
  ])
  scope.stop()
})
