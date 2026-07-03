import { describe, expect, it } from 'vitest'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import {
  NO_EXACT_ID_PREDICATE,
  type DatabaseQueryPredicateObservation,
  type PredicateMatchContext,
} from '../src/runtime/predicate-matching'
import {
  canBackfillShrinkingRows,
  canPatchShrinkingRows,
  createMutationRowPatchContext,
  createQueryRowPatchContext,
  matchesPatchedPredicateContext,
  matchesPredicateContext,
  mergePatchRow,
  projectedUpdateCannotAffectQueryResult,
  readMutationPatchMetadata,
  replaceRowByIndexLazily,
} from '../src/runtime/query-row-patch-context'
import {
  NO_PROJECTED_IDENTITY_COLUMN,
  type BackfillCache,
  type DatabaseQueryObservation,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }) satisfies TestRow
const secondRow = Object.freeze({ id: 2, priority: 2, status: 'closed', title: 'Second' }) satisfies TestRow
const rows = Object.freeze([firstRow, secondRow]) satisfies readonly TestRow[]

function createPredicate(
  column: string,
  operator: string,
  value: unknown,
): DatabaseQueryPredicateObservation {
  return { column, operator, value }
}

function createPredicateContext(
  predicates: readonly DatabaseQueryPredicateObservation[],
): PredicateMatchContext {
  return {
    exactId: NO_EXACT_ID_PREDICATE,
    firstPredicate: predicates[0],
    predicateCount: predicates.length,
    predicates,
  }
}

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    orderBy: [],
    patchable: true,
    predicates: [],
    result: rows,
    tableName: 'posts',
    ...overrides,
  }
}

function createMutation(overrides: Partial<DatabaseMutationEvent> = {}): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind: 'update',
    predicates: [],
    tableName: 'posts',
    values: { title: 'Updated' },
    valueKeys: ['title'],
    ...overrides,
  }
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

describe('@holo-js/realtime row patch context helpers', () => {
  it('matches exact-id and single-predicate contexts', () => {
    expect(matchesPredicateContext(firstRow, {
      exactId: 1,
      predicateCount: 0,
      predicates: [],
    })).toBe(true)
    expect(matchesPredicateContext(firstRow, createPredicateContext([]))).toBe(true)
    expect(matchesPredicateContext(firstRow, createPredicateContext([
      createPredicate('missing', '=', true),
    ]))).toBeUndefined()
    expect(matchesPredicateContext(firstRow, createPredicateContext([
      createPredicate('status', '=', 'open'),
    ]))).toBe(true)
    expect(matchesPredicateContext(firstRow, createPredicateContext([
      createPredicate('priority', '>', 0),
    ]))).toBe(true)

    expect(matchesPatchedPredicateContext(firstRow, { id: 2 }, {
      exactId: 2,
      predicateCount: 0,
      predicates: [],
    })).toBe(true)
    expect(matchesPatchedPredicateContext(firstRow, { status: 'closed' }, createPredicateContext([
      createPredicate('status', '=', 'closed'),
    ]))).toBe(true)
  })

  it('matches exact-id contexts without ignoring additional predicates', () => {
    const exactOpenContext = {
      exactId: 1,
      firstPredicate: createPredicate('id', '=', 1),
      predicateCount: 2,
      predicates: [
        createPredicate('id', '=', 1),
        createPredicate('status', '=', 'open'),
      ],
    } satisfies PredicateMatchContext

    expect(matchesPredicateContext(firstRow, exactOpenContext)).toBe(true)
    expect(matchesPredicateContext(secondRow, exactOpenContext)).toBe(false)
    expect(matchesPredicateContext({ id: 1, title: 'Sparse' }, exactOpenContext)).toBeUndefined()
    expect(matchesPredicateContext({ id: 1, status: 'closed' }, exactOpenContext)).toBe(false)
    expect(matchesPatchedPredicateContext(firstRow, { status: 'closed' }, exactOpenContext)).toBe(false)
    expect(matchesPatchedPredicateContext(firstRow, { status: 'open' }, exactOpenContext)).toBe(true)
    expect(matchesPatchedPredicateContext(firstRow, { status: 'open', id: 2 }, exactOpenContext)).toBe(false)
    expect(matchesPatchedPredicateContext({ id: 1, title: 'Sparse' }, {}, exactOpenContext)).toBeUndefined()
  })

  it('matches plain and patched predicate contexts across fast and multi-predicate paths', () => {
    expect(matchesPredicateContext(firstRow, createPredicateContext([
      createPredicate('status', '!=', 'closed'),
    ]))).toBe(true)

    const multiContext = createPredicateContext([
      createPredicate('status', '=', 'open'),
      createPredicate('priority', '>', 0),
    ])
    expect(matchesPredicateContext(firstRow, multiContext)).toBe(true)
    expect(matchesPredicateContext(firstRow, createPredicateContext([
      createPredicate('status', '=', 'open'),
      createPredicate('missing', '=', true),
    ]))).toBeUndefined()
    expect(matchesPredicateContext(firstRow, createPredicateContext([
      createPredicate('status', '=', 'open'),
      createPredicate('priority', '>', 10),
    ]))).toBe(false)

    expect(matchesPatchedPredicateContext(firstRow, { priority: 3 }, multiContext)).toBe(true)
    expect(matchesPatchedPredicateContext(firstRow, {}, createPredicateContext([
      createPredicate('status', '=', 'open'),
      createPredicate('missing', '=', true),
    ]))).toBeUndefined()
    expect(matchesPatchedPredicateContext(firstRow, { status: 'closed' }, multiContext)).toBe(false)
    expect(matchesPatchedPredicateContext(firstRow, {}, createPredicateContext([]))).toBe(true)
  })

  it('builds and caches mutation row patch metadata', () => {
    const mutation = createMutation({
      exactId: 1,
      predicates: [createPredicate('id', '=', 1)],
      values: { priority: 3, title: 'Updated' },
      valueKeys: ['priority', 'title'],
    })
    const backfills = createBackfills()
    const metadata = readMutationPatchMetadata(mutation, backfills)

    expect(readMutationPatchMetadata(mutation, backfills)).toBe(metadata)
    expect(metadata.exactMutationId).toBe(1)
    expect(metadata.hasValues).toBe(true)
    expect(metadata.valueKeys).toEqual(['priority', 'title'])

    const queryContext = createQueryRowPatchContext(createQuery({
      hasProjectedSelections: true,
      orderBy: [{ column: 'priority', direction: 'desc' }],
      predicates: [createPredicate('id', '=', 1)],
      selections: [
        { column: 'id', resultKey: 'id' },
        { column: 'title', resultKey: 'title' },
      ],
    }))
    const rowContext = createMutationRowPatchContext(queryContext, metadata)

    expect(rowContext.exactMutationId).toBe(1)
    expect(rowContext.exactQueryId).toBe(1)
    expect(rowContext.hasProjectedSelections).toBe(true)
    expect(rowContext.projectedSelectionChanged).toBe(true)
    expect(rowContext.queryOrderChanged).toBe(true)
    expect(rowContext.selectionColumns).toEqual(['id', 'title'])
    expect(rowContext.selectionResultKeys).toEqual(['id', 'title'])
    expect(rowContext.valueKeys).toEqual(['priority', 'title'])

    const unchangedSelectionMetadata = readMutationPatchMetadata(createMutation({
      values: undefined,
      valueKeys: [],
    }), backfills)
    expect(createMutationRowPatchContext(queryContext, unchangedSelectionMetadata).projectedSelectionChanged).toBe(true)
  })

  it('evaluates shrinking-window patch and backfill eligibility', () => {
    expect(canPatchShrinkingRows(rows, createQuery())).toBe(true)
    expect(canPatchShrinkingRows(rows, createQuery({
      limit: undefined,
      rowWindowMode: 'invalid',
    }))).toBe(true)
    expect(canPatchShrinkingRows(rows, createQuery({
      limit: 3,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toBe(true)
    expect(canPatchShrinkingRows(rows, createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toBe(false)
    expect(canPatchShrinkingRows(rows, createQuery({
      limit: 2,
      offset: 1,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toBe(false)
    expect(canBackfillShrinkingRows(rows, [firstRow], createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toBe(true)
  })

  it('detects projected updates that cannot affect visible query data', () => {
    const query = createQuery({
      hasProjectedSelections: true,
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [createPredicate('status', '=', 'open')],
      selectionColumns: ['title'],
    })
    const queryContext = createQueryRowPatchContext(query)
    const hiddenMutation = createMutation({
      values: { hidden: 'changed' },
      valueKeys: ['hidden'],
    })
    const visibleMutation = createMutation({
      values: { priority: 3 },
      valueKeys: ['priority'],
    })
    const backfills = createBackfills()

    expect(projectedUpdateCannotAffectQueryResult(
      query,
      queryContext,
      hiddenMutation,
      readMutationPatchMetadata(hiddenMutation, backfills),
    )).toBe(true)
    expect(projectedUpdateCannotAffectQueryResult(
      query,
      createQueryRowPatchContext(createQuery({ hasProjectedSelections: true })),
      hiddenMutation,
      readMutationPatchMetadata(hiddenMutation, backfills),
    )).toBe(false)
    expect(projectedUpdateCannotAffectQueryResult(
      query,
      queryContext,
      visibleMutation,
      readMutationPatchMetadata(visibleMutation, backfills),
    )).toBe(false)
    expect(projectedUpdateCannotAffectQueryResult(
      query,
      queryContext,
      createMutation({ kind: 'insert', rows: [firstRow] }),
      readMutationPatchMetadata(createMutation({ kind: 'insert', rows: [firstRow] }), backfills),
    )).toBe(false)
  })

  it('merges records and replaces rows lazily', () => {
    expect(mergePatchRow(firstRow, { title: 'First' })).toBe(firstRow)
    expect(mergePatchRow(firstRow, { hidden: true }, ['hidden'])).toEqual({
      ...firstRow,
      hidden: true,
    })

    expect(replaceRowByIndexLazily(rows, rows.length, { id: 3 })).toEqual([
      ...rows,
      { id: 3 },
    ])
    expect(replaceRowByIndexLazily(rows, 1, { id: 3 })).toEqual([
      firstRow,
      { id: 3 },
    ])

    const sparseRows = [
      firstRow,
      undefined,
      secondRow,
    ] as unknown as readonly TestRow[]
    expect(replaceRowByIndexLazily(sparseRows, 2, { id: 3 })).toEqual([
      firstRow,
      { id: 3 },
    ])
    expect(replaceRowByIndexLazily(rows, -1, { id: 0 })).toEqual([
      { id: 0 },
      ...rows,
    ])

    expect(createQueryRowPatchContext(createQuery({
      limit: 1,
      predicates: [createPredicate('id', '=', 1)],
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
    })).usesExactQueryIdAsProjectedIdentity).toBe(true)
  })
})
