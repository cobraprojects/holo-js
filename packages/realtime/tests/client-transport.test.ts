import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  realtimeClientInternals,
} from '../src'
import {
  createWireError,
  RealtimeAuthorizationError,
  RealtimeClientError,
} from '../src/client/errors'
import type {
  RealtimeSubscriptionSnapshot,
} from '../src'

type SocketEvent = 'open' | 'close' | 'error' | 'message'
type SocketListener = (payload?: { readonly data: unknown }) => void

function createSocketHarness(options: {
  readonly autoOpen?: boolean
} = {}): {
  readonly listeners: Map<SocketEvent, Set<SocketListener>>
  readonly closedWebsocketUrls: string[]
  readonly sentFrames: string[]
  readonly websocketUrls: string[]
  emit(event: SocketEvent, payload?: Record<string, unknown>): void
  install(): void
} {
  const listeners = new Map<SocketEvent, Set<SocketListener>>()
  const closedWebsocketUrls: string[] = []
  const sentFrames: string[] = []
  const websocketUrls: string[] = []

  class TestWebSocket {
    readonly readyState = 1

    constructor(readonly url: string) {
      websocketUrls.push(url)
    }

    send(value: string): void {
      sentFrames.push(value)
    }

    close(): void {
      closedWebsocketUrls.push(this.url)
    }

    addEventListener(event: SocketEvent, listener: SocketListener): void {
      const eventListeners = listeners.get(event) ?? new Set<SocketListener>()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      if (event === 'open' && options.autoOpen !== false) {
        queueMicrotask(() => listener())
      }
    }
  }

  return {
    listeners,
    closedWebsocketUrls,
    sentFrames,
    websocketUrls,
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        listener(event === 'message' ? { data: JSON.stringify(payload ?? {}) } : undefined)
      }
    },
    install() {
      vi.stubGlobal('WebSocket', TestWebSocket)
    },
  }
}

function stubBroadcastConfig(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    key: 'app-key',
    host: '127.0.0.1',
    port: 8080,
    path: '/app',
    scheme: 'http',
    ...overrides,
  })))
  vi.stubGlobal('location', {
    protocol: 'http:',
    hostname: 'localhost',
  })
}

async function readSubscriptionWebsocketUrl(options: {
  readonly config?: Record<string, unknown>
  readonly location?: {
    readonly hostname?: string
    readonly protocol?: string
  }
} = {}): Promise<string> {
  const harness = createSocketHarness()
  harness.install()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    key: 'app-key',
    host: '127.0.0.1',
    port: 8080,
    path: '/app',
    scheme: 'http',
    ...options.config,
  })))
  vi.stubGlobal('location', options.location)

  const unsubscribe = realtimeClientInternals.createBroadcastRealtimeTransport().subscribe<readonly unknown[]>(
    'posts.list',
    {},
    () => {},
    () => {},
  )
  await vi.waitUntil(() => harness.sentFrames.length === 1)
  unsubscribe()

  const url = harness.websocketUrls[0]
  if (!url) {
    throw new Error('Expected websocket URL.')
  }

  return url
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  realtimeClientInternals.getRealtimeClientState().warnedMessages.clear()
})

describe('@holo-js/realtime broadcast client transport', () => {
  it('reports transport availability without escalating non-errors', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handledErrors: unknown[] = []

    realtimeClientInternals.getRealtimeClientState().framework = {
      handleError: error => handledErrors.push(error),
    }

    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError('missing')).toBe(false)
    realtimeClientInternals.handleRealtimeConnectionError('missing')

    expect(consoleWarn).toHaveBeenCalledWith(`[@holo-js/realtime] ${realtimeClientInternals.unavailableTransportMessage}`)
    expect(handledErrors).toEqual(['missing'])
  })

  it('recognizes availability errors and normalizes wire errors', () => {
    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError(
      new Error(realtimeClientInternals.missingTransportMessage),
    )).toBe(true)
    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError(
      new Error('Realtime broadcast config failed with HTTP 503.'),
    )).toBe(true)

    const authorizationError = createWireError({
      code: 'forbidden',
      kind: 'authorization',
      message: 'No access',
      name: 'ForbiddenError',
      status: 403,
    })
    expect(authorizationError).toBeInstanceOf(RealtimeAuthorizationError)
    expect(authorizationError).toMatchObject({
      code: 'forbidden',
      kind: 'authorization',
      message: 'No access',
      name: 'ForbiddenError',
      status: 403,
    })

    const defaultAuthorizationError = createWireError({
      kind: 'authorization',
      message: 'No access',
    })
    expect(defaultAuthorizationError).toBeInstanceOf(RealtimeAuthorizationError)
    expect(defaultAuthorizationError).toMatchObject({
      kind: 'authorization',
      message: 'No access',
      name: 'RealtimeAuthorizationError',
    })

    const fallbackError = createWireError({
      kind: 'invalid',
      message: 1,
      status: 200,
    })
    expect(fallbackError).toBeInstanceOf(RealtimeClientError)
    expect(fallbackError).toMatchObject({
      kind: 'runtime',
      message: realtimeClientInternals.unavailableTransportMessage,
      status: undefined,
    })
  })

  it('executes queries without websocket support and requires fetch only for request execution', async () => {
    vi.stubGlobal('WebSocket', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      name: 'posts.list',
      data: [{ id: 1 }],
      dependencies: [],
      version: 1,
    })))

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).resolves.toMatchObject({ data: [{ id: 1 }] })

    vi.stubGlobal('fetch', undefined)

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).rejects.toThrow('Realtime queries and mutations require fetch support in this runtime.')
  })

  it('preserves request transport failures without reporting a live-update warning', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('offline')))

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).rejects.toBe('offline')

    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('normalizes non-error subscription startup failures to the unavailable transport warning', async () => {
    const harness = createSocketHarness()
    harness.install()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('offline')))

    realtimeClientInternals.createBroadcastRealtimeTransport().subscribe<readonly unknown[]>(
      'posts.list',
      {},
      () => {},
      error => errors.push(error),
    )
    await vi.waitUntil(() => errors.length === 1)

    expect(errors).toEqual(['offline'])
    expect(consoleWarn).toHaveBeenCalledWith(`[@holo-js/realtime] ${realtimeClientInternals.unavailableTransportMessage}`)
  })

  it('rejects failed and malformed broadcast config responses for subscriptions', async () => {
    const harness = createSocketHarness()
    harness.install()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))

    const firstErrors: unknown[] = []
    realtimeClientInternals.createBroadcastRealtimeTransport().subscribe('posts.list', {}, () => {}, error => firstErrors.push(error))
    await vi.waitUntil(() => firstErrors.length === 1)
    expect(firstErrors[0]).toBeInstanceOf(Error)
    expect((firstErrors[0] as Error).message).toBe('Realtime broadcast config failed with HTTP 503.')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ key: 'app-key' })))

    const secondErrors: unknown[] = []
    realtimeClientInternals.createBroadcastRealtimeTransport().subscribe('posts.list', {}, () => {}, error => secondErrors.push(error))
    await vi.waitUntil(() => secondErrors.length === 1)
    expect(secondErrors[0]).toBeInstanceOf(Error)
    expect((secondErrors[0] as Error).message).toBe('Realtime broadcast config response is invalid.')
  })

  it('executes queries and mutations through same-origin HTTP requests', async () => {
    const requests: Array<{ readonly input: string, readonly init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      requests.push({ input, init })
      return input.endsWith('/query')
        ? Response.json({ name: 'posts.list', data: [], dependencies: [], version: 1 })
        : Response.json({ name: 'posts.create', data: { id: 1 }, dependencies: [] })
    }))
    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    await expect(transport.query<readonly unknown[]>('posts.list', { page: 1 })).resolves.toMatchObject({ data: [] })
    await expect(transport.mutate('posts.create', { title: 'Post' })).resolves.toMatchObject({ data: { id: 1 } })
    expect(requests.map(request => request.input)).toEqual([
      '/holo/realtime/query',
      '/holo/realtime/mutation',
    ])
    expect(requests.every(request => request.init?.credentials === 'same-origin')).toBe(true)
    expect(requests.map(request => JSON.parse(String(request.init?.body)))).toEqual([
      { name: 'posts.list', args: { page: 1 } },
      { name: 'posts.create', args: { title: 'Post' } },
    ])
  })

  it('routes subscription startup failures to the subscription error callback', async () => {
    const errors: unknown[] = []
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('WebSocket', undefined)

    const unsubscribe = realtimeClientInternals.createBroadcastRealtimeTransport().subscribe<readonly unknown[]>(
      'posts.list',
      {},
      () => {},
      error => errors.push(error),
    )
    await vi.waitUntil(() => errors.length === 1)
    unsubscribe()

    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('Realtime live updates require WebSocket support in this runtime.')
    expect(consoleWarn).toHaveBeenCalledTimes(1)
  })

  it('shares one connecting websocket across concurrent subscriptions', async () => {
    const harness = createSocketHarness({ autoOpen: false })
    harness.install()
    stubBroadcastConfig()

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const firstUnsubscribe = transport.subscribe('posts.list', {}, () => {}, () => {})
    const secondUnsubscribe = transport.subscribe('posts.featured', {}, () => {}, () => {})

    await vi.waitUntil(() => harness.websocketUrls.length === 1)
    expect(harness.websocketUrls).toEqual(['ws://localhost:8080/app/app-key'])
    harness.emit('open')
    await vi.waitUntil(() => harness.sentFrames.length === 2)

    expect(harness.websocketUrls).toHaveLength(1)
    firstUnsubscribe()
    expect(harness.closedWebsocketUrls).toEqual([])
    secondUnsubscribe()
    expect(harness.closedWebsocketUrls).toEqual(['ws://localhost:8080/app/app-key'])
  })

  it('reconnects after the final subscription leaves so the next connection uses current authentication', async () => {
    const harness = createSocketHarness()
    harness.install()
    stubBroadcastConfig()

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const firstUnsubscribe = transport.subscribe('posts.list', {}, () => {}, () => {})
    await vi.waitUntil(() => harness.sentFrames.length === 1)
    firstUnsubscribe()

    expect(harness.closedWebsocketUrls).toEqual(['ws://localhost:8080/app/app-key'])

    const secondUnsubscribe = transport.subscribe('posts.list', {}, () => {}, () => {})
    await vi.waitUntil(() => harness.websocketUrls.length === 2)
    await vi.waitUntil(() => harness.sentFrames.length === 3)

    expect(harness.websocketUrls).toEqual([
      'ws://localhost:8080/app/app-key',
      'ws://localhost:8080/app/app-key',
    ])
    secondUnsubscribe()
  })

  it('normalizes websocket URLs for deployment and browser host variants', async () => {
    await expect(readSubscriptionWebsocketUrl({
      config: {
        host: 'broadcast.example.com',
        port: 443,
        path: 'socket/',
        scheme: 'https',
      },
    })).resolves.toBe('wss://broadcast.example.com:443/socket/app-key')

    await expect(readSubscriptionWebsocketUrl({
      location: {
        protocol: 'https:',
        hostname: 'localhost',
      },
    })).resolves.toBe('wss://localhost:8080/app/app-key')

    await expect(readSubscriptionWebsocketUrl({
      config: {
        host: '0.0.0.0',
      },
    })).resolves.toBe('ws://127.0.0.1:8080/app/app-key')

    await expect(readSubscriptionWebsocketUrl({
      config: {
        host: 'broadcast.example.com',
      },
      location: {
        protocol: 'http:',
        hostname: 'app.example.com',
      },
    })).resolves.toBe('ws://broadcast.example.com:8080/app/app-key')
  })

  it('fans websocket errors out to active subscriptions without affecting requests', async () => {
    const harness = createSocketHarness()
    harness.install()
    stubBroadcastConfig()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors: unknown[] = []

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    transport.subscribe<readonly unknown[]>(
      'posts.list',
      {},
      () => {},
      error => errors.push(error),
    )
    await vi.waitUntil(() => harness.sentFrames.length === 1)

    harness.emit('error')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe(realtimeClientInternals.unavailableTransportMessage)
    expect(consoleWarn).toHaveBeenCalledWith(`[@holo-js/realtime] ${realtimeClientInternals.unavailableTransportMessage}`)
  })

  it('ignores malformed, stale, and unknown websocket messages without notifying subscribers', async () => {
    const harness = createSocketHarness()
    harness.install()
    stubBroadcastConfig()

    const snapshots: Array<RealtimeSubscriptionSnapshot<readonly unknown[]>> = []
    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const unsubscribe = transport.subscribe<readonly unknown[]>(
      'posts.list',
      {},
      snapshot => snapshots.push(snapshot),
      () => {},
    )
    await vi.waitUntil(() => harness.sentFrames.length === 1)
    const frame = JSON.parse(harness.sentFrames[0]!) as { readonly data: { readonly id: string } }

    harness.emit('message', { event: 'unknown', data: JSON.stringify({ id: frame.data.id }) })
    harness.emit('message', { data: JSON.stringify({ id: frame.data.id }) })
    harness.emit('message', { event: 'holo:realtime:snapshot', data: JSON.stringify({ id: frame.data.id }) })
    harness.emit('message', { event: 'holo:realtime:snapshot', data: JSON.stringify({
      id: frame.data.id,
      snapshot: {
        name: 'posts.list',
        data: [],
        dependencies: [],
        version: 2,
      },
    }) })
    harness.emit('message', { event: 'holo:realtime:snapshot', data: JSON.stringify({
      id: frame.data.id,
      snapshot: {
        name: 'posts.list',
        data: [{ id: 1 }],
        dependencies: [],
        version: 1,
      },
    }) })
    harness.emit('message', { event: 'holo:realtime:patch', data: JSON.stringify({
      id: frame.data.id,
      patch: {
        operations: [{
          op: 'splice',
          path: [],
          index: 0,
          deleteCount: 0,
          values: [{ id: 2 }],
        }],
        version: 3,
      },
    }) })
    harness.emit('message', { event: 'holo:realtime:patch', data: JSON.stringify({
      id: frame.data.id,
      patch: {
        operations: [{
          op: 'splice',
          path: [],
          index: 0,
          deleteCount: 0,
          values: [{ id: 3 }],
        }],
        version: 3,
      },
    }) })
    harness.emit('message', {
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: 'missing',
        patch: {
          operations: [],
          version: 4,
        },
      }),
    })
    harness.emit('message', { event: 'holo:realtime:result', data: JSON.stringify({}) })
    for (const listener of harness.listeners.get('message') ?? []) {
      listener({ data: { invalid: true } })
    }
    unsubscribe()

    expect(snapshots).toEqual([
      {
        name: 'posts.list',
        data: [],
        dependencies: [],
        version: 2,
      },
      {
        name: 'posts.list',
        data: [{ id: 2 }],
        dependencies: [],
        version: 3,
      },
    ])
  })
})
