import { describe, expect, it } from 'vitest'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import {
  MISSING_PROJECTED_IDENTITY,
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type RowPatchContext,
  type RowsOrderState,
} from '../src/runtime/query-state'
import {
  upsertOrderedPatchRowLazily,
  upsertPatchRowLazily,
  upsertProjectedPatchRowLazily,
} from '../src/runtime/query-row-upsert'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, title: 'First', priority: 1 }),
  Object.freeze({ id: 2, title: 'Second', priority: 2 }),
  Object.freeze({ id: 3, title: 'Third', priority: 3 }),
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
    projectedIdentityColumn: 'id',
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

function createOrderState(): RowsOrderState {
  return { preserved: true }
}

describe('@holo-js/realtime row upsert patch helpers', () => {
  it('uses identity indexes for plain upsert replacements, appends, and no-op patches', () => {
    const query = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })

    expect(upsertPatchRowLazily(rows, undefined, { id: 2, title: 'Updated' }, ['title'], query)).toEqual([
      rows[0],
      { id: 2, title: 'Updated', priority: 2 },
      rows[2],
    ])
    expect(upsertPatchRowLazily(rows, undefined, { id: 4, title: 'Fourth' }, undefined, query)).toEqual([
      ...rows,
      { id: 4, title: 'Fourth' },
    ])
    expect(upsertPatchRowLazily(rows, undefined, { id: 2, title: 'Second' }, ['title'], query)).toBeUndefined()
    expect(upsertPatchRowLazily(rows, undefined, { id: 2, title: 'Updated' }, undefined, createQuery({
      rowIdentityIndex: new Map([[2, 9]]),
    }))).toEqual([
      rows[0],
      { id: 2, title: 'Updated', priority: 2 },
      rows[2],
    ])
  })

  it('mutates provided plain upsert buffers and appends rows without identities', () => {
    const nextRows = [...rows]

    expect(upsertPatchRowLazily(rows, undefined, { title: 'Anonymous' })).toEqual([
      ...rows,
      { title: 'Anonymous' },
    ])
    expect(upsertPatchRowLazily(rows, nextRows, { id: 2, title: 'Updated' })).toBe(nextRows)
    expect(nextRows).toEqual([
      rows[0],
      { id: 2, title: 'Updated', priority: 2 },
      rows[2],
    ])
    expect(upsertPatchRowLazily(rows, nextRows, { title: 'Anonymous' })).toBe(nextRows)
    expect(nextRows).toEqual([
      rows[0],
      { id: 2, title: 'Updated', priority: 2 },
      rows[2],
      { title: 'Anonymous' },
    ])
  })

  it('relocates ordered indexed upserts and skips rows past a full ordered window', () => {
    const query = createQuery({
      limit: 3,
      orderBy: [{ column: 'priority', direction: 'asc' }],
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const context = createContext({
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
    })
    const orderState = createOrderState()

    expect(upsertOrderedPatchRowLazily(
      rows,
      undefined,
      query,
      context,
      { id: 2, title: 'Updated', priority: 0 },
      ['priority'],
      [1],
      orderState,
    )).toEqual([
      { id: 2, title: 'Updated', priority: 0 },
      rows[0],
      rows[2],
    ])
    expect(orderState.preserved).toBe(true)

    expect(upsertOrderedPatchRowLazily(
      rows,
      undefined,
      query,
      context,
      { id: 4, title: 'Fourth', priority: 4 },
      ['priority'],
      [1],
      createOrderState(),
    )).toBeUndefined()
  })

  it('marks ordered state unpreserved when ordered upserts cannot be safely inserted', () => {
    const unorderedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 2, title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      result: unorderedRows,
      rowIdentityIndex: new Map([[2, 1]]),
    })
    const context = createContext({
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
    })
    const orderState = createOrderState()

    expect(upsertOrderedPatchRowLazily(
      unorderedRows,
      undefined,
      query,
      context,
      { id: 2, title: 'Updated' },
      ['priority'],
      [1],
      orderState,
    )).toEqual([
      unorderedRows[0],
      { id: 2, title: 'Updated' },
    ])
    expect(orderState.preserved).toBe(false)
  })

  it('reuses ordered upsert buffers for no-op and changed rows', () => {
    const query = createQuery()
    const context = createContext({
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
    })
    const nextRows = [...rows]
    const changedOrderState = createOrderState()

    expect(upsertOrderedPatchRowLazily(
      rows,
      nextRows,
      query,
      context,
      { id: 2, title: 'Second', priority: 2 },
      ['priority'],
      [1],
      createOrderState(),
    )).toBe(nextRows)
    expect(upsertOrderedPatchRowLazily(
      rows,
      nextRows,
      query,
      context,
      { id: 3, title: 'Changed', priority: 0 },
      ['priority'],
      [1],
      changedOrderState,
    )).toBe(nextRows)
    expect(upsertOrderedPatchRowLazily(
      rows,
      nextRows,
      query,
      context,
      { title: 'Anonymous', priority: 4 },
      ['priority'],
      [1],
      createOrderState(),
    )).toEqual([
      ...nextRows,
      { title: 'Anonymous', priority: 4 },
    ])
    expect(changedOrderState.preserved).toBe(false)
    expect(nextRows).toEqual([
      rows[0],
      rows[1],
      { id: 3, title: 'Changed', priority: 0 },
    ])
  })

  it('falls back to ordered scanning when unique identity indexes are unavailable', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First', priority: 1 }),
      Object.freeze({ id: 1, title: 'Duplicate', priority: 2 }),
      Object.freeze({ id: 2, title: 'Second', priority: 3 }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      result: duplicateRows,
    })
    const context = createContext({
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
    })
    const orderState = createOrderState()

    expect(upsertOrderedPatchRowLazily(
      duplicateRows,
      undefined,
      query,
      context,
      { id: 2, title: 'Updated', priority: 4 },
      ['priority'],
      [1],
      orderState,
    )).toEqual([
      duplicateRows[0],
      duplicateRows[1],
      { id: 2, title: 'Updated', priority: 4 },
    ])
    expect(orderState.preserved).toBe(false)
  })

  it('falls back to plain scanning when unique identity indexes are unavailable', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First', priority: 1 }),
      Object.freeze({ id: 1, title: 'Duplicate', priority: 2 }),
      Object.freeze({ id: 2, title: 'Second', priority: 3 }),
    ]) satisfies readonly TestRow[]

    expect(upsertPatchRowLazily(
      duplicateRows,
      undefined,
      { id: 2, title: 'Updated' },
      ['title'],
      createQuery({ result: duplicateRows }),
    )).toEqual([
      duplicateRows[0],
      duplicateRows[1],
      { id: 2, title: 'Updated', priority: 3 },
    ])
  })

  it('patches projected indexed upserts and appends projected rows', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 2, title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
      ]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })
    const identityCache = new WeakMap<Readonly<Record<string, unknown>>, unknown>()

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { id: 2, title: 'Updated', priority: 2 },
      identityCache,
      [],
      [],
      createOrderState(),
    )).toEqual([
      projectedRows[0],
      { id: 2, title: 'Updated' },
    ])
    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { id: 3, title: 'Third', priority: 3 },
      identityCache,
      [],
      [],
      createOrderState(),
    )).toEqual([
      ...projectedRows,
      { id: 3, title: 'Third' },
    ])
  })

  it('appends projected rows without identities when selection data is complete', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ title: 'First' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
    })
    const context = createContext({
      hasProjectedSelections: true,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      selectionColumns: ['title'],
      selectionResultKeys: ['title'],
    })

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { title: 'Second' },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toEqual([
      projectedRows[0],
      { title: 'Second' },
    ])
  })

  it('relocates projected indexed upserts when selected order columns change', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First', priority: 1 }),
      Object.freeze({ id: 2, title: 'Second', priority: 2 }),
      Object.freeze({ id: 3, title: 'Third', priority: 3 }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
      selectionColumns: ['id', 'title', 'priority'],
      selectionResultKeys: ['id', 'title', 'priority'],
    })

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { id: 2, title: 'Updated', priority: 0 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      ['priority'],
      [1],
      createOrderState(),
    )).toEqual([
      { id: 2, title: 'Updated', priority: 0 },
      projectedRows[0],
      projectedRows[2],
    ])
  })

  it('returns missing projected identity when projected upsert data cannot identify or project rows', () => {
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })
    const missingIdentityContext = createContext({
      hasProjectedSelections: true,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })

    expect(upsertProjectedPatchRowLazily(
      rows,
      undefined,
      createQuery(),
      context,
      { id: 2 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)
    expect(upsertProjectedPatchRowLazily(
      rows,
      undefined,
      createQuery(),
      missingIdentityContext,
      { id: 4 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('returns missing projected identity when indexed append rows cannot be projected', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
      rowIdentityIndex: new Map([[1, 0]]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { id: 2 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('returns missing projected identity when current projected rows lack selected data', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 1 }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
    })
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { id: 2, title: 'Updated' },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('returns missing projected identity when indexed current projected rows cannot merge selected data', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1 }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
      rowIdentityIndex: new Map([[1, 0]]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { id: 1 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('returns missing projected identity when cached identities point at unmergeable rows', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
      rowIdentityIndex: new Map([[1, 0]]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })
    const row = Object.freeze({ id: 1 })
    const identityCache = new WeakMap<Readonly<Record<string, unknown>>, unknown>([
      [row, 1],
    ])

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      row,
      identityCache,
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      createQuery({ result: projectedRows }),
      context,
      row,
      identityCache,
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)

    const duplicateProjectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 1, title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]
    expect(upsertProjectedPatchRowLazily(
      duplicateProjectedRows,
      undefined,
      createQuery({ result: duplicateProjectedRows }),
      context,
      row,
      identityCache,
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('returns missing projected identity when cached append rows cannot be projected', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
      rowIdentityIndex: new Map([[1, 0]]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })
    const row = Object.freeze({ id: 2 })
    const identityCache = new WeakMap<Readonly<Record<string, unknown>>, unknown>([
      [row, 2],
    ])

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      row,
      identityCache,
      [],
      [],
      createOrderState(),
    )).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('marks projected indexed order unpreserved when relocation cannot preserve order', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First', priority: 1 }),
      Object.freeze({ id: 2, title: 'Second', priority: 2 }),
      Object.freeze({ id: 3, title: 'Third' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: projectedRows,
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
      selectionColumns: ['id', 'title', 'priority'],
      selectionResultKeys: ['id', 'title', 'priority'],
    })
    const orderState = createOrderState()

    expect(upsertProjectedPatchRowLazily(
      projectedRows,
      undefined,
      query,
      context,
      { id: 2, title: 'Updated', priority: 0 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      ['priority'],
      [1],
      orderState,
    )).toEqual([
      projectedRows[0],
      { id: 2, title: 'Updated', priority: 0 },
      projectedRows[2],
    ])
    expect(orderState.preserved).toBe(false)
  })

  it('handles projected indexed no-op and invalid index paths', () => {
    const query = createQuery({
      rowIdentityIndex: new Map([[2, 1]]),
    })
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title', 'priority'],
      selectionResultKeys: ['id', 'title', 'priority'],
    })

    expect(upsertProjectedPatchRowLazily(
      rows,
      undefined,
      query,
      context,
      { id: 2, title: 'Second', priority: 2 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toBeUndefined()
    expect(upsertProjectedPatchRowLazily(
      rows,
      undefined,
      createQuery({
        rowIdentityIndex: new Map([[2, 9]]),
      }),
      context,
      { id: 2, title: 'Updated', priority: 2 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toEqual([
      rows[0],
      { id: 2, title: 'Updated', priority: 2 },
      rows[2],
    ])
  })

  it('falls back from projected indexed sparse row slots when selected data is complete', () => {
    const sparseRows = [
      rows[0],
    ] as TestRow[]
    sparseRows.length = 2
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title', 'priority'],
      selectionResultKeys: ['id', 'title', 'priority'],
    })

    expect(upsertProjectedPatchRowLazily(
      sparseRows,
      undefined,
      createQuery({
        result: sparseRows,
        rowIdentityIndex: new Map([[2, 1]]),
      }),
      context,
      { id: 2, title: 'Updated', priority: 2 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toEqual([
      rows[0],
      { id: 2, title: 'Updated', priority: 2 },
    ])
  })

  it('mutates projected upsert buffers and marks order changes', () => {
    const context = createContext({
      hasProjectedSelections: true,
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
      selectionColumns: ['id', 'title', 'priority'],
      selectionResultKeys: ['id', 'title', 'priority'],
    })
    const nextRows = [...rows]
    const orderState = createOrderState()

    expect(upsertProjectedPatchRowLazily(
      rows,
      nextRows,
      createQuery(),
      context,
      { id: 2, title: 'Updated', priority: 0 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      ['priority'],
      [1],
      orderState,
    )).toBe(nextRows)
    expect(orderState.preserved).toBe(false)
    expect(nextRows).toEqual([
      rows[0],
      { id: 2, title: 'Updated', priority: 0 },
      rows[2],
    ])
  })

  it('reuses projected upsert buffers for no-op rows', () => {
    const context = createContext({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title', 'priority'],
      selectionResultKeys: ['id', 'title', 'priority'],
    })
    const nextRows = [...rows]

    expect(upsertProjectedPatchRowLazily(
      rows,
      nextRows,
      createQuery(),
      context,
      { id: 2, title: 'Second', priority: 2 },
      new WeakMap<Readonly<Record<string, unknown>>, unknown>(),
      [],
      [],
      createOrderState(),
    )).toBe(nextRows)
    expect(nextRows).toEqual(rows)
  })
})
