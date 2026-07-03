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
  readonly sentFrames: string[]
  readonly websocketUrls: string[]
  emit(event: SocketEvent, payload?: Record<string, unknown>): void
  install(): void
} {
  const listeners = new Map<SocketEvent, Set<SocketListener>>()
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

    close(): void {}

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

async function readQueryWebsocketUrl(options: {
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

  const queryPromise = realtimeClientInternals.createBroadcastRealtimeTransport().query<readonly unknown[]>(
    'posts.list',
    {},
  )
  await vi.waitUntil(() => harness.sentFrames.length === 1)
  const queryFrame = JSON.parse(harness.sentFrames[0]!) as { readonly data: { readonly id: string } }
  harness.emit('message', {
    event: 'holo:realtime:result',
    data: JSON.stringify({
      id: queryFrame.data.id,
      snapshot: {
        name: 'posts.list',
        data: [],
        dependencies: [],
        version: 1,
      },
    }),
  })
  await queryPromise

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

  it('fails queries clearly when websocket or config fetch support is unavailable', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('WebSocket', undefined)

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).rejects.toThrow('Realtime live updates require WebSocket support in this runtime.')

    const harness = createSocketHarness()
    harness.install()
    vi.stubGlobal('fetch', undefined)

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).rejects.toThrow('Realtime live updates require fetch support in this runtime.')
    expect(consoleWarn).toHaveBeenCalledTimes(2)
  })

  it('normalizes non-error query transport failures to the unavailable transport warning', async () => {
    const harness = createSocketHarness()
    harness.install()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('offline')))

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).rejects.toBe('offline')

    expect(consoleWarn).toHaveBeenCalledWith(`[@holo-js/realtime] ${realtimeClientInternals.unavailableTransportMessage}`)
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

  it('rejects failed and malformed broadcast config responses', async () => {
    const harness = createSocketHarness()
    harness.install()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).rejects.toThrow('Realtime broadcast config failed with HTTP 503.')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ key: 'app-key' })))

    await expect(
      realtimeClientInternals.createBroadcastRealtimeTransport().query('posts.list', {}),
    ).rejects.toThrow('Realtime broadcast config response is invalid.')
  })

  it('rejects malformed query and mutation responses after websocket delivery', async () => {
    const harness = createSocketHarness()
    harness.install()
    stubBroadcastConfig()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const queryPromise = transport.query<readonly unknown[]>('posts.list', {})
    await vi.waitUntil(() => harness.sentFrames.length === 1)
    const queryFrame = JSON.parse(harness.sentFrames[0]!) as { readonly data: { readonly id: string } }
    harness.emit('message', {
      event: 'holo:realtime:result',
      data: JSON.stringify({ id: queryFrame.data.id }),
    })
    await expect(queryPromise).rejects.toThrow('Realtime query response did not include a snapshot.')

    const mutationPromise = transport.mutate('posts.create', {})
    await vi.waitUntil(() => harness.sentFrames.length === 2)
    const mutationFrame = JSON.parse(harness.sentFrames[1]!) as { readonly data: { readonly id: string } }
    harness.emit('message', {
      event: 'holo:realtime:result',
      data: JSON.stringify({ id: mutationFrame.data.id }),
    })
    await expect(mutationPromise).rejects.toThrow('Realtime mutation response did not include a result.')
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

  it('shares one connecting websocket across concurrent requests', async () => {
    const harness = createSocketHarness({ autoOpen: false })
    harness.install()
    stubBroadcastConfig()

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const queryPromise = transport.query<readonly unknown[]>('posts.list', {})
    const mutationPromise = transport.mutate('posts.create', {})

    await vi.waitUntil(() => harness.websocketUrls.length === 1)
    expect(harness.websocketUrls).toEqual(['ws://localhost:8080/app/app-key'])
    harness.emit('open')
    await vi.waitUntil(() => harness.sentFrames.length === 2)

    const queryFrame = JSON.parse(harness.sentFrames[0]!) as { readonly data: { readonly id: string } }
    const mutationFrame = JSON.parse(harness.sentFrames[1]!) as { readonly data: { readonly id: string } }
    harness.emit('message', {
      event: 'holo:realtime:result',
      data: JSON.stringify({
        id: queryFrame.data.id,
        snapshot: {
          name: 'posts.list',
          data: [],
          dependencies: [],
          version: 1,
        },
      }),
    })
    harness.emit('message', {
      event: 'holo:realtime:result',
      data: JSON.stringify({
        id: mutationFrame.data.id,
        result: {
          name: 'posts.create',
          data: { ok: true },
          dependencies: [],
        },
      }),
    })

    await expect(queryPromise).resolves.toMatchObject({
      data: [],
      version: 1,
    })
    await expect(mutationPromise).resolves.toMatchObject({
      data: { ok: true },
    })
    expect(harness.websocketUrls).toHaveLength(1)
  })

  it('normalizes websocket URLs for deployment and browser host variants', async () => {
    await expect(readQueryWebsocketUrl({
      config: {
        host: 'broadcast.example.com',
        port: 443,
        path: 'socket/',
        scheme: 'https',
      },
    })).resolves.toBe('wss://broadcast.example.com:443/socket/app-key')

    await expect(readQueryWebsocketUrl({
      location: {
        protocol: 'https:',
        hostname: 'localhost',
      },
    })).resolves.toBe('wss://localhost:8080/app/app-key')

    await expect(readQueryWebsocketUrl({
      config: {
        host: '0.0.0.0',
      },
    })).resolves.toBe('ws://127.0.0.1:8080/app/app-key')

    await expect(readQueryWebsocketUrl({
      config: {
        host: 'broadcast.example.com',
      },
      location: {
        protocol: 'http:',
        hostname: 'app.example.com',
      },
    })).resolves.toBe('ws://broadcast.example.com:8080/app/app-key')
  })

  it('fans websocket errors out to pending requests and active subscriptions', async () => {
    const harness = createSocketHarness()
    harness.install()
    stubBroadcastConfig()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors: unknown[] = []

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const queryPromise = transport.query<readonly unknown[]>('posts.list', {})
    transport.subscribe<readonly unknown[]>(
      'posts.list',
      {},
      () => {},
      error => errors.push(error),
    )
    await vi.waitUntil(() => harness.sentFrames.length === 2)

    harness.emit('error')

    await expect(queryPromise).rejects.toThrow(realtimeClientInternals.unavailableTransportMessage)
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
