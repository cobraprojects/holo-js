import { effectScope, nextTick, watchEffect } from 'vue'
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

describe('@holo-js/flux-vue package surface', () => {
  it('uses the default flux client when no client is provided', () => {
    resetFluxClient()
    configureFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const client = getFluxClient()
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const scope = effectScope()
    let controls: ReturnType<typeof useFluxPublic> | undefined

    scope.run(() => {
      controls = useFluxPublic('feed.default', 'feed.updated', () => undefined)
    })

    expect(debug.getJoinedChannels()).toContain('public:feed.default')
    controls!.leaveChannel()
    expect(debug.getJoinedChannels()).toEqual([])
    scope.stop()
    resetFluxClient()
  })

  it('subscribes with controls and cleans up on scope dispose', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const events: unknown[] = []
    const notifications: unknown[] = []
    let controls: ReturnType<typeof useFlux> | undefined
    let publicControls: ReturnType<typeof useFluxPublic> | undefined
    let privateControls: ReturnType<typeof useFluxPrivate> | undefined
    let modelControls: ReturnType<typeof useFluxModel> | undefined
    let notificationControls: ReturnType<typeof useFluxNotification> | undefined
    const scope = effectScope()

    scope.run(() => {
      controls = useFlux('orders.1', ['orders.updated', 'orders.shipped'], payload => {
        events.push(payload)
      }, { client })
      publicControls = useFluxPublic('feed.1', 'feed.updated', () => undefined, { client })
      privateControls = useFluxPrivate('orders.1', 'orders.updated', () => undefined, { client })
      modelControls = useFluxModel('orders.1', 'orders.updated', () => undefined, { client })
      notificationControls = useFluxNotification('App.Models.User.1', payload => {
        notifications.push(payload)
      }, { client })
    })

    controls!.stopListening()
    debug.emitEvent('orders.1', 'orders.updated', { id: 'ord_1' })
    expect(events).toEqual([])
    controls!.listen()
    debug.emitEvent('orders.1', 'orders.updated', { id: 'ord_2' })
    expect(events).toEqual([{ id: 'ord_2' }])
    debug.emitNotification('App.Models.User.1', { type: 'OrderNotice' })
    expect(notifications).toEqual([{ type: 'OrderNotice' }])

    publicControls!.leaveChannel()
    privateControls!.leave()
    modelControls!.leaveChannel()
    notificationControls!.leaveChannel()
    scope.stop()
    expect(debug.getJoinedChannels()).toEqual([])
  })

  it('falls back to explicit unmount cleanup outside a scope', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const unmounts: Array<() => void> = []

    useFluxPublic('feed.fallback', 'feed.updated', () => undefined, {
      client,
      onUnmount(cleanup) {
        unmounts.push(cleanup)
      },
    })

    expect(debug.getJoinedChannels()).toContain('public:feed.fallback')
    unmounts.forEach(cleanup => cleanup())
    expect(debug.getJoinedChannels()).toEqual([])
  })

  it('supports presence state and reactive status callbacks', async () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const here: unknown[] = []
    const statusChanges: string[] = []
    const statusSnapshots: string[] = []
    let presence: ReturnType<typeof useFluxPresence<{ id: string }>> | undefined
    let emptyPresence: ReturnType<typeof useFluxPresence> | undefined
    let status: ReturnType<typeof useFluxConnectionStatus> | undefined
    const scope = effectScope()

    scope.run(() => {
      presence = useFluxPresence('chat.1', {
        onHere(members) {
          here.push(members)
        },
      }, { client })
      emptyPresence = useFluxPresence('chat.empty', {}, { client })
      status = useFluxConnectionStatus({
        client,
        onChange(next) {
          statusChanges.push(next)
        },
      })
      watchEffect(() => {
        statusSnapshots.push(status!.value)
        void presence!.members
      })
    })

    expect(here).toEqual([[]])
    expect(emptyPresence!.members).toEqual([])
    debug.updatePresenceMembers('chat.1', [{ id: 'user_1' }, { id: 'user_2' }])
    await nextTick()
    expect(presence!.members).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
    expect(status!.value).toBe('idle')

    await client.connect()
    await client.disconnect()
    await nextTick()
    expect(statusChanges).toEqual(['connecting', 'connected', 'disconnected'])
    expect(statusSnapshots).toContain('connected')
    expect(statusSnapshots.at(-1)).toBe('disconnected')

    scope.stop()
    expect(debug.getJoinedChannels()).toEqual([])
  })
})
