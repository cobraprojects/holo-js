import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  query,
  type RealtimeAuthRequestAccessors,
  type RealtimeQueryDefinitionMetadata,
  type RealtimeResultFor,
  type RealtimeRuntimeBindings,
} from '../src'
import {
  deliverPatchedQueryData,
  deliverRefreshData,
  deliverRefreshError,
} from '../src/runtime/delivery'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
} from '../src/runtime/dependencies'
import {
  handleBatchedDatabaseInvalidation,
  handleDatabaseInvalidation,
  scheduleSubscriptionRefresh,
} from '../src/runtime/invalidation'
import { runWithExecutionOptions } from '../src/runtime/execution'
import { configureRealtimeRuntime, resetRealtimeRuntime } from '../src/runtime/lifecycle'
import { tryPatchQueryEntry } from '../src/runtime/patch-delivery'
import {
  deleteSubscription,
  detachDatabaseSubscriptionIfIdle,
  resolveQueryEntry,
} from '../src/runtime/query-entry'
import { createQueryPatchTargets } from '../src/runtime/query-patch-targets'
import {
  addQueryEntryDependencies,
  addQueryEntryInvalidationIndexes,
} from '../src/runtime/subscription-index'
import { getRuntimeState } from '../src/runtime/state'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'
import type { QueryPatchTarget } from '../src/runtime/query-state'
import type {
  ActiveQueryEntry,
  ActiveSubscription,
  BackfillCache,
  InternalRealtimeExecutionResult,
  RealtimeSubscriptionPatch,
  RealtimeSubscriptionPatchOperation,
  RefreshDelivery,
} from '../src/runtime/state'
import { createFakeDatabase } from './helpers/fake-database'

const deliveryQuery = query({
  name: 'runtime.delivery',
  access: 'public',
  handler: () => {
    if (deliveryQueryError) {
      throw deliveryQueryError
    }

    return { count: 1 }
  },
})

let deliveryQueryError: Error | undefined

type DeliveryDefinition = typeof deliveryQuery
type DeliveryResult = RealtimeResultFor<DeliveryDefinition>
type DeliveryEntry = ActiveQueryEntry<DeliveryDefinition>
type DeliverySubscription = ActiveSubscription<DeliveryDefinition>

function createSubscription(
  options: DeliverySubscription['options'] = {},
): DeliverySubscription {
  return {
    current: {
      data: { count: 0 },
      dependencies: ['db:main:todos'],
      name: deliveryQuery.name,
      version: 1,
    },
    id: `subscription-${Math.random()}`,
    options,
    refreshKey: 'runtime.delivery:{}',
  }
}

function createEntry(overrides: Partial<DeliveryEntry> = {}): DeliveryEntry {
  const subscriberRefs = new Set<DeliverySubscription>()
  return {
    args: {},
    current: {
      data: { count: 1 },
      dependencies: ['db:main:todos'],
      name: deliveryQuery.name,
      version: 1,
    },
    definition: deliveryQuery,
    dependencies: ['db:main:todos'],
    patchFallbackSubscriberRefs: new Set<DeliverySubscription>(),
    patchSubscriberRefs: new Set<DeliverySubscription>(),
    patchTargets: [],
    predicateDependencies: new Map(),
    queries: [],
    refreshKey: 'runtime.delivery:{}',
    resultHash: '{"count":1}',
    resultHashDirty: false,
    snapshotSubscriberRefs: new Set<DeliverySubscription>(),
    subscriberRefs,
    subscribers: new Set<string>(),
    tableDependencies: ['db:main:todos'],
    version: 1,
    ...overrides,
  }
}

function createDelivery(
  data: DeliveryResult,
  overrides: Partial<RefreshDelivery<DeliveryDefinition>> = {},
): RefreshDelivery<DeliveryDefinition> {
  const result = Object.freeze({
    data,
    dependencies: ['db:main:todos'],
    name: deliveryQuery.name,
    queries: [],
  }) satisfies InternalRealtimeExecutionResult<DeliveryResult>

  return {
    result,
    resultHashDirty: true,
    ...overrides,
  }
}

function createObservation(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    orderBy: [],
    patchable: true,
    predicates: [{ column: 'id', operator: '=', value: 1 }],
    tableName: 'posts',
    ...overrides,
  }
}

function createBackfills(mutations: readonly DatabaseMutationEvent[]): BackfillCache {
  return {
    aggregateSql: new Map(),
    aggregates: new Map(),
    entries: [],
    mutationMetadata: new WeakMap(),
    mutations: new Map([
      [createMutationIndexKey('main', 'posts'), mutations],
    ]),
    paginationCounts: new Map(),
    rows: new Map(),
  }
}

function createStalePathTarget(target: QueryPatchTarget, path: readonly string[]): QueryPatchTarget {
  return Object.freeze({
    ...target,
    resultPath: path,
    resultPathKey: JSON.stringify(path),
  })
}

function encodeDependencyValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value))
}

describe('@holo-js/realtime runtime delivery', () => {
  afterEach(() => {
    deliveryQueryError = undefined
    resetRealtimeRuntime()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('delivers compact patches to patch subscribers and snapshots to fallback subscribers', async () => {
    const entry = createEntry()
    const patches: RealtimeSubscriptionPatch[] = []
    const fallbackSnapshots: DeliveryResult[] = []
    const patchSubscriber = createSubscription({
      onPatch: async patch => {
        patches.push(patch)
      },
    })
    const secondPatchSubscriber = createSubscription({
      onPatch: async patch => {
        patches.push(patch)
      },
    })
    const fallbackSubscriber = createSubscription({
      onData: async snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
    })

    entry.subscriberRefs.add(patchSubscriber)
    entry.subscriberRefs.add(secondPatchSubscriber)
    entry.subscriberRefs.add(fallbackSubscriber)
    entry.patchSubscriberRefs.add(patchSubscriber)
    entry.patchSubscriberRefs.add(secondPatchSubscriber)
    entry.patchFallbackSubscriberRefs.add(fallbackSubscriber)

    const operations: readonly RealtimeSubscriptionPatchOperation[] = [
      { op: 'replace', path: ['count'], value: 2 },
    ]

    await deliverPatchedQueryData(entry, { count: 2 }, [], operations)

    expect(entry.version).toBe(2)
    expect(entry.current?.data).toEqual({ count: 2 })
    expect(patches).toEqual([
      { operations, version: 2 },
      { operations, version: 2 },
    ])
    expect(fallbackSnapshots).toEqual([{ count: 2 }])
  })

  it('keeps delivering snapshots when subscriber callbacks fail', async () => {
    const entry = createEntry()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const snapshots: DeliveryResult[] = []
    const throwingSubscriber = createSubscription({
      onData: () => {
        throw new Error('sync onData failure')
      },
    })
    const rejectingSubscriber = createSubscription({
      onData: async () => {
        throw new Error('async onData failure')
      },
    })
    const resolvingSubscriber = createSubscription({
      onData: async snapshot => {
        snapshots.push(snapshot.data)
      },
    })

    entry.snapshotSubscriberRefs.add(throwingSubscriber)
    entry.snapshotSubscriberRefs.add(rejectingSubscriber)
    entry.snapshotSubscriberRefs.add(resolvingSubscriber)

    await deliverRefreshData(entry, createDelivery({ count: 3 }))

    expect(snapshots).toEqual([{ count: 3 }])
    expect(consoleError).toHaveBeenCalledTimes(2)
    expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
      '[@holo-js/realtime] Realtime subscription onData callback failed.',
      '[@holo-js/realtime] Realtime subscription onData callback failed.',
    ])
  })

  it('delivers refresh data when no result hash is provided', async () => {
    const entry = createEntry()
    const snapshots: DeliveryResult[] = []
    entry.snapshotSubscriberRefs.add(createSubscription({
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    }))

    await deliverRefreshData(entry, {
      result: Object.freeze({
        data: { count: 4 },
        dependencies: ['db:main:todos'],
        name: deliveryQuery.name,
        queries: [],
      }) satisfies InternalRealtimeExecutionResult<DeliveryResult>,
    })

    expect(entry.current?.data).toEqual({ count: 4 })
    expect(entry.version).toBe(2)
    expect(snapshots).toEqual([{ count: 4 }])
  })

  it('skips delivery after recomputing a dirty unchanged result hash', async () => {
    const entry = createEntry({
      resultHashDirty: true,
    })
    const snapshots: DeliveryResult[] = []
    entry.snapshotSubscriberRefs.add(createSubscription({
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    }))

    await deliverRefreshData(entry, createDelivery(
      { count: 1 },
      {
        resultHash: '{"count":1}',
        resultHashDirty: false,
      },
    ))

    expect(entry.resultHashDirty).toBe(false)
    expect(entry.version).toBe(1)
    expect(snapshots).toEqual([])
  })

  it('delivers hashed refresh data when dirty entries have no current snapshot', async () => {
    const entry = createEntry({
      current: undefined,
      resultHash: '{"count":0}',
      resultHashDirty: true,
    })

    await deliverRefreshData(entry, createDelivery(
      { count: 5 },
      {
        resultHash: '{"count":5}',
        resultHashDirty: false,
      },
    ))

    expect(entry.current?.data).toEqual({ count: 5 })
    expect(entry.resultHashDirty).toBe(false)
    expect(entry.version).toBe(2)
  })

  it('includes changed dependencies in delivered patches', async () => {
    const entry = createEntry()
    const patches: RealtimeSubscriptionPatch[] = []
    const patchSubscriber = createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    })
    entry.subscriberRefs.add(patchSubscriber)
    entry.patchSubscriberRefs.add(patchSubscriber)

    await deliverRefreshData(entry, {
      patchOperations: [
        { op: 'replace', path: ['count'], value: 6 },
      ],
      result: Object.freeze({
        data: { count: 6 },
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        queries: [],
      }) satisfies InternalRealtimeExecutionResult<DeliveryResult>,
      resultHashDirty: true,
    })

    expect(entry.current?.dependencies).toEqual(['db:main:posts'])
    expect(patches).toEqual([
      {
        dependencies: ['db:main:posts'],
        operations: [{ op: 'replace', path: ['count'], value: 6 }],
        version: 2,
      },
    ])
  })

  it('delivers dependency-only patches through the patch channel', async () => {
    const entry = createEntry()
    const patches: RealtimeSubscriptionPatch[] = []
    const fallbackSnapshots: DeliveryResult[] = []
    const patchSubscriber = createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    })
    const fallbackSubscriber = createSubscription({
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
    })
    entry.subscriberRefs.add(patchSubscriber)
    entry.subscriberRefs.add(fallbackSubscriber)
    entry.patchSubscriberRefs.add(patchSubscriber)
    entry.patchFallbackSubscriberRefs.add(fallbackSubscriber)

    await deliverRefreshData(entry, {
      patchOperations: [],
      result: Object.freeze({
        data: { count: 1 },
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        queries: [],
      }) satisfies InternalRealtimeExecutionResult<DeliveryResult>,
      resultHashDirty: true,
    })

    expect(entry.current?.dependencies).toEqual(['db:main:posts'])
    expect(entry.version).toBe(2)
    expect(patches).toEqual([
      {
        dependencies: ['db:main:posts'],
        operations: [],
        version: 2,
      },
    ])
    expect(fallbackSnapshots).toEqual([{ count: 1 }])
  })

  it('skips empty patch deliveries when the result data is unchanged', async () => {
    const entry = createEntry()
    const patches: RealtimeSubscriptionPatch[] = []
    const snapshots: DeliveryResult[] = []
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))
    entry.snapshotSubscriberRefs.add(createSubscription({
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    }))

    await deliverPatchedQueryData(entry, { count: 1 }, [], [])

    expect(entry.version).toBe(1)
    expect(entry.current?.data).toEqual({ count: 1 })
    expect(entry.resultHashDirty).toBe(false)
    expect(patches).toEqual([])
    expect(snapshots).toEqual([])
  })

  it('delivers empty-operation patched data when the result data changed', async () => {
    const entry = createEntry()
    const snapshots: DeliveryResult[] = []
    entry.snapshotSubscriberRefs.add(createSubscription({
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    }))

    await deliverPatchedQueryData(entry, { count: 2 }, [], [])

    expect(entry.version).toBe(2)
    expect(entry.current?.data).toEqual({ count: 2 })
    expect(snapshots).toEqual([{ count: 2 }])
  })

  it('reports refresh errors to every available error handler', async () => {
    const entry = createEntry()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reportedErrors: unknown[] = []
    const refreshError = new Error('refresh failed')
    const subscribers = [
      createSubscription(),
      createSubscription({
        onError: () => {
          throw new Error('sync onError failure')
        },
      }),
      createSubscription({
        onError: async () => {
          throw new Error('async onError failure')
        },
      }),
      createSubscription({
        onError: async error => {
          reportedErrors.push(error)
        },
      }),
    ]

    for (const subscriber of subscribers) {
      entry.subscriberRefs.add(subscriber)
    }

    await deliverRefreshError(entry, refreshError)

    expect(reportedErrors).toEqual([refreshError])
    expect(consoleError).toHaveBeenCalledTimes(2)
    expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
      '[@holo-js/realtime] Realtime subscription onError callback failed.',
      '[@holo-js/realtime] Realtime subscription onError callback failed.',
    ])
  })

  it('awaits a single asynchronous refresh error handler', async () => {
    const entry = createEntry()
    const reportedErrors: unknown[] = []
    const refreshError = new Error('refresh failed')
    entry.subscriberRefs.add(createSubscription({
      onError: async error => {
        reportedErrors.push(error)
      },
    }))

    await deliverRefreshError(entry, refreshError)

    expect(reportedErrors).toEqual([refreshError])
  })

  it('reports patch and fallback callback failures without aborting patch delivery', async () => {
    const entry = createEntry()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const patchSubscriber = createSubscription({
      onPatch: () => {
        throw new Error('patch failure')
      },
    })
    const fallbackSubscriber = createSubscription({
      onData: () => {
        throw new Error('fallback failure')
      },
    })

    entry.patchSubscriberRefs.add(patchSubscriber)
    entry.patchFallbackSubscriberRefs.add(fallbackSubscriber)

    await deliverPatchedQueryData(entry, { count: 4 }, [], [
      { op: 'replace', path: ['count'], value: 4 },
    ])

    expect(entry.current?.data).toEqual({ count: 4 })
    expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
      '[@holo-js/realtime] Realtime subscription onPatch callback failed.',
      '[@holo-js/realtime] Realtime subscription onData callback failed.',
    ])
  })

  it('does not patch entries that are missing current data or already refreshing', async () => {
    const missingCurrentEntry = createEntry({
      current: undefined,
    })

    await expect(tryPatchQueryEntry(missingCurrentEntry, createBackfills([]))).resolves.toBe(false)

    const refreshingEntry = createEntry()
    getRuntimeState().refreshes.set(refreshingEntry.refreshKey, {
      pending: false,
      running: Promise.resolve(),
    })

    await expect(tryPatchQueryEntry(refreshingEntry, createBackfills([]))).resolves.toBe(false)
  })

  it('runs callbacks through request auth accessors when bindings provide a runner', async () => {
    const calls: string[] = []
    const authRequest = {
      appendResponseCookie: async () => {},
      getCookie: async () => undefined,
      getHeader: async () => undefined,
      redirectResponse: async () => {},
    } satisfies RealtimeAuthRequestAccessors
    const bindings = {
      runWithAuthRequestAccessors: async (accessors, callback) => {
        expect(accessors).toBe(authRequest)
        calls.push('runner')
        const value = await callback()
        calls.push('runner-done')
        return value
      },
    } satisfies RealtimeRuntimeBindings

    await expect(runWithExecutionOptions(bindings, { authRequest }, async () => {
      calls.push('callback')
      return 'result'
    })).resolves.toBe('result')
    expect(calls).toEqual(['runner', 'callback', 'runner-done'])
  })

  it('removes query entries when the initial query rejects', async () => {
    const failingQuery = query({
      name: 'runtime.delivery.failure',
      access: 'public',
      handler: () => {
        throw new Error('initial failure')
      },
    })
    const refreshKey = 'runtime.delivery.failure:{}'

    await expect(resolveQueryEntry(failingQuery, {}, undefined, refreshKey)).rejects.toThrow()
    expect(getRuntimeState().queryEntries.has(refreshKey)).toBe(false)
  })

  it('patches query entries without creating operations when there are no patch subscribers', async () => {
    const data = { title: 'Old' }
    const observation = createObservation({
      resultPath: ['title'],
      scalarColumn: 'title',
    })
    const snapshots: unknown[] = []
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([observation], data),
      queries: [observation],
    })
    entry.snapshotSubscriberRefs.add(createSubscription({
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: { id: 1, title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({ title: 'New' })
    expect(entry.version).toBe(2)
    expect(snapshots).toEqual([{ title: 'New' }])
  })

  it('delivers a single patch when its target disappears before delivery', async () => {
    const data = { title: 'Old' }
    const observation = createObservation({
      resultPath: ['title'],
      scalarColumn: 'title',
    })
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([observation], data),
      queries: [observation],
    })
    const values = {
      get title(): string {
        delete entry.patchTargets[0]
        return 'New'
      },
    }
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values,
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({ title: 'New' })
    expect(entry.patchTargets[0]).toBeUndefined()
    expect(patches).toEqual([
      {
        operations: [
          { op: 'replace', path: ['title'], value: 'New' },
        ],
        version: 2,
      },
    ])
  })

  it('delivers two patches when both targets disappear before delivery', async () => {
    const data = { a: 'old-a', b: 'old-b' }
    const observations = [
      createObservation({
        resultPath: ['a'],
        scalarColumn: 'a',
      }),
      createObservation({
        resultPath: ['b'],
        scalarColumn: 'b',
      }),
    ]
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, data),
      queries: observations,
    })
    const values = {
      get a(): string {
        delete entry.patchTargets[0]
        return 'new-a'
      },
      get b(): string {
        delete entry.patchTargets[1]
        return 'new-b'
      },
    }
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values,
        valueKeys: ['a', 'b'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      a: 'new-a',
      b: 'new-b',
    })
    expect(entry.patchTargets[0]).toBeUndefined()
    expect(entry.patchTargets[1]).toBeUndefined()
    expect(patches).toEqual([
      {
        operations: [
          {
            fields: {
              a: 'new-a',
              b: 'new-b',
            },
            op: 'merge',
            path: [],
          },
        ],
        version: 2,
      },
    ])
  })

  it('compacts two compatible patches for the same result path into one replace operation', async () => {
    const data = { value: 'old' }
    const observations = [
      createObservation({
        resultPath: ['value'],
        scalarColumn: 'first',
      }),
      createObservation({
        resultPath: ['value'],
        scalarColumn: 'second',
      }),
    ]
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, data),
      queries: observations,
    })
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: {
          first: 'new',
          second: 'new',
        },
        valueKeys: ['first', 'second'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({ value: 'new' })
    expect(patches).toEqual([
      {
        operations: [
          { op: 'replace', path: ['value'], value: 'new' },
        ],
        version: 2,
      },
    ])
  })

  it('patches root query results without rerunning the handler', async () => {
    const observation = createObservation({
      resultPath: [],
      scalarColumn: 'title',
    })
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: 'Old' as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([observation], 'Old'),
      queries: [observation],
    })
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: { id: 1, title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toBe('New')
    expect(patches).toEqual([
      {
        operations: [
          { op: 'replace', path: [], value: 'New' },
        ],
        version: 2,
      },
    ])
  })

  it('patches omitted root query paths when the target disappears before delivery', async () => {
    const observation = createObservation({
      scalarColumn: 'title',
    })
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: 'Old' as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([observation], 'Old'),
      queries: [observation],
    })
    const values = {
      get title(): string {
        delete entry.patchTargets[0]
        return 'New'
      },
    }
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values,
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toBe('New')
    expect(entry.patchTargets[0]).toBeUndefined()
    expect(patches).toEqual([
      {
        operations: [
          { op: 'replace', path: [], value: 'New' },
        ],
        version: 2,
      },
    ])
  })

  it('compacts two omitted root query paths after both targets disappear', async () => {
    const observations = [
      createObservation({
        scalarColumn: 'first',
      }),
      createObservation({
        scalarColumn: 'second',
      }),
    ]
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: 'Old' as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, 'Old'),
      queries: observations,
    })
    const values = {
      get first(): string {
        delete entry.patchTargets[0]
        return 'New'
      },
      get second(): string {
        delete entry.patchTargets[1]
        return 'New'
      },
    }
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values,
        valueKeys: ['first', 'second'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toBe('New')
    expect(entry.patchTargets[0]).toBeUndefined()
    expect(entry.patchTargets[1]).toBeUndefined()
    expect(patches).toEqual([
      {
        operations: [
          { op: 'replace', path: [], value: 'New' },
        ],
        version: 2,
      },
    ])
  })

  it('falls back from top-level replacement when one patched path cannot apply to the current data', async () => {
    const data = {
      status: 'open',
      title: 'Old',
    }
    const titleObservation = createObservation({
      resultPath: ['title'],
      scalarColumn: 'title',
    })
    const numericObservation = createObservation({
      resultPath: [0],
      scalarColumn: 'priority',
    })
    const statusObservation = createObservation({
      resultPath: ['status'],
      scalarColumn: 'status',
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([
        titleObservation,
        numericObservation,
        statusObservation,
      ], data),
      queries: [
        titleObservation,
        numericObservation,
        statusObservation,
      ],
    })

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: {
          priority: 2,
          status: 'closed',
          title: 'New',
        },
        valueKeys: ['title', 'priority', 'status'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      status: 'closed',
      title: 'New',
    })
  })

  it('rejects patches when the entry version changes while patching', async () => {
    const data = { title: 'Old' }
    const observation = createObservation({
      resultPath: ['title'],
      scalarColumn: 'title',
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([observation], data),
      queries: [observation],
    })
    const values = Object.defineProperty({}, 'title', {
      enumerable: true,
      get: () => {
        entry.version += 1
        return 'New'
      },
    }) as Readonly<Record<string, unknown>>

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values,
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(false)

    expect(entry.current?.data).toEqual({ title: 'Old' })
  })

  it('skips unpatchable mutation-value targets when a scalar target covers the changed column', async () => {
    const data = {
      post: { id: 1, title: 'Old' },
      title: 'Old',
    }
    const unpatchableObservation = createObservation({
      patchable: false,
      resultPath: ['post'],
    })
    const scalarObservation = createObservation({
      resultPath: ['title'],
      scalarColumn: 'title',
    })
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([unpatchableObservation, scalarObservation], data),
      queries: [unpatchableObservation, scalarObservation],
    })
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: { id: 1, title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      post: { id: 1, title: 'Old' },
      title: 'New',
    })
    expect(patches).toEqual([
      {
        operations: [
          { op: 'replace', path: ['title'], value: 'New' },
        ],
        version: 2,
      },
    ])
  })

  it('skips unpatchable mutation-value targets when a projected rows target covers the changed column', async () => {
    const data = {
      post: { id: 1, title: 'Old' },
      projection: [{ id: 1, title: 'Old' }],
    }
    const unpatchableObservation = createObservation({
      patchable: false,
      resultPath: ['post'],
    })
    const projectedObservation = createObservation({
      resultPath: ['projection'],
      selections: [
        { column: 'id', resultKey: 'id' },
        { column: 'title', resultKey: 'title' },
      ],
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([unpatchableObservation, projectedObservation], data),
      queries: [unpatchableObservation, projectedObservation],
    })

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        rows: [{ id: 1, title: 'New' }],
        tableName: 'posts',
        values: { id: 1, title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      post: { id: 1, title: 'Old' },
      projection: [{ id: 1, title: 'New' }],
    })
    expect(entry.version).toBe(2)
  })

  it('skips unpatchable mutation-value targets when a scalar-list target covers the changed column', async () => {
    const data = {
      post: { id: 1, title: 'Old' },
      titles: ['Old'],
    }
    const unpatchableObservation = createObservation({
      patchable: false,
      resultPath: ['post'],
    })
    const scalarListObservation = createObservation({
      resultPath: ['titles'],
      scalarListColumn: 'title',
      scalarListRows: [{ id: 1, title: 'Old' }],
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([unpatchableObservation, scalarListObservation], data),
      queries: [unpatchableObservation, scalarListObservation],
    })

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        rows: [{ id: 1, title: 'New' }],
        tableName: 'posts',
        values: { id: 1, title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      post: { id: 1, title: 'Old' },
      titles: ['New'],
    })
    expect(entry.version).toBe(2)
  })

  it('skips unpatchable mutation-value targets when an unprojected rows target covers the changed column', async () => {
    const data = {
      post: { id: 1, title: 'Old' },
      rows: [{ id: 1, title: 'Old' }],
    }
    const unpatchableObservation = createObservation({
      patchable: false,
      resultPath: ['post'],
    })
    const rowsObservation = createObservation({
      resultPath: ['rows'],
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([unpatchableObservation, rowsObservation], data),
      queries: [unpatchableObservation, rowsObservation],
    })

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        rows: [{ id: 1, title: 'New' }],
        tableName: 'posts',
        values: { id: 1, title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      post: { id: 1, title: 'Old' },
      rows: [{ id: 1, title: 'New' }],
    })
    expect(entry.version).toBe(2)
  })

  it('keeps refreshing unpatchable targets when selected and relation targets do not cover the changed column', async () => {
    const data = {
      post: { id: 1, title: 'Old' },
      projection: [{ id: 1, summary: 'Old summary' }],
      relation: { id: 1, title: 'Old' },
    }
    const unpatchableObservation = createObservation({
      patchable: false,
      resultPath: ['post'],
    })
    const projectedObservation = createObservation({
      resultPath: ['projection'],
      selections: [
        { column: 'id', resultKey: 'id' },
        { column: 'summary', resultKey: 'summary' },
      ],
    })
    const relationObservation = createObservation({
      relation: {
        foreignKey: 'title',
        kind: 'belongsToParentKey',
        ownerKey: 'id',
        relatedConnectionName: 'main',
        relatedTableName: 'authors',
        relationKey: 'author',
      },
      resultPath: ['relation'],
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([unpatchableObservation, projectedObservation, relationObservation], data),
      queries: [unpatchableObservation, projectedObservation, relationObservation],
    })

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        rows: [{ id: 1, title: 'New', summary: 'Old summary' }],
        tableName: 'posts',
        values: { id: 1, title: 'New', summary: 'Old summary' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(false)

    expect(entry.current?.data).toEqual(data)
    expect(entry.version).toBe(1)
  })

  it('uses shared refresh fallback when a relevant unpatchable target is not covered', async () => {
    const data = {
      post: { id: 1, title: 'Old' },
      summary: { title: 'Old' },
    }
    const unpatchableObservation = createObservation({
      patchable: false,
      resultPath: ['post'],
    })
    const unrelatedObservation = createObservation({
      resultPath: ['summary'],
      scalarColumn: 'summary',
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([unpatchableObservation, unrelatedObservation], data),
      queries: [unpatchableObservation, unrelatedObservation],
    })

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: { id: 1, title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(false)

    expect(entry.current?.data).toEqual(data)
    expect(entry.version).toBe(1)
  })

  it('skips covered belongs-to hydration targets after patching the owner query', async () => {
    const data = {
      author: { id: 2, name: 'Old author' },
      title: 'Old',
    }
    const ownerObservation = createObservation({
      belongsToHydrations: [{
        foreignKey: 'author_id',
        ownerKey: 'id',
        relatedConnectionName: 'main',
        relatedTableName: 'authors',
        relationKey: 'author',
      }],
      resultPath: ['title'],
      scalarColumn: 'title',
    })
    const relationObservation = createObservation({
      predicates: [{ column: 'author_id', operator: '=', value: 2 }],
      relation: {
        foreignKey: 'author_id',
        kind: 'belongsToParentKey',
        ownerKey: 'id',
        relatedConnectionName: 'main',
        relatedTableName: 'authors',
        relationKey: 'author',
      },
      resultPath: ['author'],
    })
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets([ownerObservation, relationObservation], data),
      queries: [ownerObservation, relationObservation],
    })

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: { title: 'New' },
        valueKeys: ['title'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      author: { id: 2, name: 'Old author' },
      title: 'New',
    })
    expect(entry.version).toBe(2)
  })

  it('delivers multiple scalar patches as a compact merge operation', async () => {
    const data = { a: 'old-a', b: 'old-b', c: 'old-c' }
    const observations = [
      createObservation({
        resultPath: ['a'],
        scalarColumn: 'a',
      }),
      createObservation({
        resultPath: ['b'],
        scalarColumn: 'b',
      }),
      createObservation({
        resultPath: ['c'],
        scalarColumn: 'c',
      }),
    ]
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, data),
      queries: observations,
    })
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: {
          a: 'new-a',
          b: 'new-b',
          c: 'new-c',
        },
        valueKeys: ['a', 'b', 'c'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      a: 'new-a',
      b: 'new-b',
      c: 'new-c',
    })
    expect(patches).toEqual([
      {
        operations: [
          {
            fields: {
              a: 'new-a',
              b: 'new-b',
              c: 'new-c',
            },
            op: 'merge',
            path: [],
          },
        ],
        version: 2,
      },
    ])
  })

  it('delivers nested multiple scalar patches through replacement plans', async () => {
    const data = {
      meta: {
        a: 'old-a',
        b: 'old-b',
        c: 'old-c',
      },
    }
    const observations = [
      createObservation({
        resultPath: ['meta', 'a'],
        scalarColumn: 'a',
      }),
      createObservation({
        resultPath: ['meta', 'b'],
        scalarColumn: 'b',
      }),
      createObservation({
        resultPath: ['meta', 'c'],
        scalarColumn: 'c',
      }),
    ]
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, data),
      queries: observations,
    })
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: {
          a: 'new-a',
          b: 'new-b',
          c: 'new-c',
        },
        valueKeys: ['a', 'b', 'c'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      meta: {
        a: 'new-a',
        b: 'new-b',
        c: 'new-c',
      },
    })
    expect(patches).toEqual([
      {
        operations: [
          {
            fields: {
              a: 'new-a',
              b: 'new-b',
              c: 'new-c',
            },
            op: 'merge',
            path: ['meta'],
          },
        ],
        version: 2,
      },
    ])
  })

  it('deduplicates operations for multiple omitted root query paths', async () => {
    const observations = [
      createObservation({
        scalarColumn: 'a',
      }),
      createObservation({
        scalarColumn: 'b',
      }),
      createObservation({
        scalarColumn: 'c',
      }),
    ]
    const patches: RealtimeSubscriptionPatch[] = []
    const entry = createEntry({
      current: {
        data: 'old' as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, 'old'),
      queries: observations,
    })
    const values = {
      get a(): string {
        delete entry.patchTargets[0]
        return 'new'
      },
      b: 'new',
      c: 'new',
    }
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values,
        valueKeys: ['a', 'b', 'c'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toBe('new')
    expect(entry.patchTargets[0]).toBeUndefined()
    expect(entry.patchTargets[1]?.currentValue).toBe('new')
    expect(entry.patchTargets[2]?.currentValue).toBe('new')
    expect(patches).toEqual([
      {
        operations: [
          { op: 'replace', path: [], value: 'new' },
        ],
        version: 2,
      },
    ])
  })

  it('updates delayed patch targets after delivering multiple patches with stale target paths', async () => {
    const data = { a: 'old-a', b: 'old-b', c: 'old-c' }
    const observations = [
      createObservation({
        resultPath: ['a'],
        scalarColumn: 'a',
      }),
      createObservation({
        resultPath: ['b'],
        scalarColumn: 'b',
      }),
      createObservation({
        resultPath: ['c'],
        scalarColumn: 'c',
      }),
    ]
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, data),
      queries: observations,
    })
    const firstTarget = entry.patchTargets[0]
    const secondTarget = entry.patchTargets[1]
    const thirdTarget = entry.patchTargets[2]
    if (!firstTarget || !secondTarget || !thirdTarget) {
      throw new Error('Expected patch targets')
    }

    entry.patchTargets[0] = createStalePathTarget(firstTarget, ['staleA'])
    entry.patchTargets[1] = createStalePathTarget(secondTarget, ['staleB'])
    entry.patchTargets[2] = createStalePathTarget(thirdTarget, ['staleC'])

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: {
          a: 'new-a',
          b: 'new-b',
          c: 'new-c',
        },
        valueKeys: ['a', 'b', 'c'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      a: 'new-a',
      b: 'new-b',
      c: 'new-c',
    })
    expect(entry.patchTargets.map(target => target.currentValue)).toEqual(['new-a', 'new-b', 'new-c'])
    expect(entry.patchTargets.map(target => target.resultPathKey)).toEqual(['["a"]', '["b"]', '["c"]'])
  })

  it('updates a single delayed patch target after delivering multiple patches', async () => {
    const data = { a: 'old-a', b: 'old-b', c: 'old-c' }
    const observations = [
      createObservation({
        resultPath: ['a'],
        scalarColumn: 'a',
      }),
      createObservation({
        resultPath: ['b'],
        scalarColumn: 'b',
      }),
      createObservation({
        resultPath: ['c'],
        scalarColumn: 'c',
      }),
    ]
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, data),
      queries: observations,
    })
    const secondTarget = entry.patchTargets[1]
    if (!secondTarget) {
      throw new Error('Expected patch target')
    }

    entry.patchTargets[1] = createStalePathTarget(secondTarget, ['staleB'])

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values: {
          a: 'new-a',
          b: 'new-b',
          c: 'new-c',
        },
        valueKeys: ['a', 'b', 'c'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      a: 'new-a',
      b: 'new-b',
      c: 'new-c',
    })
    expect(entry.patchTargets.map(target => target.currentValue)).toEqual(['new-a', 'new-b', 'new-c'])
    expect(entry.patchTargets.map(target => target.resultPathKey)).toEqual(['["a"]', '["b"]', '["c"]'])
  })

  it('delivers remaining patches when a target disappears before delivery', async () => {
    const data = { a: 'old-a', b: 'old-b', c: 'old-c' }
    const observations = [
      createObservation({
        resultPath: ['a'],
        scalarColumn: 'a',
      }),
      createObservation({
        resultPath: ['b'],
        scalarColumn: 'b',
      }),
      createObservation({
        resultPath: ['c'],
        scalarColumn: 'c',
      }),
    ]
    const entry = createEntry({
      current: {
        data: data as unknown as DeliveryResult,
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      patchTargets: createQueryPatchTargets(observations, data),
      queries: observations,
    })
    const patches: RealtimeSubscriptionPatch[] = []
    const values = {
      a: 'new-a',
      get b(): string {
        delete entry.patchTargets[1]
        return 'new-b'
      },
      c: 'new-c',
    }
    entry.patchSubscriberRefs.add(createSubscription({
      onPatch: patch => {
        patches.push(patch)
      },
    }))

    await expect(tryPatchQueryEntry(entry, createBackfills([
      {
        connectionName: 'main',
        exactId: 1,
        kind: 'update',
        predicates: [],
        tableName: 'posts',
        values,
        valueKeys: ['a', 'b', 'c'],
      },
    ]))).resolves.toBe(true)

    expect(entry.current?.data).toEqual({
      a: 'new-a',
      b: 'new-b',
      c: 'new-c',
    })
    expect(entry.patchTargets[0]?.currentValue).toBe('new-a')
    expect(entry.patchTargets[1]).toBeUndefined()
    expect(entry.patchTargets[2]?.currentValue).toBe('new-c')
    expect(patches).toEqual([
      {
        operations: [
          {
            fields: {
              a: 'new-a',
              b: 'new-b',
              c: 'new-c',
            },
            op: 'merge',
            path: [],
          },
        ],
        version: 2,
      },
    ])
  })

  it('schedules direct subscription refreshes through shared query entries', async () => {
    const entry = createEntry()
    const subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata> = {
      current: {
        data: undefined,
        dependencies: [],
        name: deliveryQuery.name,
        version: 1,
      },
      id: 'subscription-refresh',
      options: {},
      refreshKey: entry.refreshKey,
    }
    getRuntimeState().queryEntries.set(entry.refreshKey, entry)

    await scheduleSubscriptionRefresh(subscription)

    expect(entry.current?.data).toEqual({ count: 1 })
    expect(getRuntimeState().refreshes.size).toBe(0)
  })

  it('keeps pending refreshes queued when a running refresh fails', async () => {
    deliveryQueryError = new Error('refresh failed')
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('console failed')
    })
    const entry = createEntry()
    let subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>
    subscription = {
      current: {
        data: undefined,
        dependencies: [],
        name: deliveryQuery.name,
        version: 1,
      },
      id: 'failing-refresh-subscription',
      options: {
        onError: () => {
          void scheduleSubscriptionRefresh(subscription).catch(() => {})
          throw new Error('onError failed')
        },
      },
      refreshKey: entry.refreshKey,
    }
    getRuntimeState().queryEntries.set(entry.refreshKey, entry)
    entry.subscriberRefs.add(subscription)

    await expect(scheduleSubscriptionRefresh(subscription)).rejects.toThrow('console failed')

    expect(getRuntimeState().refreshes.get(entry.refreshKey)).toMatchObject({
      pending: true,
      running: undefined,
    })
  })

  it('ignores refreshes and batched invalidations without matching query entries', async () => {
    const entry = createEntry()
    const subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata> = {
      current: {
        data: undefined,
        dependencies: [],
        name: deliveryQuery.name,
        version: 1,
      },
      id: 'missing-subscription-refresh',
      options: {},
      refreshKey: 'missing-refresh-key',
    }
    getRuntimeState().queryEntries.set(entry.refreshKey, entry)

    await scheduleSubscriptionRefresh(subscription)
    await handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:unrelated'],
    }, [
      {
        connectionName: 'main',
        dependencies: ['db:main:unrelated'],
      },
    ])

    expect(entry.current?.data).toEqual({ count: 1 })
    expect(getRuntimeState().refreshes.size).toBe(0)
  })

  it('refreshes through the single-event batched invalidation path', async () => {
    const database = createFakeDatabase(() => [])
    configureRealtimeRuntime({ db: () => database.connection })
    const entry = createEntry({
      current: {
        data: { count: 0 },
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      dependencies: ['db:main:posts'],
      resultHash: '{"count":0}',
      tableDependencies: ['db:main:posts'],
    })
    const state = getRuntimeState()
    state.queryEntries.set(entry.refreshKey, entry)
    addQueryEntryDependencies(entry)
    addQueryEntryInvalidationIndexes(entry)

    await handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    }, [
      {
        connectionName: 'main',
        dependencies: ['db:main:posts'],
      },
    ])

    expect(entry.current?.data).toEqual({ count: 1 })
    expect(entry.version).toBe(2)
  })

  it('refreshes multi-event exact predicate batches with merged predicate metadata', async () => {
    const database = createFakeDatabase(() => [])
    configureRealtimeRuntime({ db: () => database.connection })
    const statusOpen = encodeDependencyValue('open')
    const statusClosed = encodeDependencyValue('closed')
    const entry = createEntry({
      current: {
        data: { count: 0 },
        dependencies: ['db:main:posts'],
        name: deliveryQuery.name,
        version: 1,
      },
      dependencies: ['db:main:posts'],
      resultHash: '{"count":0}',
      tableDependencies: ['db:main:posts'],
    })
    const state = getRuntimeState()
    state.queryEntries.set(entry.refreshKey, entry)
    addQueryEntryDependencies(entry)
    addQueryEntryInvalidationIndexes(entry)

    await handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: [],
    }, [
      {
        connectionName: 'main',
        dependencies: [
          'db:main:posts',
          `db:main:posts:where-exact:status:${statusOpen}`,
        ],
      },
      {
        connectionName: 'main',
        dependencies: [
          'db:main:posts',
          `db:main:posts:where-exact:status:${statusClosed}`,
        ],
      },
    ])

    expect(entry.current?.data).toEqual({ count: 1 })
    expect(entry.version).toBe(2)
  })

  it('flushes invalidation batches that were already cleared', async () => {
    vi.useFakeTimers()
    const entry = createEntry()
    const state = getRuntimeState()
    state.queryEntries.set(entry.refreshKey, entry)
    const pendingInvalidation = handleBatchedDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:unrelated'],
    })
    state.invalidationBatch = undefined

    await vi.advanceTimersByTimeAsync(10)
    await expect(pendingInvalidation).resolves.toBeUndefined()
    expect(state.invalidationBatch).toBeUndefined()
  })

  it('skips snapshot delivery when refreshed data and dependencies are unchanged', async () => {
    const entry = createEntry()
    const snapshots: DeliveryResult[] = []
    entry.snapshotSubscriberRefs.add(createSubscription({
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    }))

    await deliverRefreshData(entry, createDelivery(
      { count: 1 },
      {
        resultHash: '{"count":1}',
        resultHashDirty: false,
      },
    ))

    expect(entry.version).toBe(1)
    expect(snapshots).toEqual([])
  })

  it('clears pending invalidation batches on runtime reset', async () => {
    const state = getRuntimeState()
    let resolveDeferred: (value: void) => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveDeferred = resolve
    })
    state.invalidationBatch = {
      deferred: {
        promise,
        reject: () => {},
        resolve: resolveDeferred,
      },
      events: [],
      timer: setTimeout(() => {}, 1000),
    }

    resetRealtimeRuntime()
    await expect(promise).resolves.toBeUndefined()
    expect(getRuntimeState().invalidationBatch).toBeUndefined()
  })

  it('rejects invalidation batches when event parsing throws', async () => {
    vi.useFakeTimers()
    getRuntimeState().queryEntries.set('runtime.delivery:{}', createEntry())
    const event = Object.defineProperty({
      connectionName: 'main',
    }, 'dependencies', {
      get() {
        throw new Error('invalid dependencies')
      },
    }) as Parameters<typeof handleBatchedDatabaseInvalidation>[0]

    const pendingInvalidation = handleBatchedDatabaseInvalidation(event)
    const rejection = expect(pendingInvalidation).rejects.toThrow('invalid dependencies')
    await vi.advanceTimersByTimeAsync(10)

    await rejection
    expect(getRuntimeState().invalidationBatch).toBeUndefined()
  })

  it('ignores missing subscriptions and detaches idle database listeners', () => {
    const unsubscribe = vi.fn()
    const state = getRuntimeState()
    state.unsubscribeFromDatabase = unsubscribe

    deleteSubscription('missing-subscription')
    expect(unsubscribe).not.toHaveBeenCalled()

    const pendingEntry = createEntry({
      current: undefined,
    })
    const pendingSubscription = createSubscription()
    const runtimeSubscription = pendingSubscription as unknown as ActiveSubscription<RealtimeQueryDefinitionMetadata>
    pendingEntry.subscribers.add(pendingSubscription.id)
    pendingEntry.subscriberRefs.add(pendingSubscription)
    state.queryEntries.set(pendingEntry.refreshKey, pendingEntry)
    state.subscriptions.set(pendingSubscription.id, runtimeSubscription)

    deleteSubscription(pendingSubscription.id)
    expect(pendingSubscription.current.data).toEqual({ count: 0 })
    expect(state.queryEntries.has(pendingEntry.refreshKey)).toBe(false)
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    detachDatabaseSubscriptionIfIdle()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(state.unsubscribeFromDatabase).toBeUndefined()
  })
})
