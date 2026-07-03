import { describe, expect, it } from 'vitest'
import { canPatchStableWindowMutationWithoutBackfill } from '../src/runtime/query-stable-window'
import {
  appendRowLazily,
  createScannedRowsState,
  flushScannedRows,
  readScannedRows,
  removeRowByIndex,
  removeRowByIdentityValueFromQueryRows,
  removeRowByIdentityValueFromQueryRowsLazily,
  removeRowsByIdentityValues,
  removeRowsByIdentityValuesLazily,
  removeRowsByIdentityValuesFromQueryRows,
  removeRowsByIdentityValuesFromQueryRowsLazily,
  removeRowsByTwoIdentityValues,
  removeRowsByTwoIdentityValuesLazily,
  removeRowsByTwoIdentityValuesFromQueryRows,
  removeRowsByTwoIdentityValuesFromQueryRowsLazily,
} from '../src/runtime/query-row-array'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import {
  findRowIndexByIdentity,
  readMutationRowsContainExactQueryId,
  readPreviousMutationRowsContainExactQueryId,
} from '../src/runtime/query-row-patch-helpers'
import {
  mutationRowsContainExactId,
} from '../src/runtime/query-row-matching'
import type {
  DatabaseQueryObservation,
  MutationPatchMetadata,
  RowPatchContext,
} from '../src/runtime/query-state'
import {
  DUPLICATE_ROW_IDENTITY,
  NO_PROJECTED_IDENTITY_COLUMN,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, title: 'First', status: 'open', priority: 1 }),
  Object.freeze({ id: 2, title: 'Second', status: 'open', priority: 2 }),
  Object.freeze({ id: 3, title: 'Third', status: 'closed', priority: 3 }),
]) satisfies readonly TestRow[]

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

function createMetadata(overrides: Partial<MutationPatchMetadata> = {}): MutationPatchMetadata {
  return {
    exactMutationId: 1,
    hasValues: true,
    mutationPredicates: {
      exactId: 1,
      predicateCount: 0,
      predicates: [],
    },
    valueKeys: ['title'],
    ...overrides,
  }
}

function createRowPatchContext(overrides: Partial<RowPatchContext> = {}): RowPatchContext {
  return {
    exactMutationId: 1,
    exactQueryId: 1,
    hasProjectedSelections: false,
    mutationPredicates: {
      exactId: 1,
      predicateCount: 0,
      predicates: [],
    },
    orderColumns: [],
    orderMultipliers: [],
    projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
    projectedSelectionChanged: false,
    queryOrderChanged: false,
    queryPredicates: {
      exactId: 1,
      predicateCount: 0,
      predicates: [],
    },
    selectionColumns: [],
    selectionResultKeys: [],
    usesExactQueryIdAsProjectedIdentity: false,
    valueKeys: [],
    ...overrides,
  }
}

describe('@holo-js/realtime row array patch helpers', () => {
  it('removes rows by indexed identities without scanning unchanged rows', () => {
    const query = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })

    expect(removeRowsByIdentityValuesFromQueryRows(rows, query, new Set([2]))).toEqual([
      rows[0],
      rows[2],
    ])
    expect(removeRowsByTwoIdentityValuesFromQueryRows(rows, query, 1, 3)).toEqual([
      rows[1],
    ])
    expect(removeRowsByTwoIdentityValuesFromQueryRows(rows, query, 3, 1)).toEqual([
      rows[1],
    ])
    expect(removeRowsByIdentityValuesFromQueryRows(rows, query, new Set([4]))).toBe(rows)
  })

  it('handles malformed indexed identity removals without duplicating rows', () => {
    const duplicateIndexQuery = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 0],
        [3, 2],
      ]),
    })

    expect(removeRowsByTwoIdentityValuesFromQueryRows(rows, duplicateIndexQuery, 1, 2)).toEqual([
      rows[1],
      rows[2],
    ])
    expect(removeRowsByTwoIdentityValuesFromQueryRows(rows, duplicateIndexQuery, 1, 4)).toEqual([
      rows[1],
      rows[2],
    ])
    expect(removeRowsByIdentityValuesFromQueryRows(rows, duplicateIndexQuery, new Set([1, 2]))).toEqual([
      rows[1],
      rows[2],
    ])
    expect(removeRowsByIdentityValuesFromQueryRows(rows, duplicateIndexQuery, new Set([1, 2, 3]))).toEqual([
      rows[1],
    ])
  })

  it('falls back to scanning rows when identity indexes are unavailable', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 1, title: 'Duplicate' }),
      Object.freeze({ id: 2, title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: duplicateRows,
    })

    expect(removeRowsByIdentityValuesFromQueryRows(duplicateRows, query, new Set([1]))).toEqual([
      duplicateRows[2],
    ])
    expect(removeRowsByTwoIdentityValuesFromQueryRows(duplicateRows, query, 1, 2)).toEqual([])
  })

  it('mutates existing lazy row buffers in place while removing matching identities', () => {
    const query = createQuery()
    const nextRows = [...rows]
    const result = removeRowsByIdentityValuesFromQueryRowsLazily(rows, nextRows, query, new Set([1, 3]))

    expect(result).toBe(nextRows)
    expect(nextRows).toEqual([rows[1]])

    const secondRows = [...rows]
    const secondResult = removeRowsByTwoIdentityValuesFromQueryRowsLazily(rows, secondRows, query, 1, 2)

    expect(secondResult).toBe(secondRows)
    expect(secondRows).toEqual([rows[2]])
  })

  it('falls back to scanning rows for lazy removals when identity indexes are unavailable', () => {
    const query = createQuery()
    const malformedRows = Object.freeze([
      Object.freeze({ title: 'First' }),
      Object.freeze({ id: 2, title: 'Second' }),
      Object.freeze({ id: 3, title: 'Third' }),
    ]) satisfies readonly TestRow[]
    const malformedQuery = createQuery({
      result: malformedRows,
    })

    expect(removeRowsByIdentityValuesFromQueryRowsLazily(rows, undefined, query, new Set([1, 3]))).toEqual([
      rows[1],
    ])
    expect(removeRowsByTwoIdentityValuesFromQueryRowsLazily(rows, undefined, query, 1, 3)).toEqual([
      rows[1],
    ])
    expect(removeRowsByIdentityValuesFromQueryRowsLazily(malformedRows, undefined, malformedQuery, new Set([2]))).toEqual([
      malformedRows[0],
      malformedRows[2],
    ])
    expect(removeRowsByTwoIdentityValuesFromQueryRowsLazily(malformedRows, undefined, malformedQuery, 2, 3)).toEqual([
      malformedRows[0],
    ])
  })

  it('returns undefined for lazy indexed removals when no identity matches', () => {
    const query = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })

    expect(removeRowsByIdentityValuesFromQueryRowsLazily(rows, undefined, query, new Set([5]))).toBeUndefined()
    expect(removeRowsByTwoIdentityValuesFromQueryRowsLazily(rows, undefined, query, 5, 6)).toBeUndefined()
  })

  it('removes single identity values through indexed and scanned paths', () => {
    const indexedQuery = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const sparseRows = [
      rows[0],
      undefined,
      rows[2],
    ] as unknown as readonly TestRow[]
    const sparseQuery = createQuery({
      result: sparseRows,
    })
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 1, title: 'Duplicate' }),
      Object.freeze({ id: 2, title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const duplicateQuery = createQuery({
      result: duplicateRows,
    })

    expect(removeRowByIdentityValueFromQueryRows(rows, indexedQuery, 2)).toEqual([rows[0], rows[2]])
    expect(removeRowByIdentityValueFromQueryRows(rows, indexedQuery, 4)).toBe(rows)
    expect(removeRowByIdentityValueFromQueryRows(sparseRows, sparseQuery, 1)).toEqual([rows[2]])
    expect(removeRowByIdentityValueFromQueryRows(duplicateRows, duplicateQuery, 1)).toEqual([
      duplicateRows[2],
    ])
    expect(removeRowByIdentityValueFromQueryRows(duplicateRows, duplicateQuery, 4)).toBe(duplicateRows)
  })

  it('removes single identity values lazily through indexed and existing-buffer paths', () => {
    const indexedQuery = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const nextRows = [...rows]
    const sparseNextRows = [
      rows[0],
      undefined,
      rows[2],
    ] as unknown as TestRow[]
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 1, title: 'Duplicate' }),
      Object.freeze({ id: 2, title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const duplicateQuery = createQuery({
      result: duplicateRows,
    })

    expect(removeRowByIdentityValueFromQueryRowsLazily(rows, undefined, indexedQuery, 3)).toEqual([
      rows[0],
      rows[1],
    ])
    expect(removeRowByIdentityValueFromQueryRowsLazily(rows, undefined, indexedQuery, 4)).toBeUndefined()
    expect(removeRowByIdentityValueFromQueryRowsLazily(rows, nextRows, indexedQuery, 2)).toBe(nextRows)
    expect(nextRows).toEqual([rows[0], rows[2]])
    expect(removeRowByIdentityValueFromQueryRowsLazily(rows, sparseNextRows, indexedQuery, 3)).toBe(sparseNextRows)
    expect(sparseNextRows).toEqual([rows[0]])
    expect(removeRowByIdentityValueFromQueryRowsLazily(duplicateRows, undefined, duplicateQuery, 1)).toEqual([
      duplicateRows[2],
    ])
    expect(removeRowByIdentityValueFromQueryRowsLazily(duplicateRows, undefined, duplicateQuery, 4)).toBeUndefined()
  })

  it('preserves row order while appending rows through sparse and scanned states', () => {
    const sparseRows = [
      rows[0],
      undefined,
      rows[2],
    ] as unknown as readonly TestRow[]

    expect(appendRowLazily(sparseRows, Object.freeze({ id: 4 }))).toEqual([
      rows[0],
      rows[2],
      { id: 4 },
    ])
    expect(appendRowLazily(rows, Object.freeze({ id: 4 }))).toEqual([
      rows[0],
      rows[1],
      rows[2],
      { id: 4 },
    ])

    const state = createScannedRowsState()
    flushScannedRows(state, rows, 2)
    expect(readScannedRows(state, rows)).toEqual(rows)
    expect(removeRowByIndex(rows, 1)).toEqual([rows[0], rows[2]])
  })

  it('keeps original row references when identity removals do not change the set', () => {
    expect(removeRowsByIdentityValues(rows, new Set([10]))).toBe(rows)
  })

  it('removes multiple identities through direct scanned lazy helpers', () => {
    const sparseRows = [
      rows[0],
      undefined,
      rows[1],
      rows[2],
    ] as unknown as readonly TestRow[]

    expect(removeRowsByIdentityValuesLazily(rows, undefined, new Set([1, 3]))).toEqual([rows[1]])
    expect(removeRowsByIdentityValuesLazily(rows, undefined, new Set([4]))).toBeUndefined()
    expect(removeRowsByIdentityValues(sparseRows, new Set([1, 3]))).toEqual([rows[1]])
    expect(removeRowsByIdentityValuesLazily(sparseRows, undefined, new Set([1, 3]))).toEqual([rows[1]])
    expect(removeRowsByTwoIdentityValues(rows, 1, 3)).toEqual([rows[1]])
    expect(removeRowsByTwoIdentityValues(rows, 4, 5)).toBe(rows)
    expect(removeRowsByTwoIdentityValues(sparseRows, 1, 3)).toEqual([rows[1]])
    expect(removeRowsByTwoIdentityValuesLazily(rows, undefined, 1, 3)).toEqual([rows[1]])
    expect(removeRowsByTwoIdentityValuesLazily(rows, undefined, 4, 5)).toBeUndefined()
    expect(removeRowsByTwoIdentityValuesLazily(sparseRows, undefined, 1, 3)).toEqual([rows[1]])

    const nextRows = [
      rows[0],
      undefined,
      rows[1],
      rows[2],
    ] as unknown as TestRow[]

    expect(removeRowsByTwoIdentityValuesLazily(rows, nextRows, 1, 3)).toBe(nextRows)
    expect(nextRows).toEqual([rows[1]])
  })

  it('skips sparse rows while scanning single identity removals', () => {
    const sparseRows = [
      rows[0],
      undefined,
      rows[1],
      rows[2],
    ] as unknown as readonly TestRow[]
    const sparseQuery = createQuery({
      result: sparseRows,
      rowIdentityIndex: undefined,
    })

    expect(removeRowByIdentityValueFromQueryRows(sparseRows, sparseQuery, 1)).toEqual([
      rows[1],
      rows[2],
    ])
    expect(removeRowByIdentityValueFromQueryRowsLazily(sparseRows, undefined, sparseQuery, 1)).toEqual([
      rows[1],
      rows[2],
    ])

    const duplicateSparseRows = [
      rows[0],
      undefined,
      rows[0],
      rows[1],
    ] as unknown as readonly TestRow[]
    const duplicateSparseQuery = createQuery({
      result: duplicateSparseRows,
    })

    expect(removeRowByIdentityValueFromQueryRows(duplicateSparseRows, duplicateSparseQuery, 1)).toEqual([
      rows[1],
    ])
    expect(removeRowByIdentityValueFromQueryRowsLazily(duplicateSparseRows, undefined, duplicateSparseQuery, 1)).toEqual([
      rows[1],
    ])
  })

  it('caches mutation exact-id row scans in the row patch context', () => {
    const context = createRowPatchContext({
      exactQueryId: 2,
    })
    const mutation = createMutation({
      previousRows: [
        { id: 1, title: 'Previous' },
      ],
      rows: [
        { id: 2, title: 'Current' },
      ],
    })

    expect(readMutationRowsContainExactQueryId(context, mutation)).toBe(true)
    expect(context.rowsContainExactQueryIdCached).toBe(true)
    expect(context.rowsContainExactQueryId).toBe(true)

    expect(readMutationRowsContainExactQueryId(context, createMutation({
      rows: [
        { id: 3, title: 'Ignored because cached' },
      ],
    }))).toBe(true)

    expect(readPreviousMutationRowsContainExactQueryId(context, mutation)).toBe(false)
    expect(context.previousRowsContainExactQueryIdCached).toBe(true)
    expect(context.previousRowsContainExactQueryId).toBe(false)

    const malformedContext = createRowPatchContext({
      exactQueryId: 1,
    })
    expect(readMutationRowsContainExactQueryId(malformedContext, createMutation({
      rows: [
        { title: 'Missing identity' },
      ],
    }))).toBeUndefined()
  })

  it('treats missing mutation rows as empty exact-id scans', () => {
    const currentContext = createRowPatchContext({
      exactQueryId: 2,
    })
    const previousContext = createRowPatchContext({
      exactQueryId: 2,
    })

    expect(readMutationRowsContainExactQueryId(currentContext, createMutation())).toBe(false)
    expect(readPreviousMutationRowsContainExactQueryId(previousContext, createMutation())).toBe(false)
    expect(mutationRowsContainExactId(undefined, 2)).toBe(false)
  })

  it('finds row indexes through indexed and scanned identity paths', () => {
    const indexedQuery = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
      ]),
    })
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 1, title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]
    const duplicateQuery = createQuery({
      result: duplicateRows,
    })

    expect(findRowIndexByIdentity(rows, indexedQuery, 2)).toBe(1)
    expect(findRowIndexByIdentity(rows, indexedQuery, 3)).toBeUndefined()
    expect(findRowIndexByIdentity(duplicateRows, duplicateQuery, 1)).toBe(DUPLICATE_ROW_IDENTITY)
    expect(findRowIndexByIdentity(duplicateRows, duplicateQuery, 2)).toBeUndefined()
  })
})

describe('@holo-js/realtime stable window patch checks', () => {
  it('allows stable update patches when changed values do not touch predicate or order columns', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(canPatchStableWindowMutationWithoutBackfill(
      query,
      createMutation(),
      createMetadata(),
    )).toBe(true)
  })

  it('rejects updates that change stable predicate or order columns', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(canPatchStableWindowMutationWithoutBackfill(
      query,
      createMutation({
        values: { priority: 5 },
        valueKeys: ['priority'],
      }),
      createMetadata({
        valueKeys: ['priority'],
      }),
    )).toBe(false)
  })

  it('allows upserts only when returned rows preserve stable columns from previous rows', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(canPatchStableWindowMutationWithoutBackfill(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: [{ id: 1, status: 'open', priority: 1 }],
        rows: [{ id: 1, status: 'open', priority: 1, title: 'Updated' }],
      }),
      createMetadata(),
    )).toBe(true)
    expect(canPatchStableWindowMutationWithoutBackfill(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: [{ id: 1, status: 'open', priority: 1 }],
        rows: [{ id: 1, status: 'closed', priority: 1, title: 'Updated' }],
      }),
      createMetadata(),
    )).toBe(false)
    expect(canPatchStableWindowMutationWithoutBackfill(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: [{ id: 1, status: 'open', priority: 1 }],
        rows: [{ status: 'open', priority: 1, title: 'Updated' }],
      }),
      createMetadata(),
    )).toBe(false)
  })

  it('handles stable-window edge cases without treating unsafe upserts as patchable', () => {
    expect(canPatchStableWindowMutationWithoutBackfill(
      createQuery(),
      createMutation({
        kind: 'upsert',
      }),
      createMetadata(),
    )).toBe(true)
    expect(canPatchStableWindowMutationWithoutBackfill(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'upsert',
        previousRows: [{ id: 1, status: 'open' }],
        rows: undefined,
      }),
      createMetadata(),
    )).toBe(false)
    expect(canPatchStableWindowMutationWithoutBackfill(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'upsert',
        previousRows: [{ id: 1, priority: 1 }, { id: 1, priority: 1 }],
        rows: [{ id: 1, priority: 1 }, { id: 1, priority: 1 }],
      }),
      createMetadata(),
    )).toBe(false)
    expect(canPatchStableWindowMutationWithoutBackfill(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'upsert',
        previousRows: [{ id: 1, priority: 1 }],
        rows: [{ id: 1, title: 'Updated' }],
      }),
      createMetadata(),
    )).toBe(false)
  })
})
