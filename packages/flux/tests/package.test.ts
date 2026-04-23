import type { BroadcastJsonObject } from '@holo-js/broadcast'
import { afterEach, describe, expect, it } from 'vitest'
import flux, {
  configureFluxClient,
  createFluxClient,
  fluxInternals,
  getFluxClient,
  resetFluxClient,
} from '../src'

afterEach(() => {
  resetFluxClient()
})

describe('@holo-js/flux package surface', () => {
  it('requires an explicit connector before subscriptions can be created', () => {
    const client = createFluxClient()

    expect(client.status).toBe('idle')
    expect((client as unknown as { __debug?: unknown }).__debug).toBeUndefined()
    expect(() => client.channel('orders.1')).toThrow('No realtime connector configured')
    expect(() => client.private('orders.1')).toThrow('No realtime connector configured')
    expect(() => client.presence('chat.1')).toThrow('No realtime connector configured')
  })

  it('supports connection state lifecycle and default-client proxy helpers', async () => {
    const client = createFluxClient({
      connection: 'holo',
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const transitions: string[] = []
    const unbind = client.onStatusChange((status) => {
      transitions.push(status)
    })

    expect(client.status).toBe('idle')
    await client.connect()
    await client.connect()
    expect(client.getStatus()).toBe('connected')
    await client.disconnect()
    expect(client.status).toBe('disconnected')
    unbind()

    expect(transitions).toEqual(['connecting', 'connected', 'disconnected'])

    configureFluxClient(client)
    expect(getFluxClient()).toBe(client)
    expect(configureFluxClient({
      connection: 'options-only',
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    }).options.connection).toBe('options-only')
    expect(typeof flux.channel).toBe('function')
    expect(typeof flux.private).toBe('function')
    expect(typeof flux.presence).toBe('function')
    expect('channel' in flux).toBe(true)
    expect(Object.getPrototypeOf(flux)).toBe(Object.prototype)
    expect(flux.channel('proxy.1').name).toBe('proxy.1')
  })

  it('supports event, notification, and whisper subscriptions with listener controls', async () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug?: ReturnType<typeof fluxInternals.createPusherConnector>['__debug'] }).__debug
    expect(debug).toBeDefined()

    const receivedEvents: unknown[] = []
    const receivedNotifications: unknown[] = []
    const receivedWhispers: unknown[] = []

    const publicSubscription = client.channel('orders.1')
    const privateSubscription = client.private('orders.1')
    const presenceSubscription = client.presence('chat.1')

    publicSubscription.listen(['orders.updated', 'orders.shipped'], (payload) => {
      receivedEvents.push(payload)
    })
    publicSubscription.notification((payload) => {
      receivedNotifications.push(payload)
    })
    publicSubscription.listenForWhisper('typing.start' as never, (payload) => {
      receivedWhispers.push(payload)
    })
    publicSubscription.listenForWhisper('typing.start' as never, (payload) => {
      receivedWhispers.push({ duplicate: payload })
    })
    expect(() => publicSubscription.listen('   ' as never, () => undefined)).toThrow('must be a non-empty string')
    expect(() => publicSubscription.listenForWhisper('   ' as never, () => undefined)).toThrow('must be a non-empty string')

    debug!.emitEvent('orders.1', 'orders.updated', { id: 'ord_1' })
    debug!.emitNotification('orders.1', { type: 'OrderUpdated' })
    await publicSubscription.whisper('typing.start' as never, { editing: true })
    expect(receivedEvents).toEqual([{ id: 'ord_1' }])
    expect(receivedNotifications).toEqual([{ type: 'OrderUpdated' }])
    expect(receivedWhispers).toEqual([
      { editing: true },
      { duplicate: { editing: true } },
    ])

    publicSubscription.stopListening()
    debug!.emitEvent('orders.1', 'orders.updated', { id: 'ord_2' })
    expect(receivedEvents).toEqual([{ id: 'ord_1' }])

    expect(publicSubscription.listen()).toBe(publicSubscription)
    debug!.emitEvent('orders.1', 'orders.shipped', { id: 'ord_3' })
    expect(receivedEvents).toEqual([{ id: 'ord_1' }, { id: 'ord_3' }])

    debug!.updatePresenceMembers('chat.1', [{ id: 'user_1' }, { id: 'user_2' }])
    expect(presenceSubscription.members).toEqual([{ id: 'user_1' }, { id: 'user_2' }])

    await privateSubscription.whisper('typing.start' as never, { editing: false })
    privateSubscription.leave()
    publicSubscription.leaveChannel()
    presenceSubscription.leaveChannel()
    expect(debug!.getJoinedChannels()).toEqual([])
  })

  it('keeps all event listeners that are registered on the same subscription', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug?: ReturnType<typeof fluxInternals.createPusherConnector>['__debug'] }).__debug
    const first: unknown[] = []
    const second: unknown[] = []

    const subscription = client.private('orders.2')
    subscription.listen('orders.updated', (payload) => {
      first.push(payload)
    })
    subscription.listen('orders.updated', (payload) => {
      second.push(payload)
    })

    debug!.emitEvent('orders.2', 'orders.updated', { id: 'ord_2' })

    expect(first).toEqual([{ id: 'ord_2' }])
    expect(second).toEqual([{ id: 'ord_2' }])
  })

  it('keeps all notification listeners that are registered on the same subscription', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug?: ReturnType<typeof fluxInternals.createPusherConnector>['__debug'] }).__debug
    const first: unknown[] = []
    const second: unknown[] = []

    const subscription = client.private('orders.3')
    subscription.notification((payload) => {
      first.push(payload)
    })
    subscription.notification((payload) => {
      second.push(payload)
    })

    debug!.emitNotification('orders.3', { type: 'OrderUpdated' })

    expect(first).toEqual([{ type: 'OrderUpdated' }])
    expect(second).toEqual([{ type: 'OrderUpdated' }])
  })

  it('notifies presence listeners when members change', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug?: ReturnType<typeof fluxInternals.createPusherConnector>['__debug'] }).__debug
    const presenceSubscription = client.presence('chat.2') as unknown as typeof client extends never
      ? never
      : {
          __onPresenceChange(callback: (members: readonly BroadcastJsonObject[]) => void): () => void
          leaveChannel(): void
        }
    const seen: Array<readonly BroadcastJsonObject[]> = []

    const stop = presenceSubscription.__onPresenceChange((members) => {
      seen.push(members)
    })

    debug!.updatePresenceMembers('chat.2', [{ id: 'user_1' }])
    debug!.updatePresenceMembers('chat.2', [{ id: 'user_2' }])
    stop()
    debug!.updatePresenceMembers('chat.2', [{ id: 'user_3' }])

    expect(seen).toEqual([
      [{ id: 'user_1' }],
      [{ id: 'user_2' }],
    ])
    presenceSubscription.leaveChannel()
  })

  it('exposes connector helpers through internals', async () => {
    const connector = fluxInternals.createPusherConnector()
    const statuses: string[] = []
    connector.onStatusChange((status) => {
      statuses.push(status)
    })
    await connector.connect()
    const channel = connector.subscribe('orders.2', 'private')
    const events: unknown[] = []
    const notifications: unknown[] = []
    channel.onEvent('orders.updated', payload => events.push(payload))
    channel.onNotification(payload => notifications.push(payload))
    ;(connector as unknown as { __debug: { emitEvent(channel: string, event: string, payload: object): void, emitNotification(channel: string, payload: object): void } }).__debug.emitEvent('orders.2', 'orders.updated', { ok: true })
    ;(connector as unknown as { __debug: { emitEvent(channel: string, event: string, payload: object): void, emitNotification(channel: string, payload: object): void } }).__debug.emitNotification('orders.2', { type: 'done' })
    expect(events).toEqual([{ ok: true }])
    expect(notifications).toEqual([{ type: 'done' }])
    channel.leave()
    await connector.disconnect()
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected'])
  })

  it('supports connectorFactory and explicit custom connectors without debug carriers', async () => {
    const customConnector = {
      async connect() {},
      async disconnect() {},
      getStatus() {
        return 'connected' as const
      },
      onStatusChange() {
        return () => {}
      },
      subscribe(name: string, kind: 'public' | 'private' | 'presence') {
        return {
          name,
          kind,
          members: [],
          onEvent() {
            return () => {}
          },
          onMembersChange() {
            return () => {}
          },
          onNotification() {
            return () => {}
          },
          onWhisper() {
            return () => {}
          },
          async sendWhisper() {},
          leave() {},
        }
      },
    }
    const viaFactory = createFluxClient({
      connectorFactory() {
        return customConnector
      },
    })
    expect(viaFactory.status).toBe('connected')

    const explicit = createFluxClient({
      connector: customConnector,
    })
    expect(explicit.status).toBe('connected')
    expect((explicit as unknown as { __debug?: unknown }).__debug).toBeUndefined()
  })

  it('covers unavailable connector disconnect, onStatusChange, and double-leave branches', async () => {
    const connector = fluxInternals.createUnavailableConnector()
    expect(connector.getStatus()).toBe('idle')

    // connect() should throw
    await expect(connector.connect()).rejects.toThrow('No realtime connector configured')

    const statuses: string[] = []
    const unbind = connector.onStatusChange((s) => {
      statuses.push(s)
    })

    await connector.disconnect()
    expect(connector.getStatus()).toBe('disconnected')
    expect(statuses).toEqual(['disconnected'])

    // second disconnect should not re-notify
    await connector.disconnect()
    expect(statuses).toEqual(['disconnected'])

    unbind()
    await connector.disconnect()
    expect(statuses).toEqual(['disconnected'])
  })

  it('returns existing channel state when subscribing to the same channel+kind twice', () => {
    const connector = fluxInternals.createPusherConnector({ transport: 'mock' })
    const first = connector.subscribe('orders.1', 'private')
    const second = connector.subscribe('orders.1', 'private')
    expect(first.name).toBe(second.name)
    expect(first.kind).toBe(second.kind)
  })

  it('handles event/whisper/notification handler fallback when no listeners registered', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug?: ReturnType<typeof fluxInternals.createPusherConnector>['__debug'] }).__debug

    const sub = client.channel('orders.1')
    const received: unknown[] = []
    sub.listen('orders.updated', (payload) => {
      received.push(payload)
    })

    // emit an event that has no listeners registered
    debug!.emitEvent('orders.1', 'orders.shipped', { id: 'ord_1' })
    expect(received).toEqual([])

    // emit the registered event
    debug!.emitEvent('orders.1', 'orders.updated', { id: 'ord_2' })
    expect(received).toEqual([{ id: 'ord_2' }])

    sub.leaveChannel()
  })

  it('covers double leaveChannel call as no-op', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const sub = client.channel('orders.1')
    sub.leaveChannel()
    // second call should be a no-op
    sub.leaveChannel()
  })

  it('covers leaveRelated when registry has multiple subscriptions', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug?: ReturnType<typeof fluxInternals.createPusherConnector>['__debug'] }).__debug

    const sub1 = client.channel('orders.1')
    const sub2 = client.channel('orders.1')

    // leave() calls leaveRelated which leaves all subscriptions for the same channel+kind
    sub1.leave()
    expect(debug!.getJoinedChannels()).toEqual([])

    // verify both are left (double leave is no-op)
    sub2.leaveChannel()
  })

  it('does not subscribe to sibling channel variants when leaving a subscription', () => {
    const subscribeCalls: Array<{ name: string, kind: 'public' | 'private' | 'presence' }> = []
    const leaveCalls: Array<{ name: string, kind: 'public' | 'private' | 'presence' }> = []
    const customConnector = {
      async connect() {},
      async disconnect() {},
      getStatus() {
        return 'connected' as const
      },
      onStatusChange() {
        return () => {}
      },
      subscribe(name: string, kind: 'public' | 'private' | 'presence') {
        subscribeCalls.push({ name, kind })
        return {
          name,
          kind,
          members: [],
          onEvent() {
            return () => {}
          },
          onMembersChange() {
            return () => {}
          },
          onNotification() {
            return () => {}
          },
          onWhisper() {
            return () => {}
          },
          async sendWhisper() {},
          leave() {
            leaveCalls.push({ name, kind })
          },
        }
      },
    }

    const client = createFluxClient({
      connector: customConnector,
    })
    const publicSubscription = client.channel('orders.1')
    const privateSubscription = client.private('orders.1')
    const presenceSubscription = client.presence('orders.1')

    expect(subscribeCalls).toEqual([
      { name: 'orders.1', kind: 'public' },
      { name: 'orders.1', kind: 'private' },
      { name: 'orders.1', kind: 'presence' },
    ])

    privateSubscription.leave()

    expect(publicSubscription.name).toBe('orders.1')
    expect(presenceSubscription.name).toBe('orders.1')
    expect(subscribeCalls).toEqual([
      { name: 'orders.1', kind: 'public' },
      { name: 'orders.1', kind: 'private' },
      { name: 'orders.1', kind: 'presence' },
    ])
    expect(leaveCalls).toEqual([{ name: 'orders.1', kind: 'private' }])
  })
})
