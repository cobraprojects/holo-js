import { useEffect } from 'react'
import { jsx } from 'react/jsx-runtime'
import { describe, expect, it, vi } from 'vitest'
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

type Renderer = {
  update(element: ReturnType<typeof jsx>): void
  unmount(): void
}

type RendererModule = {
  act(callback: () => void | Promise<void>): Promise<void>
  create(element: ReturnType<typeof jsx>): Renderer
}

async function loadRenderer(): Promise<RendererModule> {
  return await import('react-test-renderer') as unknown as RendererModule
}

function renderElement(Component: () => null): ReturnType<typeof jsx> {
  return jsx(Component, {})
}

describe('@holo-js/flux-react package surface', () => {
  it('uses the default flux client when no client is provided', async () => {
    resetFluxClient()
    configureFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const client = getFluxClient()
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    let controls: ReturnType<typeof useFluxPublic> | undefined

    function Probe() {
      controls = useFluxPublic('feed.default', 'feed.updated', () => undefined)
      return null
    }

    const { act, create } = await loadRenderer()
    let renderer: Renderer | undefined
    await act(async () => {
      renderer = create(renderElement(Probe))
    })

    expect(debug.getJoinedChannels()).toContain('public:feed.default')
    controls!.leaveChannel()
    expect(debug.getJoinedChannels()).toEqual([])

    await act(async () => {
      renderer!.unmount()
    })
    resetFluxClient()
  })

  it('subscribes with controls and cleans up on unmount', async () => {
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

    function Probe() {
      controls = useFlux('orders.1', ['orders.updated', 'orders.shipped'], payload => {
        events.push(payload)
      }, { client })
      publicControls = useFluxPublic('feed.1', 'feed.updated', () => undefined, { client })
      privateControls = useFluxPrivate('orders.1', 'orders.updated', () => undefined, { client })
      modelControls = useFluxModel('orders.1', 'orders.updated', () => undefined, { client })
      notificationControls = useFluxNotification('App.Models.User.1', payload => {
        notifications.push(payload)
      }, { client })
      return null
    }

    const { act, create } = await loadRenderer()
    let renderer: Renderer | undefined
    await act(async () => {
      renderer = create(renderElement(Probe))
    })

    expect(controls).toEqual({
      leave: expect.any(Function),
      leaveChannel: expect.any(Function),
      listen: expect.any(Function),
      stopListening: expect.any(Function),
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

    await act(async () => {
      renderer!.unmount()
    })
    expect(debug.getJoinedChannels()).toEqual([])
  })

  it('keeps event subscriptions stable across same-props rerenders', async () => {
    const baseConnector = fluxInternals.createPusherConnector({ transport: 'mock' })
    let subscribeCalls = 0
    const connector = {
      async connect() {
        await baseConnector.connect()
      },
      async disconnect() {
        await baseConnector.disconnect()
      },
      getStatus() {
        return baseConnector.getStatus()
      },
      onStatusChange(callback: Parameters<typeof baseConnector.onStatusChange>[0]) {
        return baseConnector.onStatusChange(callback)
      },
      subscribe(channel: string, kind: 'public' | 'private' | 'presence') {
        subscribeCalls += 1
        return baseConnector.subscribe(channel, kind)
      },
    }
    const client = createFluxClient({ connector })

    function Probe() {
      useFluxPublic('feed.stable', 'feed.updated', () => undefined, { client })
      return null
    }

    const { act, create } = await loadRenderer()
    let renderer: Renderer | undefined
    await act(async () => {
      renderer = create(renderElement(Probe))
    })
    expect(subscribeCalls).toBe(1)

    await act(async () => {
      renderer!.update(renderElement(Probe))
    })
    expect(subscribeCalls).toBe(1)

    await act(async () => {
      renderer!.unmount()
    })
  })

  it('supports presence state and reactive status callbacks', async () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug: DebugConnector }).__debug
    const here: unknown[] = []
    const statusChanges: string[] = []
    const statusHandler = vi.fn((status: string) => {
      statusChanges.push(status)
    })
    const presenceSnapshots: Array<readonly { id: string }[]> = []
    const statusSnapshots: string[] = []
    const bareStatusSnapshots: string[] = []
    let emptyPresence: ReturnType<typeof useFluxPresence> | undefined
    let presenceControls: ReturnType<typeof useFluxPresence<{ id: string }>> | undefined

    function Probe() {
      const presence = useFluxPresence<{ id: string }>('chat.1', {
        onHere(members) {
          here.push(members)
        },
      }, { client })
      presenceControls = presence
      emptyPresence = useFluxPresence('chat.empty', {}, { client })
      const status = useFluxConnectionStatus({
        client,
        onChange(next) {
          statusHandler(next)
        },
      })
      const bareStatus = useFluxConnectionStatus({ client })

      useEffect(() => {
        presenceSnapshots.push(presence.members)
      }, [presence.members])
      useEffect(() => {
        statusSnapshots.push(status)
      }, [status])
      useEffect(() => {
        bareStatusSnapshots.push(bareStatus)
      }, [bareStatus])

      return null
    }

    const { act, create } = await loadRenderer()
    let renderer: Renderer | undefined
    await act(async () => {
      renderer = create(renderElement(Probe))
    })

    expect(here).toEqual([[]])
    expect(emptyPresence!.members).toEqual([])
    debug.updatePresenceMembers('chat.1', [{ id: 'user_1' }, { id: 'user_2' }])
    await act(async () => undefined)
    expect(presenceSnapshots.at(-1)).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
    expect(statusSnapshots.at(-1)).toBe('idle')
    expect(bareStatusSnapshots.at(-1)).toBe('idle')
    presenceControls!.stopListening()
    presenceControls!.listen()

    await act(async () => {
      await client.connect()
      await client.disconnect()
    })
    expect(statusChanges).toEqual(['connecting', 'connected', 'disconnected'])
    expect(statusHandler).toHaveBeenCalledTimes(3)
    expect(statusSnapshots).toContain('connected')
    expect(statusSnapshots.at(-1)).toBe('disconnected')
    presenceControls!.leave()
    presenceControls!.leaveChannel()
    expect(debug.getJoinedChannels()).toEqual([])

    await act(async () => {
      renderer!.unmount()
    })
    expect(debug.getJoinedChannels()).toEqual([])
  })

  it('registers explicit unmount callbacks when provided', async () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const unmounts: Array<() => void> = []

    function Probe() {
      useFluxPublic('feed.cleanup', 'feed.updated', () => undefined, {
        client,
        onUnmount(cleanup) {
          unmounts.push(cleanup)
        },
      })
      useFluxPresence('chat.cleanup', {}, {
        client,
        onUnmount(cleanup) {
          unmounts.push(cleanup)
        },
      })
      useFluxConnectionStatus({
        client,
        onChange() {
          return
        },
        onUnmount(cleanup) {
          unmounts.push(cleanup)
        },
      })
      return null
    }

    const { act, create } = await loadRenderer()
    let renderer: Renderer | undefined
    await act(async () => {
      renderer = create(renderElement(Probe))
    })

    expect(unmounts.length).toBeGreaterThanOrEqual(4)
    await act(async () => {
      renderer!.unmount()
    })
  })
})
