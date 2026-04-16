import { get } from 'svelte/store'
import { describe, expect, it } from 'vitest'
import { configureFluxClient, createFluxClient, fluxInternals, getFluxClient, resetFluxClient } from '@holo-js/flux'
import {
  useFlux,
  useFluxConnectionStatus,
  useFluxModel,
  useFluxNotification,
  useFluxPresence,
  useFluxPrivate,
  useFluxPublic,
} from '../src'

type DebugConnector = {
  emitEvent(channel: string, event: string, payload: Record<string, unknown>): void
  emitNotification(channel: string, payload: Record<string, unknown>): void
  updatePresenceMembers(channel: string, members: readonly Record<string, unknown>[]): void
  getJoinedChannels(): readonly string[]
}

describe('@holo-js/flux-svelte package surface', () => {
  it('uses the default flux client when no client is provided', () => {
    resetFluxClient()
    configureFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const client = getFluxClient()
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const controls = useFluxPublic('feed.default', 'feed.updated', () => undefined)

    expect(debug.getJoinedChannels()).toContain('public:feed.default')
    controls.leaveChannel()
    expect(debug.getJoinedChannels()).toEqual([])
    resetFluxClient()
  })

  it('subscribes with controls and supports unmount cleanup', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const unmounts: Array<() => void> = []
    const events: unknown[] = []
    const notifications: unknown[] = []

    const controls = useFlux('orders.1', ['orders.updated', 'orders.shipped'], payload => {
      events.push(payload)
    }, {
      client,
      onUnmount(cleanup) {
        unmounts.push(cleanup)
      },
    })
    const publicControls = useFluxPublic('feed.1', 'feed.updated', () => undefined, {
      client,
      onUnmount(cleanup) {
        unmounts.push(cleanup)
      },
    })
    const privateControls = useFluxPrivate('orders.1', 'orders.updated', () => undefined, { client })
    const modelControls = useFluxModel('orders.1', 'orders.updated', () => undefined, { client })
    const notificationControls = useFluxNotification('App.Models.User.1', payload => {
      notifications.push(payload)
    }, {
      client,
      onUnmount(cleanup) {
        unmounts.push(cleanup)
      },
    })

    controls.stopListening()
    debug.emitEvent('orders.1', 'orders.updated', { id: 'ord_1' })
    expect(events).toEqual([])
    controls.listen()
    debug.emitEvent('orders.1', 'orders.updated', { id: 'ord_2' })
    expect(events).toEqual([{ id: 'ord_2' }])
    debug.emitNotification('App.Models.User.1', { type: 'OrderNotice' })
    expect(notifications).toEqual([{ type: 'OrderNotice' }])

    publicControls.leaveChannel()
    privateControls.leave()
    modelControls.leaveChannel()
    notificationControls.leaveChannel()
    unmounts.forEach(cleanup => cleanup())
    expect(debug.getJoinedChannels()).toEqual([])
  })

  it('returns reactive stores for presence state + status callbacks', async () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const unmounts: Array<() => void> = []
    const here: unknown[] = []
    const statusChanges: string[] = []

    const presence = useFluxPresence('chat.1', {
      onHere(members) {
        here.push(members)
      },
    }, {
      client,
      onUnmount(cleanup) {
        unmounts.push(cleanup)
      },
    })

    expect(here).toEqual([[]])
    const emptyPresence = useFluxPresence('chat.empty', {}, { client })
    expect(get(emptyPresence.members)).toEqual([])
    debug.updatePresenceMembers('chat.1', [{ id: 'user_1' }, { id: 'user_2' }])
    expect(get(presence.members)).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
    presence.stopListening()
    presence.listen()
    expect(get(useFluxConnectionStatus({
      client,
      onChange(status) {
        statusChanges.push(status)
      },
      onUnmount(cleanup) {
        unmounts.push(cleanup)
      },
    }))).toBe('idle')
    expect(get(useFluxConnectionStatus({ client }))).toBe('idle')

    await client.connect()
    await client.disconnect()
    expect(statusChanges).toEqual(['connecting', 'connected', 'disconnected'])
    unmounts.forEach(cleanup => cleanup())
    expect(debug.getJoinedChannels()).toEqual([])
  })
})
