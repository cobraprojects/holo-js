import { afterEach, describe, expect, it, vi } from 'vitest'
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

type TestWebSocketEventMap = {
  open: () => void
  message: (event: { readonly data: unknown }) => void
  close: () => void
  error: () => void
}

type TestWebSocketEventName = keyof TestWebSocketEventMap

describe('@holo-js/flux package surface', () => {
  it('requires an explicit connector before subscriptions can be created', () => {
    const client = createFluxClient()

    expect(client.status).toBe('idle')
    expect((client as unknown as { __debug?: unknown }).__debug).toBeUndefined()
    expect(() => client.channel('orders.1')).toThrow('No realtime connector configured')
    expect(() => client.private('orders.1')).toThrow('No realtime connector configured')
    expect(() => client.presence('chat.1')).toThrow('No realtime connector configured')
  })

  it('configures the default client with the Holo websocket connector', async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalFetch = globalThis.fetch
    const originalLocation = globalThis.location
    const browserGlobal = globalThis as typeof globalThis & { window?: unknown }
    const originalWindow = browserGlobal.window
    const sentMessages: unknown[] = []
    let openedUrl = ''
    let socketReadyState = 0
    const listeners = new Map<TestWebSocketEventName, Set<TestWebSocketEventMap[TestWebSocketEventName]>>()

    class TestWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3

      get readyState() {
        return socketReadyState
      }

      constructor(url: string | URL) {
        openedUrl = url.toString()
      }

      send(data: string): void {
        sentMessages.push(JSON.parse(data) as unknown)
      }

      close(): void {
        emit('close', undefined)
      }

      addEventListener<TEvent extends TestWebSocketEventName>(event: TEvent, listener: TestWebSocketEventMap[TEvent]): void {
        const eventListeners = listeners.get(event) ?? new Set<TestWebSocketEventMap[TestWebSocketEventName]>()
        eventListeners.add(listener)
        listeners.set(event, eventListeners)
      }
    }

    function emit<TEvent extends TestWebSocketEventName>(event: TEvent, payload: Parameters<TestWebSocketEventMap[TEvent]>[0]): void {
      if (event === 'open') {
        socketReadyState = 1
      }

      if (event === 'close') {
        socketReadyState = 3
      }

      for (const listener of listeners.get(event) ?? []) {
        listener(payload as never)
      }
    }

    try {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: TestWebSocket,
      })
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: async () => new Response(null, { status: 404 }),
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: {
          hostname: '127.0.0.1',
          protocol: 'http:',
        },
      })
      Object.defineProperty(browserGlobal, 'window', {
        configurable: true,
        value: {},
      })
      resetFluxClient()
      const received: unknown[] = []

      getFluxClient().private('blog.admin').listen('blog.post.changed', (payload) => {
        received.push(payload)
      })
      await vi.waitFor(() => {
        expect(openedUrl).toBe('ws://127.0.0.1:8080/app/app-key')
      })
      emit('open', undefined)
      emit('message', {
        data: JSON.stringify({
          event: 'pusher:connection_established',
          data: JSON.stringify({ socket_id: '1.1' }),
        }),
      })
      emit('message', {
        data: JSON.stringify({
          event: 'blog.post.changed',
          channel: 'private-blog.admin',
          data: JSON.stringify({ action: 'created', title: 'Live post' }),
        }),
      })

      expect(sentMessages).toContainEqual({
        event: 'pusher:subscribe',
        data: {
          channel: 'private-blog.admin',
        },
      })
      expect(received).toEqual([{ action: 'created', title: 'Live post' }])
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
      Object.defineProperty(browserGlobal, 'window', {
        configurable: true,
        value: originalWindow,
      })
      resetFluxClient()
    }
  })

  it('discovers Holo websocket options from the framework broadcast config endpoint', async () => {
    const originalFetch = globalThis.fetch
    const originalLocation = globalThis.location
    const originalWebSocket = globalThis.WebSocket
    const browserGlobal = globalThis as typeof globalThis & { window?: unknown }
    const originalWindow = browserGlobal.window
    let openedUrl = ''
    let requestedUrl = ''

    class TestWebSocket {
      readonly readyState = 0

      constructor(url: string | URL) {
        openedUrl = url.toString()
      }

      send(): void {}

      close(): void {}

      addEventListener(event: TestWebSocketEventName, listener: TestWebSocketEventMap[TestWebSocketEventName]): void {
        if (event === 'open') {
          queueMicrotask(() => listener(undefined as never))
        }
      }
    }

    try {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: async (url: string) => {
          requestedUrl = url
          return {
            ok: true,
            async json() {
              return {
                key: 'browser-key',
                host: '127.0.0.1',
                port: 6100,
                path: '/broadcast',
                scheme: 'http',
              }
            },
          }
        },
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: {
          hostname: 'blog.test',
          protocol: 'http:',
        },
      })
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {},
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: TestWebSocket,
      })

      resetFluxClient()
      await getFluxClient().connect()

      expect(requestedUrl).toBe('/broadcasting/config')
      expect(openedUrl).toBe('ws://blog.test:6100/broadcast/browser-key')
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      })
      resetFluxClient()
    }
  })

  it('drives Holo websocket subscriptions through the Pusher wire protocol', async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalLocation = globalThis.location
    const sockets: TestWebSocket[] = []
    const sentMessages: unknown[] = []
    const transitions: string[] = []
    let openedUrl = ''

    class TestWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3

      readyState = 0
      readonly listeners = new Map<TestWebSocketEventName, Set<TestWebSocketEventMap[TestWebSocketEventName]>>()

      constructor(url: string | URL) {
        openedUrl = url.toString()
        sockets.push(this)
      }

      send(data: string): void {
        sentMessages.push(JSON.parse(data) as unknown)
      }

      close(): void {
        this.emit('close', undefined)
      }

      addEventListener<TEvent extends TestWebSocketEventName>(event: TEvent, listener: TestWebSocketEventMap[TEvent]): void {
        const eventListeners = this.listeners.get(event) ?? new Set<TestWebSocketEventMap[TestWebSocketEventName]>()
        eventListeners.add(listener)
        this.listeners.set(event, eventListeners)
      }

      emit<TEvent extends TestWebSocketEventName>(event: TEvent, payload: Parameters<TestWebSocketEventMap[TEvent]>[0]): void {
        if (event === 'open') {
          this.readyState = 1
        }

        if (event === 'close') {
          this.readyState = 3
        }

        for (const listener of this.listeners.get(event) ?? []) {
          listener(payload as never)
        }
      }
    }

    try {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: TestWebSocket,
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: {
          hostname: 'blog.test',
          protocol: 'https:',
        },
      })

      const connector = fluxInternals.createHoloWebSocketConnector({
        host: '0.0.0.0',
        port: 6001,
        path: 'broadcast',
        key: 'key with spaces',
      })
      const client = configureFluxClient({
        connector,
      })
      client.onStatusChange(status => transitions.push(status))

      const receivedEvents: unknown[] = []
      const receivedWhispers: unknown[] = []
      const members: Array<readonly unknown[]> = []
      const joined: unknown[] = []
      const left: unknown[] = []
      const publicSubscription = client.channel('public.news')
      const privateSubscription = client.private('orders.1')
      const presenceSubscription = client.presence('chat.1')

      publicSubscription.listen('news.updated', payload => receivedEvents.push(payload))
      privateSubscription.listenForWhisper('typing.start' as never, payload => receivedWhispers.push(payload))
      presenceSubscription.here(value => members.push(value))
      presenceSubscription.joining(member => joined.push(member))
      presenceSubscription.leaving(member => left.push(member))

      const connection = client.connect()
      expect(sockets).toHaveLength(1)
      const socket = sockets[0]!
      socket.emit('open', undefined)
      await connection
      socket.emit('message', {
        data: JSON.stringify({
          event: 'pusher:connection_established',
          data: JSON.stringify({ socket_id: '1.1' }),
        }),
      })
      socket.emit('message', {
        data: JSON.stringify({
          event: 'pusher_internal:subscription_succeeded',
          channel: 'presence-chat.1',
          data: {
            presence: {
              hash: {
                user_1: { id: 'user_1' },
              },
            },
          },
        }),
      })
      socket.emit('message', {
        data: JSON.stringify({
          event: 'pusher_internal:member_added',
          channel: 'presence-chat.1',
          data: {
            member: JSON.stringify({ id: 'user_2' }),
          },
        }),
      })
      socket.emit('message', {
        data: JSON.stringify({
          event: 'pusher_internal:member_removed',
          channel: 'presence-chat.1',
          data: {
            member: { id: 'user_1' },
          },
        }),
      })
      socket.emit('message', {
        data: JSON.stringify({
          event: 'client-typing.start',
          channel: 'private-orders.1',
          data: JSON.stringify({ editing: true }),
        }),
      })
      socket.emit('message', {
        data: JSON.stringify({
          event: 'news.updated',
          channel: 'public.news',
          data: { id: 'post_1' },
        }),
      })
      socket.emit('message', { data: JSON.stringify({ event: 'ignored' }) })
      socket.emit('message', { data: JSON.stringify({ event: 'news.updated', channel: 'missing.channel' }) })
      socket.emit('message', { data: 'null' })
      socket.emit('message', { data: { event: 'ignored' } })

      await privateSubscription.whisper('typing.stop' as never, { editing: false })
      await client.connect()
      privateSubscription.leaveChannel()
      presenceSubscription.leaveChannel()
      await client.disconnect()

      expect(openedUrl).toBe('wss://blog.test:6001/broadcast/key%20with%20spaces')
      expect(sentMessages).toEqual([
        {
          event: 'pusher:subscribe',
          data: {
            channel: 'public.news',
          },
        },
        {
          event: 'pusher:subscribe',
          data: {
            channel: 'private-orders.1',
          },
        },
        {
          event: 'pusher:subscribe',
          data: {
            channel: 'presence-chat.1',
          },
        },
        {
          event: 'client-typing.stop',
          channel: 'private-orders.1',
          data: {
            editing: false,
          },
        },
        {
          event: 'pusher:unsubscribe',
          data: {
            channel: 'private-orders.1',
          },
        },
        {
          event: 'pusher:unsubscribe',
          data: {
            channel: 'presence-chat.1',
          },
        },
      ])
      expect(receivedEvents).toEqual([{ id: 'post_1' }])
      expect(receivedWhispers).toEqual([{ editing: true }])
      expect(members).toEqual([[]])
      expect(joined).toEqual([{ id: 'user_1' }, { id: 'user_2' }])
      expect(left).toEqual([{ id: 'user_1' }])
      expect(transitions).toEqual(['connecting', 'connected', 'disconnected'])
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
      resetFluxClient()
    }
  })

  it('handles Holo websocket connection failures and missing browser websocket support', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sockets: TestWebSocket[] = []
    const transitions: string[] = []

    class TestWebSocket {
      readonly readyState = 0
      readonly listeners = new Map<TestWebSocketEventName, Set<TestWebSocketEventMap[TestWebSocketEventName]>>()

      constructor() {
        sockets.push(this)
      }

      send(): void {}

      close(): void {
        this.emit('close', undefined)
      }

      addEventListener<TEvent extends TestWebSocketEventName>(event: TEvent, listener: TestWebSocketEventMap[TEvent]): void {
        const eventListeners = this.listeners.get(event) ?? new Set<TestWebSocketEventMap[TestWebSocketEventName]>()
        eventListeners.add(listener)
        this.listeners.set(event, eventListeners)
      }

      emit<TEvent extends TestWebSocketEventName>(event: TEvent, payload: Parameters<TestWebSocketEventMap[TEvent]>[0]): void {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(payload as never)
        }
      }
    }

    try {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: undefined,
      })
      const unsupported = fluxInternals.createHoloWebSocketConnector()
      await expect(unsupported.connect()).resolves.toBeUndefined()
      const unsupportedChannel = unsupported.subscribe('orders.1', 'private')
      await expect(unsupportedChannel.sendWhisper('typing.start', { editing: true })).resolves.toBeUndefined()
      unsupportedChannel.leave()

      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: TestWebSocket,
      })
      const connector = fluxInternals.createHoloWebSocketConnector({
        scheme: 'http',
      })
      connector.onStatusChange(status => transitions.push(status))
      const connection = connector.connect()
      expect(sockets).toHaveLength(1)
      sockets[0]!.emit('error', undefined)

      await expect(connection).rejects.toThrow('WebSocket connection failed')
      fluxInternals.createHoloWebSocketConnector().subscribe('orders.background', 'private')
      expect(sockets).toHaveLength(1)

      const explicit = fluxInternals.createHoloWebSocketConnector({
        host: '127.0.0.1',
      })
      explicit.subscribe('orders.background', 'private')
      expect(sockets).toHaveLength(2)
      sockets[1]!.emit('error', undefined)
      await Promise.resolve()
      expect(connector.getStatus()).toBe('disconnected')
      expect(transitions).toEqual(['connecting', 'disconnected'])
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
    }
  })

  it('reuses Holo websocket channels and detaches listener callbacks', async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalLocation = globalThis.location
    const sockets: TestWebSocket[] = []
    const sentMessages: unknown[] = []
    const transitions: string[] = []
    const received: unknown[] = []
    let openedUrl = ''

    class TestWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3

      readyState = 0
      readonly listeners = new Map<TestWebSocketEventName, Set<TestWebSocketEventMap[TestWebSocketEventName]>>()

      constructor(url: string | URL) {
        openedUrl = url.toString()
        sockets.push(this)
      }

      send(data: string): void {
        sentMessages.push(JSON.parse(data) as unknown)
      }

      close(): void {
        this.emit('close', undefined)
      }

      addEventListener<TEvent extends TestWebSocketEventName>(event: TEvent, listener: TestWebSocketEventMap[TEvent]): void {
        const eventListeners = this.listeners.get(event) ?? new Set<TestWebSocketEventMap[TestWebSocketEventName]>()
        eventListeners.add(listener)
        this.listeners.set(event, eventListeners)
      }

      emit<TEvent extends TestWebSocketEventName>(event: TEvent, payload: Parameters<TestWebSocketEventMap[TEvent]>[0]): void {
        if (event === 'open') {
          this.readyState = 1
        }

        if (event === 'close') {
          this.readyState = 3
        }

        for (const listener of this.listeners.get(event) ?? []) {
          listener(payload as never)
        }
      }
    }

    try {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: TestWebSocket,
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: {
          hostname: 'ignored.test',
          protocol: 'http:',
        },
      })

      const connector = fluxInternals.createHoloWebSocketConnector({
        host: ' socket.example.test ',
        scheme: 'https',
        port: 443,
        path: '/realtime/',
        key: 'browser key',
      })
      const stopIgnoredStatus = connector.onStatusChange(() => {
        transitions.push('ignored')
      })
      stopIgnoredStatus()
      connector.onStatusChange(status => transitions.push(status))

      const connection = connector.connect()
      expect(sockets).toHaveLength(1)
      sockets[0]!.emit('open', undefined)
      await connection

      const first = connector.subscribe('orders.1', 'private')
      const second = connector.subscribe('orders.1', 'private')
      const presence = connector.subscribe('chat.1', 'presence')
      const memberSnapshots: Array<readonly unknown[]> = []
      const stopEvent = first.onEvent('orders.updated', payload => received.push({ first: payload }))
      second.onEvent('orders.updated', payload => received.push({ second: payload }))
      presence.onMembersChange(members => memberSnapshots.push(members))
      const stopNotification = first.onNotification(payload => received.push({ notification: payload }))
      stopNotification()
      stopEvent()

      sockets[0]!.emit('message', {
        data: JSON.stringify({
          event: 'pusher_internal:subscription_succeeded',
          channel: 'presence-chat.1',
          data: {
            presence: {
              hash: null,
            },
          },
        }),
      })
      sockets[0]!.emit('message', {
        data: JSON.stringify({
          event: 'pusher_internal:subscription_succeeded',
          channel: 'presence-chat.1',
          data: {
            presence: [],
          },
        }),
      })
      sockets[0]!.emit('message', {
        data: JSON.stringify({
          event: 'client-typing.stop',
          channel: 'private-orders.1',
          data: JSON.stringify({ editing: false }),
        }),
      })
      sockets[0]!.emit('message', {
        data: JSON.stringify({
          event: 'orders.shipped',
          channel: 'private-orders.1',
          data: JSON.stringify({ id: 'ord_2' }),
        }),
      })
      sockets[0]!.emit('message', {
        data: JSON.stringify({
          event: 'orders.updated',
          channel: 'private-orders.1',
          data: JSON.stringify({ id: 'ord_1' }),
        }),
      })
      await second.sendWhisper('typing.start', { editing: true })
      await connector.disconnect()

      expect(openedUrl).toBe('wss://socket.example.test:443/realtime/browser%20key')
      expect(sentMessages).toEqual([
        {
          event: 'pusher:subscribe',
          data: {
            channel: 'private-orders.1',
          },
        },
        {
          event: 'pusher:subscribe',
          data: {
            channel: 'presence-chat.1',
          },
        },
        {
          event: 'client-typing.start',
          channel: 'private-orders.1',
          data: {
            editing: true,
          },
        },
      ])
      expect(received).toEqual([{ second: { id: 'ord_1' } }])
      expect(memberSnapshots).toEqual([[]])
      expect(transitions).toEqual(['connecting', 'connected', 'disconnected'])
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
      resetFluxClient()
    }
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
    const receivedPresenceNotifications: unknown[] = []
    const receivedPresenceWhispers: unknown[] = []

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
    presenceSubscription.notification((payload) => {
      receivedPresenceNotifications.push(payload)
    })
    presenceSubscription.listenForWhisper('typing.start' as never, (payload) => {
      receivedPresenceWhispers.push(payload)
    })
    expect(() => publicSubscription.listen('   ' as never, () => undefined)).toThrow('must be a non-empty string')
    expect(() => publicSubscription.listenForWhisper('   ' as never, () => undefined)).toThrow('must be a non-empty string')

    debug!.emitEvent('orders.1', 'orders.updated', { id: 'ord_1' })
    debug!.emitNotification('orders.1', { type: 'OrderUpdated' })
    debug!.emitNotification('chat.1', { type: 'PresenceUpdated' })
    await publicSubscription.whisper('typing.start' as never, { editing: true })
    await presenceSubscription.whisper('typing.start' as never, { editing: 'presence' })
    expect(receivedEvents).toEqual([{ id: 'ord_1' }])
    expect(receivedNotifications).toEqual([{ type: 'OrderUpdated' }])
    expect(receivedPresenceNotifications).toEqual([{ type: 'PresenceUpdated' }])
    expect(receivedWhispers).toEqual([
      { editing: true },
      { duplicate: { editing: true } },
    ])
    expect(receivedPresenceWhispers).toEqual([{ editing: 'presence' }])

    publicSubscription.stopListening()
    debug!.emitEvent('orders.1', 'orders.updated', { id: 'ord_2' })
    expect(receivedEvents).toEqual([{ id: 'ord_1' }])

    expect(publicSubscription.listen()).toBe(publicSubscription)
    debug!.emitEvent('orders.1', 'orders.shipped', { id: 'ord_3' })
    expect(receivedEvents).toEqual([{ id: 'ord_1' }, { id: 'ord_3' }])

    debug!.updatePresenceMembers('chat.1', [{ id: 'user_1' }, { id: 'user_2' }])
    expect(presenceSubscription.members).toEqual([{ id: 'user_1' }, { id: 'user_2' }])

    await privateSubscription.whisper('typing.start' as never, { editing: false })
    expect(debug!.getJoinedChannels()).toEqual([
      'public:orders.1',
      'private:orders.1',
      'presence:chat.1',
    ])
    privateSubscription.leave()
    publicSubscription.leaveChannel()
    presenceSubscription.leave()
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
    const presenceSubscription = client.presence('chat.2')
    const seen: Array<readonly unknown[]> = []
    const joined: unknown[] = []
    const left: unknown[] = []

    presenceSubscription.here((members) => {
      seen.push(members)
    })
    presenceSubscription.joining(member => joined.push(member))
    presenceSubscription.leaving(member => left.push(member))

    debug!.updatePresenceMembers('chat.2', [{ id: 'user_1' }])
    debug!.updatePresenceMembers('chat.2', [{ id: 'user_1' }, { id: 'user_2' }])
    debug!.updatePresenceMembers('chat.2', [{ id: 'user_2' }])
    presenceSubscription.stopListening()
    debug!.updatePresenceMembers('chat.2', [{ id: 'user_3' }])
    presenceSubscription.listen()
    debug!.updatePresenceMembers('chat.2', [{ id: 'user_3' }, { id: 'user_4' }])

    expect(seen).toEqual([[]])
    expect(joined).toEqual([{ id: 'user_1' }, { id: 'user_2' }, { id: 'user_4' }])
    expect(left).toEqual([{ id: 'user_1' }])
    expect(presenceSubscription.members).toEqual([{ id: 'user_3' }, { id: 'user_4' }])
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
    const stopFirstListener = channel.onEvent('orders.updated', payload => events.push({ first: payload }))
    channel.onEvent('orders.updated', payload => events.push(payload))
    stopFirstListener()
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

  it('keeps shared connector channels while duplicate subscriptions remain active', () => {
    const client = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const debug = (client as unknown as { __debug?: ReturnType<typeof fluxInternals.createPusherConnector>['__debug'] }).__debug
    const first = client.channel('orders.1')
    const second = client.channel('orders.1')
    const received: unknown[] = []

    second.listen('orders.updated', (payload) => {
      received.push(payload)
    })
    first.leaveChannel()

    expect(debug!.getJoinedChannels()).toEqual(['public:orders.1'])

    debug!.emitEvent('orders.1', 'orders.updated', { id: 'ord_1' })

    expect(received).toEqual([{ id: 'ord_1' }])

    second.leaveChannel()
    expect(debug!.getJoinedChannels()).toEqual([])
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
