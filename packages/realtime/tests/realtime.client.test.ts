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
  readonly views?: number
}

type PostTag = {
  readonly id: number
  readonly name: string
  readonly pivot: {
    readonly weight: number
  }
}

type PostWithTags = Post & {
  readonly tags: readonly PostTag[]
}

function createIdleClientTransport(): RealtimeClientTransport {
  return {
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
      return () => {}
    },
  }
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

  it('reports query store subscription startup failures without blocking initial query snapshots', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const transport = {
      async query<TResult>(name: string) {
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
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        throw new Error('subscription startup failed')
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.list', {}, transport)

    store.subscribe(() => {})
    store.connect()
    await Promise.resolve()

    expect(store.snapshot?.data).toEqual([{ id: 1, title: 'First' }])
    expect(consoleWarn).toHaveBeenCalledWith('[@holo-js/realtime] subscription startup failed')
    expect(() => {
      store.disconnect()
    }).not.toThrow()
  })

  it('keeps the initial query result when realtime subscription startup fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const transport = {
      async query<TResult>(name: string) {
        await Promise.resolve()

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
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        throw new Error('subscription startup failed')
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.list', {}, transport)

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.connect()
    await vi.waitUntil(() => observedSnapshots.length === 1)

    expect(store.snapshot?.data).toEqual([{ id: 1, title: 'First' }])
    expect(observedSnapshots.map(snapshot => snapshot.data)).toEqual([
      [{ id: 1, title: 'First' }],
    ])
    expect(consoleWarn).toHaveBeenCalledWith('[@holo-js/realtime] subscription startup failed')
  })

  it('does not notify query store listeners for unchanged snapshot data', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
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
      subscribe() {
        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.list', {}, transport)

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: ['table:posts'],
      version: 1,
    })
    const firstData = store.snapshot?.data
    store.setSnapshot({
      name: 'posts.list',
      data: [{ title: 'First', id: 1 }],
      dependencies: ['table:posts', 'table:comments'],
      version: 2,
    })
    expect(store.snapshot?.data).toBe(firstData)
    expect(store.snapshot?.dependencies).toEqual(['table:posts', 'table:comments'])
    expect(store.snapshot?.version).toBe(2)
    store.setSnapshot({
      name: 'posts.list',
      data: [{ id: 2, title: 'Second' }],
      dependencies: ['table:posts'],
      version: 3,
    })

    expect(observedSnapshots.map(snapshot => snapshot.data)).toEqual([
      [{ id: 1, title: 'First' }],
      [{ id: 2, title: 'Second' }],
    ])
    expect(store.snapshot?.version).toBe(3)
  })

  it('applies patched query store snapshots with structural sharing and later full snapshot dedupe', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
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
      subscribe() {
        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.list', {}, transport)

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First', views: 1 },
        { id: 2, title: 'Second' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    })
    const firstRow = store.snapshot?.data[0]
    const secondRow = store.snapshot?.data[1]

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'merge',
        path: [0],
        fields: {
          title: 'Updated First',
          views: 2,
        },
      }],
      version: 2,
    }))

    expect(store.snapshot?.data[0]).not.toBe(firstRow)
    expect(store.snapshot?.data[1]).toBe(secondRow)
    expect(store.snapshot?.data).toEqual([
      { id: 1, title: 'Updated First', views: 2 },
      { id: 2, title: 'Second' },
    ])

    const patchedData = store.snapshot?.data
    store.setSnapshot({
      name: 'posts.list',
      data: [
        { id: 1, title: 'Updated First', views: 2 },
        { id: 2, title: 'Second' },
      ],
      dependencies: ['table:posts', 'table:comments'],
      version: 3,
    })

    expect(observedSnapshots).toHaveLength(2)
    expect(store.snapshot?.data).toBe(patchedData)
    expect(store.snapshot?.dependencies).toEqual(['table:posts', 'table:comments'])
    expect(store.snapshot?.version).toBe(3)
  })

  it('applies nested relation patches with structural sharing', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly PostWithTags[]>> = []
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
      subscribe() {
        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly PostWithTags[]>('posts.withTags', {}, transport)

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.withTags',
      data: [
        {
          id: 1,
          title: 'First',
          tags: [
            { id: 10, name: 'News', pivot: { weight: 1 } },
            { id: 11, name: 'Featured', pivot: { weight: 2 } },
          ],
        },
        {
          id: 2,
          title: 'Second',
          tags: [
            { id: 12, name: 'Archived', pivot: { weight: 3 } },
          ],
        },
      ],
      dependencies: ['table:posts', 'table:tags', 'table:post_tags'],
      version: 1,
    })

    const initialData = store.snapshot?.data
    const initialFirstPost = initialData?.[0]
    const initialSecondPost = initialData?.[1]
    const initialFirstTags = initialFirstPost?.tags
    const initialFirstTag = initialFirstTags?.[0]
    const initialSecondTag = initialFirstTags?.[1]
    if (!initialData || !initialFirstPost || !initialSecondPost || !initialFirstTags || !initialFirstTag || !initialSecondTag) {
      throw new Error('Expected nested relation snapshot to be initialized.')
    }

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'replace',
        path: [0, 'tags', 0, 'name'],
        value: 'Updated News',
      }],
      version: 2,
    }))

    const replacedData = store.snapshot?.data
    const replacedFirstPost = replacedData?.[0]
    const replacedSecondPost = replacedData?.[1]
    const replacedFirstTags = replacedFirstPost?.tags
    const replacedFirstTag = replacedFirstTags?.[0]
    const replacedSecondTag = replacedFirstTags?.[1]
    if (!replacedData || !replacedFirstPost || !replacedSecondPost || !replacedFirstTags || !replacedFirstTag || !replacedSecondTag) {
      throw new Error('Expected nested relation replace patch to keep snapshot data.')
    }

    expect(replacedData).not.toBe(initialData)
    expect(replacedFirstPost).not.toBe(initialFirstPost)
    expect(replacedSecondPost).toBe(initialSecondPost)
    expect(replacedFirstTags).not.toBe(initialFirstTags)
    expect(replacedFirstTag).not.toBe(initialFirstTag)
    expect(replacedFirstTag.pivot).toBe(initialFirstTag.pivot)
    expect(replacedFirstTag.name).toBe('Updated News')
    expect(replacedSecondTag).toBe(initialSecondTag)

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'move',
        path: [0, 'tags'],
        from: 1,
        to: 0,
      }],
      version: 3,
    }))

    const movedData = store.snapshot?.data
    const movedFirstPost = movedData?.[0]
    const movedSecondPost = movedData?.[1]
    const movedFirstTags = movedFirstPost?.tags
    if (!movedData || !movedFirstPost || !movedSecondPost || !movedFirstTags) {
      throw new Error('Expected nested relation move patch to keep snapshot data.')
    }

    expect(movedData).not.toBe(replacedData)
    expect(movedFirstPost).not.toBe(replacedFirstPost)
    expect(movedSecondPost).toBe(initialSecondPost)
    expect(movedFirstTags).not.toBe(replacedFirstTags)
    expect(movedFirstTags[0]).toBe(replacedSecondTag)
    expect(movedFirstTags[1]).toBe(replacedFirstTag)
    expect(store.snapshot?.version).toBe(3)
    expect(observedSnapshots).toHaveLength(3)
  })

  it('applies multiple nested replace patch operations with structural sharing', () => {
    const snapshot: RealtimeSubscriptionSnapshot<readonly PostWithTags[]> = {
      name: 'posts.withTags',
      data: [
        {
          id: 1,
          title: 'First',
          tags: [
            { id: 10, name: 'News', pivot: { weight: 1 } },
            { id: 11, name: 'Featured', pivot: { weight: 2 } },
          ],
        },
        {
          id: 2,
          title: 'Second',
          tags: [
            { id: 12, name: 'Archived', pivot: { weight: 3 } },
          ],
        },
      ],
      dependencies: ['table:posts', 'table:tags', 'table:post_tags'],
      version: 1,
    }
    const firstPost = snapshot.data[0]
    const secondPost = snapshot.data[1]
    const firstTags = firstPost?.tags
    const secondTags = secondPost?.tags
    const unchangedTag = firstTags?.[1]
    const changedPivot = secondTags?.[0]?.pivot
    if (!firstPost || !secondPost || !firstTags || !secondTags || !unchangedTag || !changedPivot) {
      throw new Error('Expected nested relation snapshot to be initialized.')
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'replace',
          path: [0, 'tags', 0, 'name'],
          value: 'Updated News',
        },
        {
          op: 'replace',
          path: [1, 'tags', 0, 'pivot', 'weight'],
          value: 4,
        },
      ],
      version: 2,
    })

    expect(patched.data).not.toBe(snapshot.data)
    expect(patched.data[0]).not.toBe(firstPost)
    expect(patched.data[1]).not.toBe(secondPost)
    expect(patched.data[0]?.tags).not.toBe(firstTags)
    expect(patched.data[1]?.tags).not.toBe(secondTags)
    expect(patched.data[0]?.tags[1]).toBe(unchangedTag)
    expect(patched.data[1]?.tags[0]?.pivot).not.toBe(changedPivot)
    expect(patched.data).toEqual([
      {
        id: 1,
        title: 'First',
        tags: [
          { id: 10, name: 'Updated News', pivot: { weight: 1 } },
          { id: 11, name: 'Featured', pivot: { weight: 2 } },
        ],
      },
      {
        id: 2,
        title: 'Second',
        tags: [
          { id: 12, name: 'Archived', pivot: { weight: 4 } },
        ],
      },
    ])
    expect(patched.version).toBe(2)
  })

  it('batches encoded undefined replace patches with other replace operations', () => {
    const snapshot: RealtimeSubscriptionSnapshot<readonly Readonly<{
      readonly id: number
      readonly summary?: string
      readonly title: string
    }>[]> = {
      name: 'posts.list',
      data: [
        { id: 1, title: 'First', summary: 'Draft' },
        { id: 2, title: 'Second', summary: 'Published' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    }
    const firstPost = snapshot.data[0]
    const secondPost = snapshot.data[1]
    if (!firstPost || !secondPost) {
      throw new Error('Expected replace patch snapshot rows to be initialized.')
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'replace',
          path: [0, 'summary'],
          valueKind: 'undefined',
        },
        {
          op: 'replace',
          path: [1, 'title'],
          value: 'Updated Second',
        },
      ],
      version: 2,
    })

    expect(patched.data).not.toBe(snapshot.data)
    expect(patched.data[0]).not.toBe(firstPost)
    expect(patched.data[1]).not.toBe(secondPost)
    expect(patched.data[0]?.summary).toBeUndefined()
    expect(patched.data[1]?.title).toBe('Updated Second')
    expect(patched.version).toBe(2)
  })

  it('keeps equivalent merge patches structurally shared without notifying listeners', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>(
      'posts.list',
      {},
      createIdleClientTransport(),
    )

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First', views: 1 },
        { id: 2, title: 'Second' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    })
    const currentData = store.snapshot?.data

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'merge',
        path: [0],
        fields: {
          id: 1,
          title: 'First',
          views: 1,
        },
      }],
      version: 2,
    }))

    expect(observedSnapshots).toHaveLength(1)
    expect(store.snapshot?.data).toBe(currentData)
    expect(store.snapshot?.version).toBe(2)
  })

  it('keeps equivalent replace patches structurally shared without notifying listeners', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>(
      'posts.list',
      {},
      createIdleClientTransport(),
    )

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First', views: 1 },
        { id: 2, title: 'Second' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    })
    const currentData = store.snapshot?.data
    const currentRow = currentData?.[0]

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [
        {
          op: 'replace',
          path: [0, 'title'],
          value: 'First',
        },
        {
          op: 'replace',
          path: [0, 'views'],
          value: 1,
        },
      ],
      version: 2,
    }))

    expect(observedSnapshots).toHaveLength(1)
    expect(store.snapshot?.data).toBe(currentData)
    expect(store.snapshot?.data[0]).toBe(currentRow)
    expect(store.snapshot?.version).toBe(2)
  })

  it('keeps equivalent splice patches structurally shared without notifying listeners', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>(
      'posts.list',
      {},
      createIdleClientTransport(),
    )

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    })
    const currentData = store.snapshot?.data
    const currentRow = currentData?.[1]
    if (!currentData || !currentRow) {
      throw new Error('Expected query store snapshot to be initialized.')
    }

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 1,
        values: [currentRow],
      }],
      version: 2,
    }))

    expect(observedSnapshots).toHaveLength(1)
    expect(store.snapshot?.data).toBe(currentData)
    expect(store.snapshot?.data[1]).toBe(currentRow)
    expect(store.snapshot?.version).toBe(2)
  })

  it('updates query store metadata for structurally shared patches without notifying listeners', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>(
      'posts.list',
      {},
      createIdleClientTransport(),
    )

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    })
    const currentData = store.snapshot?.data

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      dependencies: ['table:posts', 'table:comments'],
      operations: [],
      version: 2,
    }))

    expect(observedSnapshots).toHaveLength(1)
    expect(store.snapshot?.data).toBe(currentData)
    expect(store.snapshot?.dependencies).toEqual(['table:posts', 'table:comments'])
    expect(store.snapshot?.version).toBe(2)
  })

  it('ignores stale query store snapshots and patches', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
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
      subscribe() {
        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.list', {}, transport)

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [{ id: 1, title: 'Current' }],
      dependencies: ['table:posts'],
      version: 3,
    })
    const currentSnapshot = store.snapshot
    if (!currentSnapshot) {
      throw new Error('Expected query store snapshot to be initialized.')
    }

    store.setSnapshot({
      name: 'posts.list',
      data: [{ id: 1, title: 'Older full snapshot' }],
      dependencies: ['table:posts'],
      version: 2,
    })
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(currentSnapshot, {
      operations: [{
        op: 'replace',
        path: [0, 'title'],
        value: 'Older patch',
      }],
      version: 2,
    }))
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(currentSnapshot, {
      operations: [{
        op: 'replace',
        path: [0, 'title'],
        value: 'Next patch',
      }],
      version: 4,
    }))

    expect(store.snapshot?.data).toEqual([{ id: 1, title: 'Next patch' }])
    expect(store.snapshot?.version).toBe(4)
    expect(observedSnapshots.map(snapshot => snapshot.data)).toEqual([
      [{ id: 1, title: 'Current' }],
      [{ id: 1, title: 'Next patch' }],
    ])
  })

  it('decodes undefined replace patches after JSON transport serialization', () => {
    const snapshot: RealtimeSubscriptionSnapshot<string | undefined> = {
      name: 'posts.title',
      data: 'Current',
      dependencies: ['table:posts'],
      version: 1,
    }
    const serializedPatch = JSON.parse(JSON.stringify({
      operations: [{
        op: 'replace',
        path: [],
        valueKind: 'undefined',
      }],
      version: 2,
    })) as unknown
    const patch = realtimeClientInternals.parseWireSnapshotPatch(serializedPatch)
    if (!patch) {
      throw new Error('Expected encoded undefined patch to parse.')
    }

    const nextSnapshot = realtimeClientInternals.applyWireSnapshotPatch(snapshot, patch)

    expect(nextSnapshot.data).toBeUndefined()
    expect(nextSnapshot.version).toBe(2)
  })

  it('applies splice patch operations while preserving existing row identities', () => {
    const snapshot: RealtimeSubscriptionSnapshot<readonly Post[]> = {
      name: 'posts.list',
      data: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 4, title: 'Fourth' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    }
    const firstRow = snapshot.data[0]
    const secondRow = snapshot.data[1]
    const fourthRow = snapshot.data[2]

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [{
        op: 'splice',
        path: [],
        index: 2,
        deleteCount: 0,
        values: [{ id: 3, title: 'Third' }],
      }],
      version: 2,
    })

    expect(patched.data).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
      { id: 3, title: 'Third' },
      { id: 4, title: 'Fourth' },
    ])
    expect(patched.data[0]).toBe(firstRow)
    expect(patched.data[1]).toBe(secondRow)
    expect(patched.data[3]).toBe(fourthRow)
    expect(patched.version).toBe(2)

    const deleted = realtimeClientInternals.applyWireSnapshotPatch(patched, {
      operations: [{
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 2,
        values: [],
      }],
      version: 3,
    })

    expect(deleted.data).toEqual([
      { id: 1, title: 'First' },
      { id: 4, title: 'Fourth' },
    ])
    expect(deleted.data[0]).toBe(firstRow)
    expect(deleted.data[1]).toBe(fourthRow)
    expect(deleted.version).toBe(3)

    const moved = realtimeClientInternals.applyWireSnapshotPatch(deleted, {
      operations: [{
        op: 'move',
        path: [],
        from: 1,
        to: 0,
      }],
      version: 4,
    })

    expect(moved.data).toEqual([
      { id: 4, title: 'Fourth' },
      { id: 1, title: 'First' },
    ])
    expect(moved.data[0]).toBe(fourthRow)
    expect(moved.data[1]).toBe(firstRow)
    expect(moved.version).toBe(4)

    const thirdRow = { id: 3, title: 'Third' }
    const slided = realtimeClientInternals.applyWireSnapshotPatch({
      name: 'posts.list',
      data: [firstRow, secondRow],
      dependencies: ['table:posts'],
      version: 1,
    }, {
      operations: [
        {
          op: 'splice',
          path: [],
          index: 0,
          deleteCount: 1,
          values: [],
        },
        {
          op: 'splice',
          path: [],
          index: 1,
          deleteCount: 0,
          values: [thirdRow],
        },
      ],
      version: 2,
    })

    expect(slided.data).toEqual([
      { id: 2, title: 'Second' },
      { id: 3, title: 'Third' },
    ])
    expect(slided.data[0]).toBe(secondRow)
    expect(slided.data[1]).toBe(thirdRow)
    expect(slided.version).toBe(2)
  })

  it('applies paginated wrapper row and meta patches with structural sharing', () => {
    const firstRow: Post = { id: 1, title: 'First' }
    const secondRow: Post = { id: 2, title: 'Second' }
    const thirdRow: Post = { id: 3, title: 'Third' }
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly data: readonly Post[]
      readonly meta: {
        readonly currentPage: number
        readonly hasMorePages: boolean
        readonly total: number
      }
    }> = {
      name: 'posts.paginated',
      data: {
        data: [firstRow, secondRow],
        meta: {
          currentPage: 1,
          hasMorePages: true,
          total: 3,
        },
      },
      dependencies: ['table:posts'],
      version: 1,
    }
    const initialWrapper = snapshot.data
    const initialRows = snapshot.data.data
    const initialMeta = snapshot.data.meta

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'splice',
          path: ['data'],
          index: 0,
          deleteCount: 1,
          values: [],
        },
        {
          op: 'splice',
          path: ['data'],
          index: 1,
          deleteCount: 0,
          values: [thirdRow],
        },
        {
          op: 'merge',
          path: ['meta'],
          fields: {
            hasMorePages: false,
            total: 2,
          },
        },
      ],
      version: 2,
    })

    expect(patched.data).not.toBe(initialWrapper)
    expect(patched.data.data).not.toBe(initialRows)
    expect(patched.data.meta).not.toBe(initialMeta)
    expect(patched.data.data[0]).toBe(secondRow)
    expect(patched.data.data[1]).toBe(thirdRow)
    expect(patched.data.meta).toEqual({
      currentPage: 1,
      hasMorePages: false,
      total: 2,
    })
  })

  it('keeps no-op splice and move patches structurally shared without notifying listeners', () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
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
      subscribe() {
        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.list', {}, transport)

    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })
    store.setSnapshot({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
      dependencies: ['table:posts'],
      version: 1,
    })
    const currentData = store.snapshot?.data

    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [
        {
          op: 'splice',
          path: [],
          index: 1,
          deleteCount: 0,
          values: [],
        },
        {
          op: 'move',
          path: [],
          from: 0,
          to: 0,
        },
      ],
      version: 2,
    }))

    expect(observedSnapshots).toHaveLength(1)
    expect(store.snapshot?.data).toBe(currentData)
    expect(store.snapshot?.version).toBe(2)
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

  it('evicts inactive query stores from the client cache after the last listener unsubscribes', () => {
    const calls: string[] = []
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })
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

    configureRealtimeClientTransport(transport)
    const store = getRealtimeQueryStore(listPosts, { tag: 'a' } as never)
    const sameStore = getRealtimeQueryStore(listPosts, { tag: 'a' } as never)
    const unsubscribe = store.subscribe(() => {})
    store.connect()

    expect(sameStore).toBe(store)
    expect(realtimeClientInternals.getRealtimeClientState().stores.size).toBe(1)

    unsubscribe()

    expect(calls).toEqual(['subscribe:posts.list', 'unsubscribe:posts.list'])
    expect(realtimeClientInternals.getRealtimeClientState().stores.size).toBe(0)

    const nextStore = getRealtimeQueryStore(listPosts, { tag: 'a' } as never)
    expect(nextStore).not.toBe(store)
    expect(realtimeClientInternals.getRealtimeClientState().stores.size).toBe(1)
  })

  it('disconnects active query stores when the client runtime resets', () => {
    const calls: string[] = []
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })
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

    configureRealtimeClientTransport(transport)
    const store = getRealtimeQueryStore(listPosts, {})
    const first = store.subscribe(() => {})
    const second = store.subscribe(() => {})
    store.connect()

    resetRealtimeClientRuntime()
    store.connect()
    const staleUnsubscribe = store.subscribe(() => {})
    staleUnsubscribe()
    first()
    second()

    expect(calls).toEqual([
      'subscribe:posts.list',
      'unsubscribe:posts.list',
    ])
    expect(realtimeClientInternals.getRealtimeClientState().stores.size).toBe(0)
  })

  it('handles query store cleanup before connect and transport startup failures', async () => {
    const calls: string[] = []
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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

    let subscribeAttempts = 0
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
        subscribeAttempts += 1
        onError(new Error('subscribe failed'))

        return () => {
          calls.push('failed unsubscribe')
        }
      },
    } satisfies RealtimeClientTransport
    const failingStore = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.fail', {}, failingTransport)
    const unsubscribeFailing = failingStore.subscribe(() => {})
    failingStore.connect()
    failingStore.connect()
    await Promise.resolve()
    await Promise.resolve()
    unsubscribeFailing()
    const unsubscribeAfterReset = failingStore.subscribe(() => {})
    unsubscribeAfterReset()

    expect(subscribeAttempts).toBe(2)
    expect(calls).toEqual(['failed unsubscribe'])
    expect(consoleWarn).toHaveBeenCalledWith('[@holo-js/realtime] query failed')
    expect(consoleWarn).toHaveBeenCalledWith('[@holo-js/realtime] subscribe failed')
  })

  it('ignores late query and subscription startup errors after a query store is inactive', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleWarn.mockClear()
    let rejectQuery: ((error: unknown) => void) | undefined
    let emitSubscribeError: ((error: unknown) => void) | undefined
    const transport = {
      async query<TResult>() {
        return await new Promise<RealtimeSubscriptionSnapshot<TResult>>((_resolve, reject) => {
          rejectQuery = reject
        })
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
        emitSubscribeError = onError

        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.late', {}, transport)
    const unsubscribe = store.subscribe(() => {})

    store.connect()
    unsubscribe()
    rejectQuery?.(new Error('late query failed'))
    emitSubscribeError?.(new Error('late subscribe failed'))
    await Promise.resolve()

    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('ignores stale store snapshots while accepting the current startup result', async () => {
    const observedSnapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const subscribeListeners: Array<(snapshot: RealtimeSubscriptionSnapshot<readonly Post[]>) => void> = []
    let resolveQuery: ((snapshot: RealtimeSubscriptionSnapshot<readonly Post[]>) => void) | undefined
    const transport = {
      async query<TResult>(name: string) {
        return await new Promise<RealtimeSubscriptionSnapshot<TResult>>((resolve) => {
          resolveQuery = snapshot => resolve(snapshot as RealtimeSubscriptionSnapshot<TResult>)
        })
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
        listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
      ) {
        subscribeListeners.push(listener as (snapshot: RealtimeSubscriptionSnapshot<readonly Post[]>) => void)

        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.lifecycle', {}, transport)
    store.subscribe(() => {
      if (store.snapshot) {
        observedSnapshots.push(store.snapshot)
      }
    })

    store.setSnapshot({
      name: 'posts.lifecycle',
      data: [{ id: 1, title: 'Disposed' }],
      dependencies: [],
      version: 1,
    })
    store.dispose()
    store.setSnapshot({
      name: 'posts.lifecycle',
      data: [{ id: 2, title: 'Ignored' }],
      dependencies: [],
      version: 2,
    })

    expect(observedSnapshots.map(snapshot => snapshot.data)).toEqual([
      [{ id: 1, title: 'Disposed' }],
    ])

    const liveStore = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.lifecycle-live', {}, transport)
    liveStore.subscribe(() => {
      if (liveStore.snapshot) {
        observedSnapshots.push(liveStore.snapshot)
      }
    })
    liveStore.connect()
    liveStore.disconnect()
    liveStore.connect()
    subscribeListeners[0]?.({
      name: 'posts.lifecycle-live',
      data: [{ id: 3, title: 'Stale live' }],
      dependencies: [],
      version: 3,
    })
    resolveQuery?.({
      name: 'posts.lifecycle-live',
      data: [{ id: 4, title: 'Initial query' }],
      dependencies: [],
      version: 4,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(observedSnapshots.map(snapshot => snapshot.data)).toEqual([
      [{ id: 1, title: 'Disposed' }],
      [{ id: 4, title: 'Initial query' }],
    ])
  })

  it('does not escalate unavailable live transport errors to the framework runtime', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handleError = vi.fn()
    const transport = {
      async query() {
        throw new Error(realtimeClientInternals.unavailableTransportMessage)
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
        onError(new Error(realtimeClientInternals.unavailableTransportMessage))

        return () => {}
      },
    } satisfies RealtimeClientTransport
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly Post[]>('posts.live', {}, transport)

    configureRealtimeClientRuntime({ handleError })
    store.subscribe(() => {})
    store.connect()
    await Promise.resolve()

    expect(handleError).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith(`[@holo-js/realtime] ${realtimeClientInternals.unavailableTransportMessage}`)
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
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 2,
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Ignored',
          }],
        },
      }),
    })
    expect(snapshots).toEqual([])
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
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Unversioned patch',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 5.5,
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Fractional version patch',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          dependencies: ['table:posts', 'table:comments'],
          version: 3,
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Patched Second',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          dependencies: ['table:posts', 'table:comments'],
          version: 4,
          operations: [{
            op: 'splice',
            path: [],
            index: 1,
            deleteCount: 0,
            values: [{ id: 3, title: 'Third' }],
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          dependencies: ['table:posts', 'table:comments', 'table:likes'],
          version: 5,
          operations: [],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 6,
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Retitled Second',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 6,
          operations: [{
            op: 'merge',
            path: [0],
            fields: {
              title: 'Patched Second',
            },
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 6,
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Same-version stale patch',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:snapshot',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        snapshot: {
          name: 'posts.list',
          data: [{ id: 9, title: 'Stale snapshot' }],
          dependencies: ['table:posts'],
          version: 3,
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          dependencies: ['table:posts'],
          version: 3,
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Stale patch',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 6,
          operations: [{
            op: 'replace',
            path: [0.5, 'title'],
            value: 'Fractional path',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 6,
          operations: [{
            op: 'replace',
            path: [-1, 'title'],
            value: 'Negative path',
          }],
        },
      }),
    })
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 6,
          operations: [{
            op: 'replace',
            path: ['__proto__', 'polluted'],
            value: true,
          }],
        },
      }),
    })
    const unsafeMergeFields = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    emitMessage({
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 6,
          operations: [{
            op: 'merge',
            path: [0],
            fields: unsafeMergeFields,
          }],
        },
      }),
    })

    expect(snapshots).toEqual([
      {
        name: 'posts.list',
        data: [{ id: 2, title: 'Second' }],
        dependencies: ['table:posts'],
        version: 2,
      },
      {
        name: 'posts.list',
        data: [{ id: 2, title: 'Patched Second' }],
        dependencies: ['table:posts', 'table:comments'],
        version: 3,
      },
      {
        name: 'posts.list',
        data: [
          { id: 2, title: 'Patched Second' },
          { id: 3, title: 'Third' },
        ],
        dependencies: ['table:posts', 'table:comments'],
        version: 4,
      },
      {
        name: 'posts.list',
        data: [
          { id: 2, title: 'Patched Second' },
          { id: 3, title: 'Third' },
        ],
        dependencies: ['table:posts', 'table:comments', 'table:likes'],
        version: 5,
      },
      {
        name: 'posts.list',
        data: [
          { id: 2, title: 'Retitled Second' },
          { id: 3, title: 'Third' },
        ],
        dependencies: ['table:posts', 'table:comments', 'table:likes'],
        version: 6,
      },
    ])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

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

  it('recreates structured realtime authorization errors from websocket responses', async () => {
    const sentFrames: string[] = []
    const listeners = new Map<string, Set<(event?: { readonly data: unknown }) => void>>()

    class TestWebSocket {
      readonly readyState = 1

      constructor(_url: string) {}

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
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      key: 'app-key',
      host: '127.0.0.1',
      port: 8080,
      path: '/app',
      scheme: 'http',
    })))
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: 'localhost',
    })

    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const mutationPromise = transport.mutate<Post>('posts.update', { id: 1 })
    await vi.waitUntil(() => sentFrames.length === 1)
    const mutationFrame = JSON.parse(sentFrames[0]!) as { data: { id: string } }
    emitMessage({
      event: 'holo:realtime:error',
      data: JSON.stringify({
        id: mutationFrame.data.id,
        message: 'Only the author, editors, or admins can update posts.',
        name: 'AuthorizationError',
        kind: 'authorization',
        status: 403,
        code: 'posts.update.denied',
      }),
    })

    await expect(mutationPromise).rejects.toMatchObject({
      name: 'AuthorizationError',
      message: 'Only the author, editors, or admins can update posts.',
      kind: 'authorization',
      status: 403,
      code: 'posts.update.denied',
    })
  })

  it('drops broadcast websocket subscription callbacks after socket close', async () => {
    const sentFrames: string[] = []
    const listeners = new Map<string, Set<(event?: { readonly data: unknown }) => void>>()

    class TestWebSocket {
      readonly readyState = 1

      constructor(_url: string) {}

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

    const emit = (event: 'close' | 'message', payload?: Record<string, unknown>) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(event === 'message' ? { data: JSON.stringify(payload ?? {}) } : undefined)
      }
    }

    vi.stubGlobal('WebSocket', TestWebSocket)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      key: 'app-key',
      host: '127.0.0.1',
      port: 8080,
      path: '/app',
      scheme: 'http',
    })))
    vi.stubGlobal('location', {
      protocol: 'http:',
      hostname: 'localhost',
    })

    const snapshots: Array<RealtimeSubscriptionSnapshot<readonly Post[]>> = []
    const errors: string[] = []
    const transport = realtimeClientInternals.createBroadcastRealtimeTransport()
    const unsubscribe = transport.subscribe<readonly Post[]>(
      'posts.list',
      {},
      snapshot => snapshots.push(snapshot),
      error => errors.push(error instanceof Error ? error.message : String(error)),
    )
    await vi.waitUntil(() => sentFrames.length === 1)
    const subscribeFrame = JSON.parse(sentFrames[0]!) as { data: { id: string } }

    emit('message', {
      event: 'holo:realtime:snapshot',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        snapshot: {
          name: 'posts.list',
          data: [{ id: 1, title: 'First' }],
          dependencies: ['table:posts'],
          version: 1,
        },
      }),
    })
    emit('close')
    emit('message', {
      event: 'holo:realtime:error',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        message: 'stale error',
      }),
    })
    emit('message', {
      event: 'holo:realtime:patch',
      data: JSON.stringify({
        id: subscribeFrame.data.id,
        patch: {
          version: 2,
          operations: [{
            op: 'replace',
            path: [0, 'title'],
            value: 'Stale patch',
          }],
        },
      }),
    })
    unsubscribe()

    expect(snapshots).toEqual([{
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: ['table:posts'],
      version: 1,
    }])
    expect(errors).toEqual([realtimeClientInternals.unavailableTransportMessage])
    expect(sentFrames).toHaveLength(1)
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

  it('observes ignored public mutation rejections while preserving awaitable failures', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handleError = vi.fn()
    const denied = Object.assign(new Error('Only the author, editors, or admins can update posts.'), {
      name: 'AuthorizationError',
      kind: 'authorization',
      status: 403,
      code: 'posts.update.denied',
    })
    const transport: RealtimeClientTransport = {
      async query() {
        throw new Error('query should not run')
      },
      async mutate() {
        throw denied
      },
      subscribe() {
        return () => {}
      },
    }
    const renamePost = mutation({
      name: 'posts.rename',
      access: 'public',
      handler: async () => ({ ok: true }),
    })

    configureRealtimeClientTransport(transport)
    configureRealtimeClientRuntime({ handleError })
    void renamePost({})
    await Promise.resolve()
    await Promise.resolve()

    await expect(renamePost({})).rejects.toBe(denied)
    expect(consoleWarn).toHaveBeenCalledWith('[@holo-js/realtime] Only the author, editors, or admins can update posts.')
    expect(handleError).toHaveBeenCalledWith(denied)
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
