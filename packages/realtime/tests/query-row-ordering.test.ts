import { describe, expect, it } from 'vitest'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import {
  applySortedRowsWindow,
  compareRowsByOrderMetadata,
  readOrderedRows,
  rowHasOrderColumns,
  sortRowsByOrderMetadata,
  sortRowsForQuery,
} from '../src/runtime/query-row-ordering'
import {
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type RowPatchContext,
  type RowsOrderState,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, priority: 3, status: 'open', title: 'Third' }),
  Object.freeze({ id: 2, priority: 1, status: 'open', title: 'First' }),
  Object.freeze({ id: 3, priority: 2, status: 'closed', title: 'Second' }),
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

function createContext(overrides: Partial<RowPatchContext> = {}): RowPatchContext {
  return {
    exactMutationId: NO_EXACT_ID_PREDICATE,
    exactQueryId: NO_EXACT_ID_PREDICATE,
    hasProjectedSelections: false,
    mutationPredicates: {
      exactId: NO_EXACT_ID_PREDICATE,
      predicateCount: 0,
      predicates: [],
    },
    orderColumns: [],
    orderMultipliers: [],
    projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
    projectedSelectionChanged: false,
    queryOrderChanged: false,
    queryPredicates: {
      exactId: NO_EXACT_ID_PREDICATE,
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

function createOrderState(preserved: boolean): RowsOrderState {
  return { preserved }
}

describe('@holo-js/realtime row ordering helpers', () => {
  it('preserves frozen rows when no order columns are configured', () => {
    expect(sortRowsByOrderMetadata(rows, [], [])).toBe(rows)

    const mutableRows = [...rows]
    const sortedRows = sortRowsByOrderMetadata(mutableRows, [], [])

    expect(sortedRows).toBe(mutableRows)
    expect(Object.isFrozen(sortedRows)).toBe(true)
  })

  it('handles empty and single-row ordered results', () => {
    const emptyRows: readonly TestRow[] = []
    const singleRow = Object.freeze([
      Object.freeze({ id: 1, priority: 1, title: 'Only' }),
    ]) satisfies readonly TestRow[]

    expect(sortRowsByOrderMetadata(emptyRows, ['priority'], [1])).toBe(emptyRows)
    expect(Object.isFrozen(emptyRows)).toBe(true)
    expect(sortRowsByOrderMetadata(singleRow, ['priority'], [1])).toBe(singleRow)
    expect(sortRowsByOrderMetadata(singleRow, ['priority', 'title'], [1, 1])).toBe(singleRow)
    const mutableSingleRow = [
      Object.freeze({ id: 1, priority: 1, title: 'Only' }),
    ] satisfies readonly TestRow[]
    const sortedMutableSingleRow = sortRowsByOrderMetadata(mutableSingleRow, ['priority', 'title'], [1, 1])

    expect(sortedMutableSingleRow).toBe(mutableSingleRow)
    expect(Object.isFrozen(sortedMutableSingleRow)).toBe(true)
    expect(sortRowsByOrderMetadata(singleRow, ['missing'], [1])).toBeUndefined()
    expect(sortRowsByOrderMetadata(singleRow, ['priority', 'missing'], [1, 1])).toBeUndefined()
    expect(sortRowsByOrderMetadata([undefined] as unknown as readonly TestRow[], ['priority'], [1])).toBeUndefined()
    expect(sortRowsByOrderMetadata(singleRow, ['', 'priority'], [1, 1])).toBeUndefined()
  })

  it('sorts single-column rows in ascending and descending order', () => {
    expect(sortRowsByOrderMetadata(rows, ['priority'], [1])).toEqual([
      rows[1],
      rows[2],
      rows[0],
    ])
    expect(sortRowsByOrderMetadata(rows, ['priority'], [-1])).toEqual([
      rows[0],
      rows[2],
      rows[1],
    ])
    expect(sortRowsByOrderMetadata(rows, ['priority'], [])).toEqual([
      rows[1],
      rows[2],
      rows[0],
    ])
    expect(sortRowsByOrderMetadata(rows, [''], [1])).toBeUndefined()

    const sortedRows = Object.freeze([
      rows[1]!,
      rows[2]!,
      rows[0]!,
    ]) satisfies readonly TestRow[]

    expect(sortRowsByOrderMetadata(sortedRows, ['priority'], [1])).toBe(sortedRows)
  })

  it('sorts multi-column rows and rejects invalid ordering data', () => {
    const multiRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, title: 'Beta' }),
      Object.freeze({ id: 2, priority: 1, title: 'Alpha' }),
      Object.freeze({ id: 3, priority: 2, title: 'Gamma' }),
    ]) satisfies readonly TestRow[]

    expect(sortRowsByOrderMetadata(multiRows, ['priority', 'title'], [1, 1])).toEqual([
      multiRows[1],
      multiRows[0],
      multiRows[2],
    ])
    expect(sortRowsByOrderMetadata(multiRows, ['priority', 'title'], [1])).toEqual([
      multiRows[1],
      multiRows[0],
      multiRows[2],
    ])
    const sortedMultiRows = Object.freeze([
      Object.freeze({ id: 2, priority: 1, title: 'Alpha' }),
      Object.freeze({ id: 1, priority: 1, title: 'Beta' }),
      Object.freeze({ id: 3, priority: 2, title: 'Gamma' }),
    ]) satisfies readonly TestRow[]

    expect(sortRowsByOrderMetadata(sortedMultiRows, ['priority', 'title'], [1, 1])).toBe(sortedMultiRows)
    expect(sortRowsByOrderMetadata([
      undefined,
      Object.freeze({ id: 2, priority: 1, title: 'Beta' }),
    ] as unknown as readonly TestRow[], ['priority', 'title'], [1, 1])).toBeUndefined()
    expect(sortRowsByOrderMetadata([
      Object.freeze({ id: 1, priority: 1 }),
      Object.freeze({ id: 2, priority: 1, title: 'Beta' }),
    ], ['priority', 'title'], [1, 1])).toBeUndefined()
    expect(sortRowsByOrderMetadata([
      Object.freeze({ id: 1, priority: 1, title: 'Alpha' }),
      Object.freeze({ id: 2, priority: 1 }),
    ], ['priority', 'title'], [1, 1])).toBeUndefined()
    expect(sortRowsByOrderMetadata([
      Object.freeze({ id: 1, priority: {} }),
      Object.freeze({ id: 2, priority: 1 }),
    ], ['priority'], [1])).toBeUndefined()
    expect(sortRowsByOrderMetadata([
      Object.freeze({ id: 1, priority: 1 }),
      undefined,
    ] as unknown as readonly TestRow[], ['priority'], [1])).toBeUndefined()
    expect(sortRowsByOrderMetadata([
      Object.freeze({ id: 1, priority: 1, title: 'Alpha' }),
      undefined,
    ] as unknown as readonly TestRow[], ['priority', 'title'], [1, 1])).toBeUndefined()
    expect(sortRowsByOrderMetadata([
      Object.freeze({ id: 1, priority: 1, title: 'Alpha' }),
      Object.freeze({ id: 2, priority: {}, title: 'Beta' }),
    ], ['priority', 'title'], [1, 1])).toBeUndefined()
  })

  it('keeps equal multi-column rows stable while sorting later unordered rows', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 2, title: 'Beta' }),
      Object.freeze({ id: 2, priority: 1, title: 'Alpha' }),
      Object.freeze({ id: 3, priority: 1, title: 'Alpha' }),
    ]) satisfies readonly TestRow[]

    expect(sortRowsByOrderMetadata(duplicateRows, ['priority', 'title'], [1, 1])).toEqual([
      duplicateRows[1],
      duplicateRows[2],
      duplicateRows[0],
    ])
  })

  it('sorts rows through query metadata', () => {
    expect(sortRowsForQuery(rows, createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toEqual([
      rows[1],
      rows[2],
      rows[0],
    ])
    expect(sortRowsForQuery(rows, createQuery({
      orderBy: [{ column: 'priority', direction: 'desc' }],
    }))).toEqual([
      rows[0],
      rows[2],
      rows[1],
    ])
  })

  it('applies single, limited, unwindowed, and invalid row windows', () => {
    expect(applySortedRowsWindow(rows, createQuery({
      isSingleId: true,
      limit: 1,
      predicates: [{ column: 'id', operator: '=', value: 1 }],
    }))).toEqual([rows[0]])
    expect(applySortedRowsWindow([rows[0]!], createQuery({
      isSingleId: true,
      limit: 1,
      predicates: [{ column: 'id', operator: '=', value: 1 }],
    }))).toEqual([rows[0]])
    expect(applySortedRowsWindow(rows, createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toEqual([
      rows[0],
      rows[1],
    ])
    const mutableRows = [
      Object.freeze({ id: 1, priority: 1 }),
      Object.freeze({ id: 2, priority: 2 }),
    ] satisfies readonly TestRow[]
    const windowedMutableRows = applySortedRowsWindow(mutableRows, createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))

    expect(windowedMutableRows).toBe(mutableRows)
    expect(Object.isFrozen(windowedMutableRows)).toBe(true)
    expect(applySortedRowsWindow(rows, createQuery())).toBe(rows)
    expect(applySortedRowsWindow(rows, createQuery({
      limit: 2,
    }))).toBeUndefined()
    expect(applySortedRowsWindow(rows, createQuery({
      rowWindowMode: 'limited',
    }))).toBeUndefined()
    expect(applySortedRowsWindow(rows, createQuery({
      offset: 1,
    }))).toBeUndefined()
  })

  it('reads ordered rows from preserved and unpreserved order states', () => {
    expect(readOrderedRows(rows, createContext(), createOrderState(true))).toBe(rows)
    expect(readOrderedRows(rows, createContext({
      orderColumns: ['priority'],
      orderMultipliers: [1],
    }), createOrderState(false))).toEqual([
      rows[1],
      rows[2],
      rows[0],
    ])
    expect(readOrderedRows(rows, createContext({
      orderColumns: ['missing'],
      orderMultipliers: [1],
    }), createOrderState(false))).toBeUndefined()
  })

  it('checks row order columns and compares ordered rows', () => {
    expect(rowHasOrderColumns(rows[0]!, ['priority', 'title'])).toBe(true)
    expect(rowHasOrderColumns(rows[0]!, ['priority', 'missing'])).toBe(false)
    expect(compareRowsByOrderMetadata(rows[1]!, rows[2]!, ['priority'], [1])).toBe(-1)
    expect(compareRowsByOrderMetadata(rows[1]!, rows[2]!, ['priority'], [])).toBe(-1)
    expect(compareRowsByOrderMetadata(rows[1]!, rows[2]!, ['priority'], [-1])).toBe(1)
    expect(compareRowsByOrderMetadata(rows[1]!, rows[1]!, ['priority'], [1])).toBe(0)
    expect(compareRowsByOrderMetadata(rows[1]!, rows[2]!, ['missing'], [1])).toBeUndefined()
    expect(compareRowsByOrderMetadata(
      { priority: {} },
      { priority: 1 },
      ['priority'],
      [1],
    )).toBeUndefined()
    expect(compareRowsByOrderMetadata(rows[1]!, rows[2]!, ['', 'priority'], [1, 1])).toBeUndefined()
  })
})
