import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  getRealtimeQueryStore,
  hydrateRealtimeQuery,
  mutation,
  query,
  realtimeClientInternals,
  resetRealtimeClientRuntime,
  useRealtimeQuery,
} from '../src/index'
import type {
  RealtimeArgsFor,
  RealtimeClientTransport,
  RealtimeQueryDefinition,
  RealtimeResultFor,
  RealtimeSubscriptionSnapshot,
} from '../src/index'

type Post = {
  readonly id: number
  readonly title: string
}

afterEach(() => {
  resetRealtimeClientRuntime()
  vi.unstubAllGlobals()
})

describe('@holo-js/realtime client runtime', () => {
  it('uses the configured framework runtime when a query definition is called', () => {
    const calls: unknown[] = []
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    configureRealtimeClientRuntime({
      useQuery<TDefinition extends RealtimeQueryDefinition>(
        definition: TDefinition,
        args: RealtimeArgsFor<TDefinition>,
      ): RealtimeResultFor<TDefinition> {
        expect(definition.name).toBe('posts.list')
        calls.push(args)

        return [{ id: 2, title: 'Second' }] as RealtimeResultFor<TDefinition>
      },
    })

    expect(listPosts({ limit: 2 } as never)).toEqual([{ id: 2, title: 'Second' }])
    expect(listPosts()).toEqual([{ id: 2, title: 'Second' }])
    expect(calls).toEqual([{ limit: 2 }, {}])
  })

  it('returns the hydrated snapshot when a query is called before a framework runtime is configured', () => {
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    hydrateRealtimeQuery(listPosts, {}, {
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: [],
      version: 1,
    })

    expect(useRealtimeQuery(listPosts, {})).toEqual([{ id: 1, title: 'First' }])
  })

  it('hydrates and refreshes query stores through the configured transport', async () => {
    const snapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const calls: string[] = []
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    const transport: RealtimeClientTransport = {
      async query<TResult>(name: string, args: Record<string, unknown>) {
        calls.push(`query:${name}:${String(args.tag)}`)

        return {
          name,
          data: [{ id: 1, title: 'First' }] as TResult,
          dependencies: ['table:posts'],
          version: 1,
        }
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: { ok: true } as TResult,
          dependencies: [],
        }
      },
      subscribe<TResult>(
        name: string,
        args: Record<string, unknown>,
        listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
      ) {
        calls.push(`subscribe:${name}:${String(args.tag)}`)
        listener({
          name,
          data: [
            { id: 1, title: 'First' },
            { id: 2, title: 'Second' },
          ] as TResult,
          dependencies: ['table:posts'],
          version: 2,
        })

        return () => {
          calls.push(`unsubscribe:${name}`)
        }
      },
    }
    configureRealtimeClientTransport(transport)

    const store = getRealtimeQueryStore(listPosts, {
      tag: 'news',
      filters: ['featured', 'recent'],
    } as never)
    const sameStore = getRealtimeQueryStore(listPosts, {
      filters: ['featured', 'recent'],
      tag: 'news',
    } as never)

    expect(sameStore).toBe(store)

    const unsubscribe = store.subscribe(() => {
      if (store.snapshot) {
        snapshots.push(store.snapshot)
      }
    })

    store.connect()
    store.connect()
    await Promise.resolve()

    expect(snapshots.map(snapshot => snapshot.data)).toEqual([
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
      [{ id: 1, title: 'First' }],
    ])
    expect(calls).toEqual([
      'query:posts.list:news',
      'subscribe:posts.list:news',
    ])

    unsubscribe()

    expect(calls).toEqual([
      'query:posts.list:news',
      'subscribe:posts.list:news',
      'unsubscribe:posts.list',
    ])
  })

  it('keeps query stores connected until the last listener unsubscribes', () => {
    const calls: string[] = []
    const transport = {
      async query<TResult>(name: string) {
        return {
          name,
          data: [] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe(name: string) {
        calls.push(`subscribe:${name}`)

        return () => {
          calls.push(`unsubscribe:${name}`)
        }
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.list', {}, transport)
    const first = store.subscribe(() => {})
    const second = store.subscribe(() => {})

    store.connect()
    first()

    expect(calls).toEqual(['subscribe:posts.list'])

    second()

    expect(calls).toEqual(['subscribe:posts.list', 'unsubscribe:posts.list'])
  })

  it('handles query store cleanup before connect and transport startup failures', async () => {
    const calls: string[] = []
    const idleTransport = {
      async query<TResult>(name: string) {
        return {
          name,
          data: [] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        return () => {
          calls.push('unused')
        }
      },
    } satisfies RealtimeClientTransport
    const disconnectedStore = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.idle', {}, idleTransport)
    const unsubscribeDisconnected = disconnectedStore.subscribe(() => {})
    unsubscribeDisconnected()

    const failingTransport = {
      async query() {
        throw new Error('query failed')
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe<TResult>(
        _name: string,
        _args: Record<string, unknown>,
        _listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
        onError: (error: unknown) => void,
      ) {
        onError(new Error('subscribe failed'))

        return () => {
          calls.push('failed unsubscribe')
        }
      },
    } satisfies RealtimeClientTransport
    const failingStore = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.fail', {}, failingTransport)
    const unsubscribeFailing = failingStore.subscribe(() => {})
    failingStore.connect()
    await Promise.resolve()
    unsubscribeFailing()
    const unsubscribeAfterReset = failingStore.subscribe(() => {})
    unsubscribeAfterReset()

    expect(calls).toEqual(['failed unsubscribe'])
  })

  it('does not create hidden route requests when no client transport is configured', async () => {
    const errors: unknown[] = []
    const fetchSpy = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchSpy)

    const transport = realtimeClientInternals.createMissingRealtimeTransport()
    const unsubscribe = transport.subscribe(
      'posts.list',
      { search: 'x' },
      () => {},
      error => errors.push(error),
    )

    unsubscribe()

    await expect(transport.query('posts.list', {})).rejects.toThrow(realtimeClientInternals.missingTransportMessage)
    await expect(transport.mutate('posts.create', {})).rejects.toThrow(realtimeClientInternals.missingTransportMessage)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe(realtimeClientInternals.missingTransportMessage)
  })

  it('uses the broadcast websocket transport for query, mutation, and subscriptions', async () => {
    const sentFrames: string[] = []
    const websocketUrls: string[] = []
    const listeners = new Map<string, Set<(event?: { readonly data: unknown }) => void>>()

    class TestWebSocket {
      readonly readyState = 1

      constructor(readonly url: string) {
        websocketUrls.push(url)
      }

      send(value: string): void {
        sentFrames.push(value)
      }

      close(): void {}

      addEventListener(event: 'open' | 'close' | 'error' | 'message', listener: (payload?: { readonly data: unknown }) => void): void {
        const eventListeners = listeners.get(event) ?? new Set<(payload?: { readonly data: unknown }) => void>()
        eventListeners.add(listener)
        listeners.set(event, eventListeners)
        if (event === 'open') {
          queueMicrotask(() => listener())
        }
      }
    }

    const emitMessage = (payload: Record<string, unknown>) => {
      for (const listener of listeners.get('message') ?? []) {
        listener({ data: JSON.stringify(payload) })
      }
    }

    vi.stubGlobal('WebSocket', TestWebSocket)
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe('/broadcasting/config')
      return Response.json({
        key: 'app-key',
        host: '127.0.0.1',
        port: 8080,
        path: '/app',
        scheme: 'http',
      })
    })
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: 'localhost',
    })

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const queryPromise = transport.query<readonly Post[]>('posts.list', { page: 1 })
    await vi.waitUntil(() => sentFrames.length === 1)
    expect(websocketUrls).toEqual(['ws://localhost:8080/app/app-key'])
    const queryFrame = JSON.parse(sentFrames[0]!) as { data: { id: string } }
    emitMessage({
      event: 'holo:realtime:result',
      data: JSON.stringify({
        id: queryFrame.data.id,
        snapshot: {
          name: 'posts.list',
          data: [{ id: 1, title: 'First' }],
          dependencies: ['table:posts'],
          version: 1,
        },
      }),
    })

    await expect(queryPromise).resolves.toEqual({
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: ['table:posts'],
      version: 1,
    })

    const mutationPromise = transport.mutate<Post>('posts.update', { id: 1, title: 'Updated' })
    await vi.waitUntil(() => sentFrames.length === 2)
    const mutationFrame = JSON.parse(sentFrames[1]!) as { data: { id: string } }
    emitMessage({
      event: 'holo:realtime:result',
      data: JSON.stringify({
        id: mutationFrame.data.id,
        result: {
          name: 'posts.update',
          data: { id: 1, title: 'Updated' },
          dependencies: [],
        },
      }),
    })

    await expect(mutationPromise).resolves.toEqual({
      name: 'posts.update',
      data: { id: 1, title: 'Updated' },
      dependencies: [],
    })

    const snapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const unsubscribe = transport.subscribe<readonly Post[]>(
      'posts.list',
      { page: 1 },
      snapshot => snapshots.push(snapshot),
      () => {},
    )
    await vi.waitUntil(() => sentFrames.length === 3)
    const subscribeFrame = JSON.parse(sentFrames[2]!) as { data: { id: string } }
    emitMessage({
      event: 'holo:realtime:snapshot',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        snapshot: {
          name: 'posts.list',
          data: [{ id: 2, title: 'Second' }],
          dependencies: ['table:posts'],
          version: 2,
        },
      }),
    })

    expect(snapshots).toEqual([{
      name: 'posts.list',
      data: [{ id: 2, title: 'Second' }],
      dependencies: ['table:posts'],
      version: 2,
    }])

    unsubscribe()

    expect(sentFrames.map(frame => JSON.parse(frame) as { event: string, data: { action: string, name?: string } })).toEqual([
      {
        event: 'holo:realtime',
        data: {
          id: queryFrame.data.id,
          action: 'query',
          name: 'posts.list',
          args: { page: 1 },
        },
      },
      {
        event: 'holo:realtime',
        data: {
          id: mutationFrame.data.id,
          action: 'mutation',
          name: 'posts.update',
          args: { id: 1, title: 'Updated' },
        },
      },
      {
        event: 'holo:realtime',
        data: {
          id: subscribeFrame.data.id,
          action: 'subscribe',
          name: 'posts.list',
          args: { page: 1 },
        },
      },
      {
        event: 'holo:realtime',
        data: {
          id: subscribeFrame.data.id,
          action: 'unsubscribe',
          args: {},
        },
      },
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('executes mutations through the configured transport', async () => {
    const createPost = mutation({
      name: 'posts.create',
      access: 'public',
      handler: async () => ({ id: 1, title: 'First' }),
    })

    configureRealtimeClientTransport({
      async query<TResult>(name: string) {
        return {
          name,
          data: [] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>(name: string, args: Record<string, unknown>) {
        return {
          name,
          data: {
            id: 1,
            title: args.title,
          } as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        return () => {}
      },
    } satisfies RealtimeClientTransport)

    await expect(createPost({ title: 'First' } as never)).resolves.toEqual({
      id: 1,
      title: 'First',
    })
  })

  it('requires an explicit transport for callable mutations', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      name: 'posts.create',
      data: { created: true },
      dependencies: [],
    })))
    const createPost = mutation({
      name: 'posts.create',
      access: 'public',
      handler: async () => ({ created: true }),
    })

    await expect(createPost()).rejects.toThrow(realtimeClientInternals.missingTransportMessage)
  })

  it('hydrates stores with normalized empty args', () => {
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    hydrateRealtimeQuery(listPosts, [] as never, {
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: [],
      version: 1,
    })

    expect(getRealtimeQueryStore(listPosts, undefined as never).snapshot?.data).toEqual([{ id: 1, title: 'First' }])
  })
})
