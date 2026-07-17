import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.doUnmock('svelte')
  vi.resetModules()
})

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
    const statusReads: string[] = []

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
    expect('set' in presence.members).toBe(false)
    expect('update' in presence.members).toBe(false)
    debug.updatePresenceMembers('chat.1', [{ id: 'user_1' }, { id: 'user_2' }])
    expect(get(presence.members)).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
    expect(here.at(-1)).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
    presence.stopListening()
    debug.updatePresenceMembers('chat.1', [{ id: 'muted' }])
    expect(get(presence.members)).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
    expect(here.at(-1)).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
    presence.listen()
    expect(get(presence.members)).toEqual([{ id: 'muted' }])
    debug.updatePresenceMembers('chat.1', [{ id: 'user_3' }])
    expect(get(presence.members)).toEqual([{ id: 'user_3' }])
    expect(here.at(-1)).toEqual([{ id: 'user_3' }])
    presence.leave()
    presence.listen()
    presence.leaveChannel()
    const statusStore = useFluxConnectionStatus({
      client,
      onChange(status) {
        statusChanges.push(status)
      },
      onUnmount(cleanup) {
        unmounts.push(cleanup)
      },
    })
    const unsubscribeStatus = statusStore.subscribe((status) => {
      statusReads.push(status)
    })
    expect(statusReads).toEqual(['idle'])
    expect(get(useFluxConnectionStatus({ client }))).toBe('idle')

    await client.connect()
    await client.disconnect()
    expect(statusChanges).toEqual(['connecting', 'connected', 'disconnected'])
    expect(statusReads).toEqual(['idle', 'connecting', 'connected', 'disconnected'])
    unsubscribeStatus()
    unmounts.forEach(cleanup => cleanup())
    expect(debug.getJoinedChannels()).toEqual([])
  })

  it('ignores inactive joins and leaves and preserves unknown presence members', () => {
    let here: (members: readonly unknown[]) => void = () => undefined
    let joining: (member: unknown) => void = () => undefined
    let leaving: (member: unknown) => void = () => undefined
    const initialMember = { id: 'initial' }
    const subscription = {
      members: [initialMember] as readonly unknown[],
      here(callback: typeof here) {
        here = callback
        return this
      },
      joining(callback: typeof joining) {
        joining = callback
        return this
      },
      leaving(callback: typeof leaving) {
        leaving = callback
        return this
      },
      leave() {},
      leaveChannel() {},
      listen() {},
      stopListening() {},
    }
    const presence = useFluxPresence('chat.manual', {}, {
      client: { presence: () => subscription } as never,
      onUnmount() {},
    })

    leaving(initialMember)
    joining({ id: 'present' })
    leaving({ id: 'missing' })
    leaving(undefined)
    expect(get(presence.members)).toEqual([{ id: 'present' }])

    presence.stopListening()
    here([{ id: 'ignored' }])
    joining({ id: 'ignored' })
    leaving({ id: 'present' })
    expect(get(presence.members)).toEqual([{ id: 'present' }])
  })

  it('removes connection status listeners when the store unsubscribes', async () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const statusChanges: string[] = []
    const statusReads: string[] = []
    const unsubscribe = useFluxConnectionStatus({
      client,
      onChange(status) {
        statusChanges.push(status)
      },
    }).subscribe((status) => {
      statusReads.push(status)
    })

    expect(statusReads).toEqual(['idle'])
    unsubscribe()

    await client.connect()
    await client.disconnect()

    expect(statusChanges).toEqual([])
    expect(statusReads).toEqual(['idle'])
  })

  it('registers cleanup through Svelte onDestroy when a component context is available', async () => {
    let destroyCallback: (() => void) | undefined
    vi.doMock('svelte', () => ({
      onDestroy(callback: () => void) {
        destroyCallback = callback
      },
    }))
    const { useFluxPublic: useMountedFluxPublic } = await import('../src')
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const fallbackUnmount = vi.fn()

    useMountedFluxPublic('feed.mounted', 'feed.updated', () => undefined, {
      client,
      onUnmount: fallbackUnmount,
    })

    expect(debug.getJoinedChannels()).toContain('public:feed.mounted')
    expect(fallbackUnmount).not.toHaveBeenCalled()
    expect(destroyCallback).toBeTypeOf('function')
    destroyCallback?.()
    expect(debug.getJoinedChannels()).toEqual([])
  })
})
