import { jsx } from 'react/jsx-runtime'
import { expect, it } from 'vitest'
import { configureFluxClient } from '@holo-js/flux'
import { startNativeTransport } from '../../flux/tests/support/native-transport'
import { useFlux, useFluxConnectionStatus, useFluxNotification, useFluxPresence, useFluxPublic } from '../src'

it('receives native notifications and broadcasts once across rerenders and cleans up on unmount', async () => {
  const transport = await startNativeTransport()
  configureFluxClient(transport.client)
  const events: string[] = []
  const notifications: unknown[] = []
  const barrier: string[] = []
  transport.client.channel('barrier').listen('feed.updated', payload => barrier.push(String(payload.title)))
  let controls: ReturnType<typeof useFluxPublic> | undefined
  function Probe() {
    useFluxNotification('App.Models.User.1', payload => notifications.push(payload))
    controls = useFluxPublic<'feed.updated'>('feed', 'feed.updated', payload => events.push(String(payload.title)), { client: transport.client })
    return null
  }
  const { act, create } = await import('react-test-renderer')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(jsx(Probe, {}))
    await transport.client.connect()
  })
  await expect.poll(() => transport.subscriptions()).toBe(3)
  await act(async () => {
    renderer?.update(jsx(Probe, {}))
  })
  if (!controls) throw new Error('Missing component subscription')
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
  await expect.poll(() => notifications).toEqual([{ type: 'OrderShipped' }])
  await act(async () => {
    renderer?.unmount()
  })
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('After unmount')
  await expect.poll(() => barrier.at(-1)).toBe('After unmount')
  expect(events).toEqual(['First post', 'Second post'])
})

it('renders real presence membership and resumes the latest snapshot after pausing', async () => {
  const transport = await startNativeTransport()
  let presence: ReturnType<typeof useFluxPresence<{ id: string }>> | undefined
  const observations: Array<readonly { id: string }[]> = []
  function Probe() {
    presence = useFluxPresence<{ id: string }>('chat.1', { onHere: members => observations.push(members) }, { client: transport.client })
    return null
  }
  const { act, create } = await import('react-test-renderer')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(jsx(Probe, {}))
    await transport.client.connect()
  })
  const memberCount = async () => {
    await act(async () => undefined)
    return presence?.members.length
  }
  await expect.poll(memberCount).toBe(1)
  const membership = transport.client.presence('chat.1')
  const second = transport.createClient()
  second.presence('chat.1')
  await second.connect()
  await expect.poll(memberCount).toBe(2)
  const connectedMembers = [...(presence?.members ?? [])]
  presence?.stopListening()
  await second.disconnect()
  await expect.poll(() => membership.members).toHaveLength(1)
  await act(async () => undefined)
  expect(presence?.members).toEqual(connectedMembers)
  await act(async () => {
    presence?.listen()
  })
  await expect.poll(memberCount).toBe(1)
  expect(presence?.members[0]).toEqual(connectedMembers[0])
  expect(observations.map(members => members.length)).toEqual([0, 1, 2, 1])
  expect(observations[2]).toEqual(connectedMembers)
  membership.leaveChannel()
  await act(async () => renderer?.unmount())
  await expect.poll(() => transport.subscriptions()).toBe(0)
})

it('observes real connection changes when a callback is added after mounting', async () => {
  const transport = await startNativeTransport()
  const changes: string[] = []
  let renderedStatus = ''
  function Probe({ enabled }: { enabled: boolean }) {
    renderedStatus = useFluxConnectionStatus({
      client: transport.client,
      ...(enabled ? { onChange: (status: string) => changes.push(status) } : {}),
    })
    return null
  }
  const { act, create } = await import('react-test-renderer')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(jsx(Probe, { enabled: false }))
  })
  expect(renderedStatus).toBe('idle')
  await act(async () => renderer?.update(jsx(Probe, { enabled: true })))
  await act(async () => transport.client.connect())
  expect(changes).toEqual(['connecting', 'connected'])
  expect(renderedStatus).toBe('connected')
  await act(async () => renderer?.unmount())
  await transport.client.disconnect()
  expect(changes).toEqual(['connecting', 'connected'])
})

it('renders the actual initial connection status on the server', async () => {
  const { client } = await startNativeTransport()
  function Probe() {
    return jsx('span', { children: useFluxConnectionStatus({ client }) })
  }
  const { renderToString } = await import('react-dom/server')
  expect(renderToString(jsx(Probe, {}))).toBe('<span>idle</span>')
})

it('stops native delivery when an application invokes its explicit cleanup callback', async () => {
  const transport = await startNativeTransport()
  const received: string[] = []
  const cleanups: Array<() => void> = []
  function Probe() {
    useFluxPublic('feed', 'feed.updated', payload => received.push(String(payload.title)), {
      client: transport.client,
      onUnmount: cleanup => cleanups.push(cleanup),
    })
    return null
  }
  const { act, create } = await import('react-test-renderer')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(jsx(Probe, {}))
    await transport.client.connect()
  })
  await expect.poll(() => transport.subscriptions()).toBe(1)
  await transport.publish('Before cleanup')
  await expect.poll(() => received).toEqual(['Before cleanup'])
  for (const cleanup of cleanups) cleanup()
  await expect.poll(() => transport.subscriptions()).toBe(0)
  await transport.publish('After cleanup')
  expect(received).toEqual(['Before cleanup'])
  await act(async () => renderer?.unmount())
})

it('calls onError when the real worker refuses a private channel the hook subscribes to', async () => {
  const transport = await startNativeTransport({ authorizeOrders: () => false })
  const errors: string[] = []
  function Probe() {
    useFlux('orders.1', 'order.shipped', () => {}, { client: transport.client, onError: error => errors.push(error.message) })
    return null
  }
  const { act, create } = await import('react-test-renderer')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(jsx(Probe, {}))
    await transport.client.connect()
  })
  await expect.poll(() => errors).toEqual([
    '[@holo-js/flux] Subscription to orders.1 was refused: Unable to authorize the channel subscription.',
  ])
  await act(async () => renderer?.unmount())
})
