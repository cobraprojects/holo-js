import { describe, expect, it } from 'vitest'
import { query } from '../src'
import type { RealtimeResultFor } from '../src'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import { bindQueryObservationsToSerializedValue } from '../src/runtime/result-bindings'
import {
  createPatchedQueryObservation,
  createQueryPatchTargets,
  isPatchableQueryPatchTarget,
  isRecordPatchTarget,
  isRowsPatchTarget,
  isScalarListPatchTarget,
  isScalarPatchTarget,
  readPatchPathKey,
  updateDelayedPatchedQueryPatchTarget,
  updatePatchedQueryPatchTarget,
  updateQueryEntryObservedQueries,
  updateQueryPatchTargetCurrentValue,
} from '../src/runtime/query-patch-targets'
import { tryPatchObservedQuery } from '../src/runtime/query-patching'
import type {
  DatabaseQueryObservation,
  PatchableQueryPatchTarget,
  QueryPatchPlan,
  QueryPatchTarget,
} from '../src/runtime/query-state'
import type {
  ActiveQueryEntry,
  ActiveSubscription,
  BackfillCache,
} from '../src/runtime/state'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, title: 'First', priority: 2 }),
  Object.freeze({ id: 2, title: 'Second', priority: 1 }),
]) satisfies readonly TestRow[]

const nextRows = Object.freeze([
  Object.freeze({ id: 1, title: 'First', priority: 2 }),
  Object.freeze({ id: 2, title: 'Updated', priority: 1 }),
]) satisfies readonly TestRow[]

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    orderBy: [],
    patchable: true,
    predicates: [],
    tableName: 'posts',
    ...overrides,
  }
}

function expectTarget(target: QueryPatchTarget | undefined): QueryPatchTarget {
  if (!target) {
    throw new Error('Expected query patch target.')
  }

  return target
}

function createBackfills(): BackfillCache {
  return {
    aggregateSql: new Map(),
    aggregates: new Map(),
    entries: [],
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rows: new Map(),
  }
}

const todosQuery = query({
  name: 'patch-targets.todos',
  access: 'public',
  handler: () => rows,
})

function createEntry(
  queries: DatabaseQueryObservation[],
  patchTargets: QueryPatchTarget[],
  data: unknown,
): ActiveQueryEntry<typeof todosQuery> {
  const subscriberRefs = new Set<ActiveSubscription<typeof todosQuery>>()
  return {
    args: {},
    definition: todosQuery,
    patchFallbackSubscriberRefs: new Set<ActiveSubscription<typeof todosQuery>>(),
    patchSubscriberRefs: new Set<ActiveSubscription<typeof todosQuery>>(),
    refreshKey: 'patch-targets.todos:{}',
    snapshotSubscriberRefs: new Set<ActiveSubscription<typeof todosQuery>>(),
    subscriberRefs,
    subscribers: new Set<string>(),
    current: {
      data: data as RealtimeResultFor<typeof todosQuery>,
      dependencies: ['db:main:posts'],
      name: todosQuery.name,
      version: 1,
    },
    dependencies: ['db:main:posts'],
    patchTargets,
    predicateDependencies: new Map(),
    queries,
    resultHash: 'hash',
    resultHashDirty: false,
    tableDependencies: ['db:main:posts'],
    version: 1,
  }
}

describe('@holo-js/realtime query patch targets', () => {
  it('classifies row, record, scalar, scalar list, pagination, and unsupported targets', () => {
    const data = {
      page: { data: rows, meta: { total: 2 } },
      record: { id: 1, title: 'First' },
      rows,
      scalar: 2,
      scalars: [1, 2],
      unsupported: 'value',
    }
    const targets = createQueryPatchTargets([
      createQuery({ resultPath: ['rows'] }),
      createQuery({ resultPath: ['record'] }),
      createQuery({ resultPath: ['scalar'], scalarColumn: 'total' }),
      createQuery({ resultPath: ['scalars'], scalarListColumn: 'id' }),
      createQuery({
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 10,
          total: 2,
        },
        resultPath: ['page'],
      }),
      createQuery({ resultPath: ['unsupported'] }),
    ], data)

    expect(targets.map(target => target.rowPatchMode)).toEqual([
      'rows',
      'record',
      'scalar',
      'scalar-list',
      'pagination',
      'unsupported',
    ])
    expect(targets.map(target => target.patchCapability)).toEqual([
      'patchable',
      'patchable',
      'patchable',
      'patchable',
      'patchable',
      'refresh',
    ])
    expect(isRowsPatchTarget(expectTarget(targets[0]))).toBe(true)
    expect(isRecordPatchTarget(expectTarget(targets[1]))).toBe(true)
    expect(isScalarPatchTarget(expectTarget(targets[2]))).toBe(true)
    expect(isScalarListPatchTarget(expectTarget(targets[3]))).toBe(true)
    expect(isPatchableQueryPatchTarget(expectTarget(targets[5]))).toBe(false)
  })

  it('keeps offset windows and patchable aggregates patchable while refreshing unpatchable aggregates', () => {
    const targets = createQueryPatchTargets([
      createQuery({
        limit: 1,
        offset: 1,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        resultPath: ['rows'],
      }),
      createQuery({
        aggregate: { kind: 'count' },
        resultPath: ['count'],
      }),
      createQuery({
        aggregate: { kind: 'sum', column: 'priority' },
        limit: 10,
        resultPath: ['sum'],
      }),
      createQuery({
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 10,
          prevCursor: null,
          rowCount: 2,
          rows,
        },
        patchable: false,
        resultPath: ['cursorPage'],
      }),
    ], {
      count: 2,
      cursorPage: rows,
      rows,
      sum: 3,
    })

    expect(targets.map(target => target.rowPatchMode)).toEqual([
      'offset-window',
      undefined,
      undefined,
      'pagination',
    ])
    expect(targets.map(target => target.aggregatePatchMode)).toEqual([
      undefined,
      'simple',
      'unpatchable',
      undefined,
    ])
    expect(targets.map(target => target.patchCapability)).toEqual([
      'patchable',
      'patchable',
      'refresh',
      'refresh',
    ])
  })

  it('skips wrapper data patching only when the wrapped rows can still be patched', () => {
    const standardPage = { data: rows, meta: { total: 2 } }
    const scalarPage = { data: 2, meta: { total: 2 } }
    const cursorPage = {
      cursorName: 'cursor',
      data: rows,
      nextCursor: null,
      perPage: 10,
      prevCursor: null,
    }

    const [wrappedRows, cursorWrappedRows, unpatchableRows] = createQueryPatchTargets([
      createQuery({ resultPath: ['data'] }),
      createQuery({ resultPath: ['data'] }),
      createQuery({ patchable: false, resultPath: ['data'] }),
    ], standardPage)
    const [wrappedScalar] = createQueryPatchTargets([
      createQuery({ resultPath: ['data'], scalarColumn: 'total' }),
    ], scalarPage)
    const [cursorTarget] = createQueryPatchTargets([
      createQuery({ resultPath: ['data'] }),
    ], cursorPage)

    expect(wrappedRows?.skipsPatching).toBe(true)
    expect(wrappedRows?.patchCapability).toBe('patchable')
    expect(wrappedScalar?.skipsPatching).toBe(true)
    expect(wrappedScalar?.patchCapability).toBe('refresh')
    expect(cursorWrappedRows?.skipsPatching).toBe(true)
    expect(unpatchableRows?.skipsPatching).toBe(true)
    expect(unpatchableRows?.patchCapability).toBe('refresh')
    expect(cursorTarget?.skipsPatching).toBe(true)
    expect(cursorTarget?.patchCapability).toBe('patchable')
  })

  it('uses result-bound values and keeps patch path keys stable when paths are reused', () => {
    const resultPath = Object.freeze(['ignored'])
    const queryObservation = createQuery({
      result: rows,
      resultBound: true,
      resultPath,
    })
    const [target] = createQueryPatchTargets([queryObservation], { ignored: [] })

    expect(target?.currentValue).toBe(rows)
    expect(target?.resultPath).toBe(resultPath)
    expect(readPatchPathKey(queryObservation, target)).toBe(target?.resultPathKey)
    expect(readPatchPathKey(createQuery({
      resultPath,
      resultPathKey: 'explicit',
    }), target)).toBe('explicit')
    expect(readPatchPathKey(createQuery())).toBe('[]')
  })

  it('does not bind ambiguous primitive query results', () => {
    const boundQueries = bindQueryObservationsToSerializedValue([
      createQuery({ result: 1 }),
      createQuery({ result: 1 }),
    ], {
      first: 1,
      second: 1,
    }, {
      first: 1,
      second: 1,
    })

    expect(boundQueries).toHaveLength(2)
    expect(boundQueries.map(queryObservation => queryObservation.resultBound)).toEqual([false, false])
    expect(boundQueries.map(queryObservation => queryObservation.resultPath)).toEqual([[], []])
  })

  it('binds nested raw values to undefined when serialized arrays or records are missing', () => {
    const arrayRow = Object.freeze({ id: 1, title: 'First' })
    const recordRow = Object.freeze({ id: 2, title: 'Second' })
    const arrayBoundQueries = bindQueryObservationsToSerializedValue([
      createQuery({ result: arrayRow }),
    ], [
      arrayRow,
    ], {
      rows: [],
    })
    const recordBoundQueries = bindQueryObservationsToSerializedValue([
      createQuery({ result: recordRow }),
    ], {
      row: recordRow,
    }, [
      recordRow,
    ])

    expect(arrayBoundQueries).toMatchObject([
      {
        result: undefined,
        resultBound: true,
        resultPath: [0],
      },
    ])
    expect(recordBoundQueries).toMatchObject([
      {
        result: undefined,
        resultBound: true,
        resultPath: ['row'],
      },
    ])
  })

  it('leaves observed queries unpatched when no patch branch can handle them', async () => {
    const [rowsTarget] = createQueryPatchTargets([
      createQuery({ resultPath: ['rows'] }),
    ], { rows })
    const unhandledTarget = {
      currentValue: 'value',
      index: 0,
      mutationIndexKey: 'main:posts',
      patchCapability: 'patchable',
      query: createQuery({ resultPath: ['value'] }),
      resultPath: ['value'],
      resultPathKey: '["value"]',
      skipsPatching: false,
    } satisfies PatchableQueryPatchTarget
    const mutation = {
      connectionName: 'main',
      kind: 'update',
      predicates: [],
      tableName: 'posts',
      values: { title: 'Updated' },
    } satisfies DatabaseMutationEvent

    if (!rowsTarget || !isPatchableQueryPatchTarget(rowsTarget)) {
      throw new Error('Expected a patchable rows target.')
    }

    await expect(tryPatchObservedQuery(rowsTarget, [], createBackfills())).resolves.toEqual({
      patched: false,
    })
    await expect(tryPatchObservedQuery(unhandledTarget, [mutation], createBackfills())).resolves.toEqual({
      patched: false,
    })
  })

  it('updates target values from patched values, query-bound results, and current entry data', () => {
    const queryObservation = createQuery({ resultPath: ['rows'] })
    const [target] = createQueryPatchTargets([queryObservation], { rows })
    const patchTarget = expectTarget(target)

    const patchedTarget = updatePatchedQueryPatchTarget(
      patchTarget,
      queryObservation,
      nextRows,
      { rows },
      ['rows'],
      patchTarget.resultPathKey,
    )
    expect(patchedTarget.currentValue).toBe(nextRows)

    const pathTarget = updatePatchedQueryPatchTarget(
      patchedTarget,
      queryObservation,
      rows,
      { rows: nextRows },
      ['rows'],
      'changed-path',
    )
    expect(pathTarget.currentValue).toBe(nextRows)

    const resultBoundQuery = createQuery({
      result: rows,
      resultBound: true,
      resultPath: ['rows'],
    })
    const resultBoundTarget = updatePatchedQueryPatchTarget(
      pathTarget,
      resultBoundQuery,
      nextRows,
      { rows: nextRows },
      ['rows'],
      'bound-path',
    )
    expect(resultBoundTarget.currentValue).toBe(rows)

    const currentValueTarget = updateQueryPatchTargetCurrentValue(
      resultBoundTarget,
      queryObservation,
      { rows: nextRows },
    )
    expect(currentValueTarget.currentValue).toBe(nextRows)

    const rootQuery = createQuery()
    const [rootTarget] = createQueryPatchTargets([rootQuery], rows)
    const rootPatchTarget = expectTarget(rootTarget)
    const patchedRootTarget = updatePatchedQueryPatchTarget(
      rootPatchTarget,
      rootQuery,
      nextRows,
      nextRows,
    )
    expect(patchedRootTarget.resultPath).toEqual([])
    expect(patchedRootTarget.currentValue).toBe(nextRows)

    const resultBoundCurrentTarget = updateQueryPatchTargetCurrentValue(
      rootPatchTarget,
      createQuery({
        result: nextRows,
        resultBound: true,
      }),
      rows,
    )
    expect(resultBoundCurrentTarget.currentValue).toBe(nextRows)
  })

  it('updates delayed targets and ignores missing delayed query indexes', () => {
    const queryObservation = createQuery({
      result: nextRows,
      resultPath: ['rows'],
    })
    const [target] = createQueryPatchTargets([queryObservation], { rows })
    const entry = createEntry([queryObservation], target ? [target] : [], { rows })

    updateDelayedPatchedQueryPatchTarget(entry, 1, { rows: nextRows })
    expect(entry.patchTargets[0]).toBe(target)

    updateDelayedPatchedQueryPatchTarget(entry, 0, { rows })
    expect(entry.patchTargets[0]?.currentValue).toBe(nextRows)

    const rootQuery = createQuery({
      result: nextRows,
    })
    const [rootTarget] = createQueryPatchTargets([rootQuery], rows)
    const rootEntry = createEntry([rootQuery], rootTarget ? [rootTarget] : [], rows)
    updateDelayedPatchedQueryPatchTarget(rootEntry, 0, nextRows)
    expect(rootEntry.patchTargets[0]?.resultPath).toEqual([])
    expect(rootEntry.patchTargets[0]?.currentValue).toBe(nextRows)
  })

  it('reuses, refreshes, and rebuilds entry patch targets as observed queries change', () => {
    const queryObservation = createQuery({ resultPath: ['rows'] })
    const secondQuery = createQuery({ resultPath: ['record'] })
    const data = { rows }
    const [target] = createQueryPatchTargets([queryObservation], data)
    const entry = createEntry([queryObservation], target ? [target] : [], data)

    updateQueryEntryObservedQueries(entry, [queryObservation], data)
    expect(entry.patchTargets[0]).toBe(target)

    updateQueryEntryObservedQueries(entry, entry.queries, data)
    expect(entry.patchTargets[0]).toBe(target)

    updateQueryEntryObservedQueries(entry, [queryObservation], { rows: nextRows })
    expect(entry.patchTargets[0]).not.toBe(target)
    expect(entry.patchTargets[0]?.currentValue).toBe(nextRows)

    delete entry.current
    const updatedTarget = entry.patchTargets[0]
    updateQueryEntryObservedQueries(entry, [queryObservation], { rows: nextRows })
    expect(entry.patchTargets[0]).not.toBe(updatedTarget)
    expect(entry.patchTargets[0]?.currentValue).toBe(nextRows)

    updateQueryEntryObservedQueries(entry, [queryObservation, secondQuery], {
      record: { id: 1, title: 'First' },
      rows,
    })
    expect(entry.patchTargets).toHaveLength(2)
    expect(entry.patchTargets[1]?.rowPatchMode).toBe('record')

    const rootQuery = createQuery()
    const [rootTarget] = createQueryPatchTargets([rootQuery], rows)
    const rootEntry = createEntry([rootQuery], rootTarget ? [rootTarget] : [], rows)
    updateQueryEntryObservedQueries(rootEntry, [rootQuery], nextRows)
    expect(rootEntry.patchTargets[0]?.currentValue).toBe(nextRows)
  })

  it('rebuilds sparse observed query targets and preserves earlier targets before later rebuilds', () => {
    const firstQuery = createQuery({ resultPath: ['rows'] })
    const secondQuery = createQuery({ resultPath: ['record'] })
    const data = {
      record: { id: 1, title: 'First' },
      rows,
    }
    const initialTargets = createQueryPatchTargets([firstQuery, secondQuery], data)
    const entry = createEntry([firstQuery, secondQuery], [...initialTargets], data)
    const replacementSecondQuery = createQuery({ resultPath: ['record'] })
    delete entry.patchTargets[0]

    updateQueryEntryObservedQueries(entry, [firstQuery, replacementSecondQuery], data)
    expect(entry.patchTargets[0]?.query).toBe(firstQuery)
    expect(entry.patchTargets[1]?.query).toBe(replacementSecondQuery)

    entry.queries = [firstQuery, secondQuery]
    entry.patchTargets = [...initialTargets]
    updateQueryEntryObservedQueries(entry, [firstQuery, replacementSecondQuery], data)
    expect(entry.patchTargets[0]).toBe(initialTargets[0])
    expect(entry.patchTargets[1]).not.toBe(initialTargets[1])

    const sparseQueries = [firstQuery] as DatabaseQueryObservation[]
    sparseQueries.length = 2
    updateQueryEntryObservedQueries(entry, sparseQueries, data)
    expect(entry.patchTargets).toHaveLength(1)
    expect(entry.patchTargets[0]?.query).toBe(firstQuery)
  })

  it('creates patched query observations with derived metadata and preserves matching patch plans', () => {
    const patchPlan = {
      mutationIndexKey: 'main:posts',
      resultPath: ['rows'],
      resultPathKey: '["rows"]',
    } satisfies QueryPatchPlan
    const [target] = createQueryPatchTargets([
      createQuery({
        orderBy: [{ column: 'priority', direction: 'desc' }],
        patchPlan,
        predicates: [{ column: 'id', operator: '=', value: 1 }],
        resultPath: ['rows'],
        resultPathKey: '["rows"]',
        selections: [
          { column: 'id', resultKey: 'id' },
          { column: 'title', resultKey: 'label' },
        ],
      }),
    ], { rows })

    const patchTarget = expectTarget(target)

    const patchedQuery = createPatchedQueryObservation(
      patchTarget.query,
      rows,
      patchTarget.resultPathKey,
    )

    expect(patchedQuery.exactId).toBe(1)
    expect(patchedQuery.hasOrderBy).toBe(true)
    expect(patchedQuery.hasProjectedSelections).toBe(true)
    expect(patchedQuery.orderColumns).toEqual(['priority'])
    expect(patchedQuery.orderMultipliers).toEqual([-1])
    expect(patchedQuery.patchPlan).toBe(patchTarget.query.patchPlan)
    expect(patchedQuery.predicateColumns).toEqual(['id'])
    expect(patchedQuery.projectedIdentityColumn).toBe('id')
    expect(patchedQuery.result).toBe(rows)
    expect(patchedQuery.rowIdentityIndex?.get(1)).toBe(0)
    expect(patchedQuery.rowWindowMode).toBe('unwindowed')
    expect(patchedQuery.selectionColumns).toEqual(['id', 'title'])
    expect(patchedQuery.selectionResultKeys).toEqual(['id', 'label'])

    const mismatchedPathQuery = createPatchedQueryObservation(
      patchedQuery,
      rows,
      'other-path',
    )
    expect(mismatchedPathQuery.patchPlan).toBeUndefined()
  })

  it('falls back to the no-exact-id marker when no exact predicate exists', () => {
    const patchedQuery = createPatchedQueryObservation(
      createQuery({ resultPath: ['rows'] }),
      rows,
      'rows',
    )

    expect(patchedQuery.exactId).toBe(NO_EXACT_ID_PREDICATE)
  })
})
