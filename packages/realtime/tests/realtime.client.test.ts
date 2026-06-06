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

  it('throws when a query is called before a framework runtime is configured', () => {
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    expect(() => useRealtimeQuery(listPosts, {})).toThrow('Realtime queries require a Holo framework client runtime.')
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

  it('rejects stream subscriptions before creating an oversized EventSource URL', () => {
    const errors: unknown[] = []
    const createdUrls: string[] = []
    class TestEventSource {
      onmessage: ((event: { readonly data: string }) => void) | null = null
      onerror: ((event: unknown) => void) | null = null

      constructor(url: string) {
        createdUrls.push(url)
      }

      close(): void {}
    }

    vi.stubGlobal('EventSource', TestEventSource)

    const transport = realtimeClientInternals.createFetchRealtimeTransport()
    const unsubscribe = transport.subscribe(
      'posts.list',
      { search: 'x'.repeat(9000) },
      () => {},
      error => errors.push(error),
    )

    unsubscribe()

    expect(createdUrls).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toContain('Realtime stream arguments are too large')
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

  it('uses fetch and EventSource for the default transport', async () => {
    const messages: Array<{ readonly data: string }> = []
    const closed: string[] = []
    const fetchCalls: string[] = []
    const eventSources: TestEventSource[] = []

    class TestEventSource {
      onmessage: ((event: { readonly data: string }) => void) | null = null
      onerror: ((event: unknown) => void) | null = null

      constructor(readonly url: string) {
        fetchCalls.push(url)
        eventSources.push(this)
      }

      close(): void {
        closed.push(this.url)
      }
    }

    vi.stubGlobal('EventSource', TestEventSource)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetchCalls.push(url)

      return Response.json({
        name: url.includes('mutation') ? 'posts.create' : 'posts.list',
        data: url.includes('mutation') ? { created: true } : [{ id: 1, title: 'First' }],
        dependencies: [],
        version: 1,
      })
    }))

    const transport = realtimeClientInternals.createFetchRealtimeTransport()
    await expect(transport.query<readonly Post[]>('posts.list', { limit: 1 })).resolves.toMatchObject({
      data: [{ id: 1, title: 'First' }],
    })
    await expect(transport.mutate('posts.create', { title: 'First' })).resolves.toMatchObject({
      data: { created: true },
    })

    const unsubscribe = transport.subscribe<readonly Post[]>('posts.list', { limit: 1 }, (snapshot) => {
      messages.push({ data: JSON.stringify(snapshot) })
    }, () => {})
    const source = realtimeClientInternals.getRealtimeClientState().stores
    expect(source.size).toBe(0)

    eventSources[0]!.onmessage?.({
      data: JSON.stringify({
        name: 'posts.list',
        data: [{ id: 2, title: 'Second' }],
        dependencies: [],
        version: 2,
      }),
    })

    unsubscribe()

    expect(fetchCalls).toEqual([
      '/holo/realtime/query',
      '/holo/realtime/mutation',
      '/holo/realtime/stream?name=posts.list&args=%7B%22limit%22%3A1%7D',
    ])
    expect(closed).toEqual(['/holo/realtime/stream?name=posts.list&args=%7B%22limit%22%3A1%7D'])
    expect(messages).toEqual([
      {
        data: JSON.stringify({
          name: 'posts.list',
          data: [{ id: 2, title: 'Second' }],
          dependencies: [],
          version: 2,
        }),
      },
    ])
  })

  it('uses the default fetch transport for callable mutations when no custom transport is configured', async () => {
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

    await expect(createPost()).resolves.toEqual({ created: true })
  })

  it('surfaces failed default transport requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))

    const transport = realtimeClientInternals.createFetchRealtimeTransport()
    const unsubscribe = transport.subscribe('posts.list', {}, () => {}, () => {})

    await expect(transport.query('posts.list', {})).rejects.toThrow('Realtime query failed with status 500.')
    await expect(transport.mutate('posts.create', {})).rejects.toThrow('Realtime mutation failed with status 500.')
    expect(unsubscribe).toEqual(expect.any(Function))
    unsubscribe()
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
