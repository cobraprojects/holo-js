import { afterEach, describe, expect, it } from 'vitest'
import { query, type RealtimeQueryDefinitionMetadata } from '../src'
import {
  parseInvalidationEvent,
  type ParsedInvalidationEvent,
  type PredicateDependencyIndex,
} from '../src/runtime/dependencies'
import { resetRealtimeRuntime } from '../src/runtime/lifecycle'
import {
  addQueryEntryDependencies,
  addQueryEntryInvalidationIndexes,
  areDependencySetsEqual,
  collectQueryEntriesForParsedInvalidation,
  collectQueryEntriesForParsedInvalidations,
  removeQueryEntryDependencies,
  removeQueryEntryInvalidationIndexes,
} from '../src/runtime/subscription-index'
import {
  getRuntimeState,
  type ActiveQueryEntry,
  type ActiveSubscription,
} from '../src/runtime/state'

const subscriptionIndexQuery = query({
  name: 'runtime.subscription-index',
  access: 'public',
  handler: () => ({ ok: true }),
})

type TestDefinition = typeof subscriptionIndexQuery
type TestEntry = ActiveQueryEntry<TestDefinition>
type TestSubscription = ActiveSubscription<TestDefinition>

const tableKey = 'db:main:posts'

afterEach(() => {
  resetRealtimeRuntime()
})

function encodeDependencyValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value))
}

function createPredicateIndex(
  table: string,
  column: string,
  values: readonly string[],
): PredicateDependencyIndex {
  return new Map([
    [
      table,
      new Map([
        [
          column,
          new Set(values),
        ],
      ]),
    ],
  ])
}

function createEntry(overrides: Partial<TestEntry> = {}): TestEntry {
  return {
    args: {},
    definition: subscriptionIndexQuery,
    dependencies: [tableKey],
    patchFallbackSubscriberRefs: new Set<TestSubscription>(),
    patchSubscriberRefs: new Set<TestSubscription>(),
    patchTargets: [],
    predicateDependencies: new Map(),
    queries: [],
    refreshKey: 'runtime.subscription-index:{}',
    resultHash: '{"ok":true}',
    resultHashDirty: false,
    snapshotSubscriberRefs: new Set<TestSubscription>(),
    subscriberRefs: new Set<TestSubscription>(),
    subscribers: new Set<string>(),
    tableDependencies: [tableKey],
    version: 1,
    ...overrides,
  }
}

function createInvalidationEvent(overrides: Partial<ParsedInvalidationEvent> = {}): ParsedInvalidationEvent {
  return {
    dependencies: [tableKey],
    directDependencies: [tableKey],
    exactPredicates: new Map(),
    hasMutationDependency: false,
    mutations: [],
    predicates: new Map(),
    tableDependencies: [],
    ...overrides,
  }
}

describe('@holo-js/realtime subscription index', () => {
  it('removes dependency and invalidation indexes defensively', () => {
    const state = getRuntimeState()
    const statusOpen = encodeDependencyValue('open')
    const entry = createEntry({
      dependencies: [tableKey, `${tableKey}:where:status:${statusOpen}`],
      predicateDependencies: createPredicateIndex(tableKey, 'status', [statusOpen]),
    })

    removeQueryEntryDependencies(entry)
    addQueryEntryDependencies(entry)
    expect(state.dependencySubscribers.get(tableKey)?.has(entry.refreshKey)).toBe(true)
    expect(state.dependencySubscribers.get(`${tableKey}:where:status:${statusOpen}`)?.has(entry.refreshKey)).toBe(true)

    removeQueryEntryDependencies(createEntry({
      dependencies: ['db:main:missing'],
      refreshKey: entry.refreshKey,
    }))
    removeQueryEntryDependencies(entry)
    expect(state.dependencySubscribers.size).toBe(0)

    addQueryEntryInvalidationIndexes(entry)
    expect(state.tablePredicateColumnSubscribers.get(tableKey)?.get('status')?.has(entry.refreshKey)).toBe(true)
    expect(state.tablePredicateValueSubscribers.get(tableKey)?.get('status')?.get(statusOpen)?.has(entry.refreshKey)).toBe(true)

    state.tablePredicateColumnSubscribers.get(tableKey)?.delete('status')
    removeQueryEntryInvalidationIndexes(entry)
    expect(state.tablePredicateValueSubscribers.size).toBe(0)

    addQueryEntryInvalidationIndexes(entry)
    state.tablePredicateValueSubscribers.delete(tableKey)
    removeQueryEntryInvalidationIndexes(entry)
    expect(state.tablePredicateColumnSubscribers.size).toBe(0)

    addQueryEntryInvalidationIndexes(entry)
    state.tablePredicateValueSubscribers.get(tableKey)?.delete('status')
    removeQueryEntryInvalidationIndexes(entry)
    expect(state.tablePredicateColumnSubscribers.size).toBe(0)

    addQueryEntryInvalidationIndexes(entry)
    state.tablePredicateValueSubscribers.get(tableKey)?.get('status')?.delete(statusOpen)
    removeQueryEntryInvalidationIndexes(entry)
    expect(state.tablePredicateColumnSubscribers.size).toBe(0)

    addQueryEntryInvalidationIndexes(entry)
    state.tablePredicateColumnSubscribers.delete(tableKey)
    removeQueryEntryInvalidationIndexes(entry)
    expect(state.tablePredicateValueSubscribers.size).toBe(0)

    addQueryEntryInvalidationIndexes(entry)
    state.tablePredicateValueSubscribers.get(tableKey)?.get('status')?.get(statusOpen)?.add('other-entry')
    removeQueryEntryInvalidationIndexes(entry)
    expect(state.tablePredicateValueSubscribers.get(tableKey)?.get('status')?.get(statusOpen)).toEqual(new Set(['other-entry']))
  })

  it('compares dependency sets by ordered and unordered equality', () => {
    expect(areDependencySetsEqual(['a'], ['a', 'b'])).toBe(false)
    expect(areDependencySetsEqual(['a', 'a'], ['a', 'b'])).toBe(false)
    expect(areDependencySetsEqual(['b', 'a'], ['a', 'b'])).toBe(true)
  })

  it('collects empty, single, and exact-table invalidation entries', () => {
    const state = getRuntimeState()
    const broadEntry = createEntry({
      refreshKey: 'broad',
    })
    state.queryEntries.set(broadEntry.refreshKey, broadEntry)
    addQueryEntryDependencies(broadEntry)

    expect(collectQueryEntriesForParsedInvalidations([])).toEqual([])
    expect(collectQueryEntriesForParsedInvalidations([createInvalidationEvent()])).toEqual([broadEntry])

    const exactStatus = encodeDependencyValue('open')
    const exactInvalidation = parseInvalidationEvent({
      connectionName: 'main',
      dependencies: [
        tableKey,
        `${tableKey}:where-exact:status:${exactStatus}`,
      ],
    })
    expect(collectQueryEntriesForParsedInvalidation(exactInvalidation)).toEqual([])

    const mismatchedExactInvalidation = createInvalidationEvent({
      directDependencies: [],
      exactPredicates: createPredicateIndex(tableKey, 'status', [exactStatus]),
      tableDependencies: ['db:main:comments'],
    })
    expect(collectQueryEntriesForParsedInvalidation(mismatchedExactInvalidation)).toEqual([])
    expect(collectQueryEntriesForParsedInvalidations([
      mismatchedExactInvalidation,
      createInvalidationEvent({
        dependencies: ['db:main:comments'],
        directDependencies: ['db:main:comments'],
      }),
    ])).toEqual([])
  })
})
