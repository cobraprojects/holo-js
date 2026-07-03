import { describe, expect, it } from 'vitest'
import {
  NO_EXACT_ID_PREDICATE,
  type PredicateMatchContext,
} from '../src/runtime/predicate-matching'
import { applyProjectedMutationToRows } from '../src/runtime/query-row-projected-patching'
import {
  mergeProjectedMutationValuesWithContext,
  mergeProjectedPatchRowAndMutationValuesWithContext,
  mergeProjectedPatchRowWithContext,
  projectedRowIdentity,
  projectRowWithContext,
  readProjectedRowIdentity,
  readProjectedRowIdentityCache,
} from '../src/runtime/query-row-projection'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import {
  MISSING_PROJECTED_IDENTITY,
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type RowPatchContext,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, title: 'First', status: 'open', priority: 1 }),
  Object.freeze({ id: 2, title: 'Second', status: 'open', priority: 2 }),
  Object.freeze({ id: 3, title: 'Third', status: 'closed', priority: 3 }),
]) satisfies readonly TestRow[]

const emptyPredicateContext = Object.freeze({
  exactId: NO_EXACT_ID_PREDICATE,
  predicateCount: 0,
  predicates: [],
}) satisfies PredicateMatchContext

const openPredicateContext = Object.freeze({
  exactId: NO_EXACT_ID_PREDICATE,
  firstPredicate: { column: 'status', operator: '=', value: 'open' },
  predicateCount: 1,
  predicates: [{ column: 'status', operator: '=', value: 'open' }],
}) satisfies PredicateMatchContext

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    orderBy: [],
    patchable: true,
    predicates: [],
    result: rows,
    rowIdentityIndex: new Map([
      [1, 0],
      [2, 1],
      [3, 2],
    ]),
    tableName: 'posts',
    ...overrides,
  }
}

function createMutation(overrides: Partial<DatabaseMutationEvent> = {}): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind: 'update',
    predicates: [],
    rows: [],
    tableName: 'posts',
    ...overrides,
  }
}

function createContext(overrides: Partial<RowPatchContext> = {}): RowPatchContext {
  return {
    exactMutationId: NO_EXACT_ID_PREDICATE,
    exactQueryId: NO_EXACT_ID_PREDICATE,
    hasProjectedSelections: true,
    mutationPredicates: emptyPredicateContext,
    orderColumns: [],
    orderMultipliers: [],
    projectedIdentityColumn: 'id',
    projectedSelectionChanged: true,
    queryOrderChanged: false,
    queryPredicates: emptyPredicateContext,
    selectionColumns: ['id', 'title', 'status', 'priority'],
    selectionResultKeys: ['id', 'title', 'status', 'priority'],
    usesExactQueryIdAsProjectedIdentity: false,
    valueKeys: ['title'],
    ...overrides,
  }
}

describe('@holo-js/realtime projected row helpers', () => {
  it('returns original rows and row ids for non-projected contexts', () => {
    const row = Object.freeze({ id: 10, title: 'Visible', hidden: 'secret' })
    const context = createContext({
      hasProjectedSelections: false,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      selectionColumns: [],
      selectionResultKeys: [],
    })

    expect(projectRowWithContext(context, row)).toBe(row)
    expect(projectedRowIdentity(context, row)).toBe(10)
    expect(mergeProjectedPatchRowWithContext(
      row,
      context,
      Object.freeze({ hidden: 'changed', title: 'Updated' }),
    )).toEqual({
      id: 10,
      hidden: 'changed',
      title: 'Updated',
    })
  })

  it('projects selected fields and rejects incomplete projected rows', () => {
    const context = createContext({
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'label'],
    })

    expect(projectRowWithContext(context, Object.freeze({
      hidden: 'secret',
      id: 1,
      title: 'Projected',
    }))).toEqual({
      id: 1,
      label: 'Projected',
    })
    expect(projectRowWithContext(context, Object.freeze({
      id: 1,
    }))).toBeUndefined()
    expect(projectRowWithContext(createContext({
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id'],
    }), Object.freeze({
      id: 1,
      title: 'Projected',
    }))).toBeUndefined()
  })

  it('reads projected identities through selected columns and exact query ids', () => {
    expect(projectedRowIdentity(createContext({
      projectedIdentityColumn: 'id',
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    }), Object.freeze({
      id: 2,
      title: 'Projected',
    }))).toBe(2)
    expect(projectedRowIdentity(createContext({
      projectedIdentityColumn: 'id',
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    }), Object.freeze({
      id: 2,
    }))).toBe(MISSING_PROJECTED_IDENTITY)
    expect(projectedRowIdentity(createContext({
      exactQueryId: 7,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      usesExactQueryIdAsProjectedIdentity: true,
    }), Object.freeze({
      title: 'Single row',
    }))).toBe(7)
    expect(projectedRowIdentity(createContext({
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      usesExactQueryIdAsProjectedIdentity: false,
    }), Object.freeze({
      title: 'Unknown identity',
    }))).toBeUndefined()
  })

  it('caches projected identities including undefined identity values', () => {
    const row = Object.freeze({ title: 'No id' })
    const context = createContext({
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      usesExactQueryIdAsProjectedIdentity: false,
    })
    const cache = readProjectedRowIdentityCache(context)

    expect(readProjectedRowIdentity(row, context, undefined)).toBeUndefined()
    expect(readProjectedRowIdentity(row, context, cache)).toBeUndefined()
    expect(readProjectedRowIdentity(row, {
      ...context,
      exactQueryId: 5,
      usesExactQueryIdAsProjectedIdentity: true,
    }, cache)).toBeUndefined()
    expect(readProjectedRowIdentity(Object.freeze({ id: 3, title: 'Cached' }), createContext({
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    }), cache)).toBe(3)
    expect(readProjectedRowIdentityCache(context)).toBe(cache)
  })

  it('merges projected patch rows without leaking hidden fields', () => {
    const current = Object.freeze({
      id: 1,
      label: 'Old',
    })
    const context = createContext({
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'label'],
    })

    expect(mergeProjectedPatchRowWithContext(current, context, Object.freeze({
      hidden: 'secret',
      id: 1,
      title: 'New',
    }))).toEqual({
      id: 1,
      label: 'New',
    })
    expect(mergeProjectedPatchRowWithContext(current, context, Object.freeze({
      hidden: 'secret',
      id: 1,
      title: 'Old',
    }))).toBe(current)
    expect(mergeProjectedPatchRowWithContext(current, context, Object.freeze({
      id: 1,
    }))).toBeUndefined()
  })

  it('merges projected patch rows with mutation values while preserving cached selected fields', () => {
    expect(mergeProjectedPatchRowAndMutationValuesWithContext(
      { id: 1, title: 'First' },
      createContext({
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
        valueKeys: ['title'],
      }),
      { id: 1 },
      { title: 'Updated' },
    )).toEqual({
      id: 1,
      title: 'Updated',
    })

    const unchanged = { id: 1, title: 'Updated' }
    expect(mergeProjectedPatchRowAndMutationValuesWithContext(
      unchanged,
      createContext({
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
        valueKeys: ['title'],
      }),
      { id: 1 },
      { title: 'Updated' },
    )).toBe(unchanged)

    expect(mergeProjectedPatchRowAndMutationValuesWithContext(
      { hidden: 'cached', id: 1, title: 'First' },
      createContext({
        hasProjectedSelections: false,
        selectionColumns: [],
        selectionResultKeys: [],
        valueKeys: ['title'],
      }),
      { id: 1 },
      { title: 'Updated' },
    )).toEqual({
      hidden: 'cached',
      id: 1,
      title: 'Updated',
    })

    expect(mergeProjectedPatchRowAndMutationValuesWithContext(
      { id: 1 },
      createContext({
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
        valueKeys: ['title'],
      }),
      { id: 1 },
      {},
    )).toBeUndefined()

    const cached = { id: 1, title: 'Cached' }
    expect(mergeProjectedPatchRowAndMutationValuesWithContext(
      cached,
      createContext({
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
        valueKeys: [],
      }),
      { id: 1 },
      {},
    )).toBe(cached)

    expect(mergeProjectedPatchRowAndMutationValuesWithContext(
      { id: 1 },
      createContext({
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
        valueKeys: [],
      }),
      { id: 1 },
      {},
    )).toBeUndefined()
  })

  it('merges projected mutation values without requiring unchanged selected values', () => {
    const current = Object.freeze({
      body: 'Body',
      label: 'Old',
    })
    const context = createContext({
      selectionColumns: ['title', 'body'],
      selectionResultKeys: ['label', 'body'],
      valueKeys: ['title'],
    })

    expect(mergeProjectedMutationValuesWithContext(current, context, Object.freeze({
      hidden: 'secret',
      title: 'New',
    }))).toEqual({
      body: 'Body',
      label: 'New',
    })
    expect(mergeProjectedMutationValuesWithContext(current, context, Object.freeze({
      title: 'Old',
    }))).toBe(current)
    expect(mergeProjectedMutationValuesWithContext(current, createContext({
      hasProjectedSelections: false,
      valueKeys: ['title'],
    }), Object.freeze({
      hidden: 'secret',
      title: 'New',
    }))).toEqual({
      body: 'Body',
      label: 'Old',
      title: 'New',
    })
    expect(mergeProjectedMutationValuesWithContext(current, createContext({
      selectionColumns: ['title'],
      selectionResultKeys: [],
      valueKeys: ['title'],
    }), Object.freeze({
      title: 'New',
    }))).toBeUndefined()
    expect(mergeProjectedMutationValuesWithContext(current, context, Object.freeze({
      hidden: 'secret',
    }))).toBeUndefined()
  })
})

describe('@holo-js/realtime projected row patching', () => {
  it('rejects mutations without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        rowIdentityIndex: undefined,
      }),
      createMutation({ rows: [] }),
      createContext(),
    )).toEqual({ patched: false })
  })

  it('patches exact projected mutation values without returned rows', () => {
    const exactContext = createContext({
      exactMutationId: 1,
      exactQueryId: 1,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      selectionColumns: ['title'],
      selectionResultKeys: ['title'],
      usesExactQueryIdAsProjectedIdentity: true,
      valueKeys: ['title'],
    })

    expect(applyProjectedMutationToRows(
      Object.freeze([Object.freeze({ title: 'First' })]),
      createQuery(),
      createMutation({
        rows: undefined,
        values: { title: 'Updated' },
      }),
      exactContext,
    )).toEqual({
      patched: true,
      rows: [{ title: 'Updated' }],
    })
    expect(applyProjectedMutationToRows(
      Object.freeze([Object.freeze({ title: 'First' })]),
      createQuery(),
      createMutation({
        exactId: NO_EXACT_ID_PREDICATE,
        rows: undefined,
        values: { title: 'Updated' },
      }),
      createContext({
        ...exactContext,
        exactMutationId: NO_EXACT_ID_PREDICATE,
      }),
    )).toEqual({ patched: false })
    expect(applyProjectedMutationToRows(
      Object.freeze([Object.freeze({ title: 'First' })]),
      createQuery(),
      createMutation({
        rows: undefined,
        values: { title: 'Updated' },
      }),
      createContext({
        ...exactContext,
        exactMutationId: 2,
      }),
    )).toEqual({ patched: true, unchanged: true })
    expect(applyProjectedMutationToRows(
      Object.freeze([]),
      createQuery(),
      createMutation({
        rows: undefined,
        values: { title: 'Updated' },
      }),
      exactContext,
    )).toEqual({ patched: true, unchanged: true })
    expect(applyProjectedMutationToRows(
      Object.freeze([
        Object.freeze({ title: 'First' }),
        Object.freeze({ title: 'Second' }),
      ]),
      createQuery(),
      createMutation({
        rows: undefined,
        values: { title: 'Updated' },
      }),
      exactContext,
    )).toEqual({ patched: false })
    expect(applyProjectedMutationToRows(
      Object.freeze([Object.freeze({ title: 'First' })]),
      createQuery(),
      createMutation({
        rows: undefined,
        values: { hidden: 'changed' },
      }),
      createContext({
        ...exactContext,
        projectedSelectionChanged: false,
        valueKeys: ['hidden'],
      }),
    )).toEqual({ patched: true, unchanged: true })

    const sparseRows: TestRow[] = []
    sparseRows.length = 1
    expect(applyProjectedMutationToRows(
      sparseRows,
      createQuery(),
      createMutation({
        rows: undefined,
        values: { title: 'Updated' },
      }),
      exactContext,
    )).toEqual({ patched: false })
    expect(applyProjectedMutationToRows(
      Object.freeze([Object.freeze({ title: 'First' })]),
      createQuery(),
      createMutation({
        rows: undefined,
        values: {},
      }),
      exactContext,
    )).toEqual({ patched: false })
    expect(applyProjectedMutationToRows(
      Object.freeze([Object.freeze({ title: 'First' })]),
      createQuery(),
      createMutation({
        rows: undefined,
        values: { title: 'First' },
      }),
      exactContext,
    )).toEqual({ patched: true, unchanged: true })
  })

  it('patches projected previous-row mutation values without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { title: 'Second updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        rows[2]!,
      ],
    })
  })

  it('removes projected previous-row mutation values without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
      ],
    })
  })

  it('patches ordered projected previous-row entries without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 4, priority: 0, status: 'closed', title: 'Fourth' },
        ],
        rows: undefined,
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        rows[0]!,
        rows[1]!,
        rows[2]!,
      ],
    })
  })

  it('keeps projected previous-row mutation values unchanged when they do not affect rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
        rows: undefined,
        values: { title: 'Fourth updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { title: 'Second updated' },
        valueKeys: ['title'],
      }),
      createContext({
        projectedSelectionChanged: false,
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back for unsafe projected previous-row mutation values without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
        rows: undefined,
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { title: 'Second updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { title: 'Second updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back for malformed projected previous-row mutation values without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [undefined as unknown as Readonly<Record<string, unknown>>],
        rows: undefined,
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { priority: {}, status: 'open' },
        valueKeys: ['priority', 'status'],
      }),
      createContext({
        queryPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'status', operator: '=', value: 'open' },
          predicateCount: 2,
          predicates: [
            { column: 'status', operator: '=', value: 'open' },
            { column: 'priority', operator: '>', value: 1 },
          ],
        },
        valueKeys: ['priority', 'status'],
      }),
    )).toEqual({ patched: false })

    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 1, priority: 2, status: 'open', title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]
    expect(applyProjectedMutationToRows(
      duplicateRows,
      createQuery({
        result: duplicateRows,
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
        ],
        rows: undefined,
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open' },
        ],
        rows: undefined,
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
      ],
    })
  })

  it('handles projected previous-row mutation value edge cases without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
        rows: undefined,
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
        rows: undefined,
        values: { priority: 0 },
        valueKeys: ['priority'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        valueKeys: ['priority'],
      }),
    )).toEqual({ patched: false })

    const sparseRows: TestRow[] = [...rows]
    delete sparseRows[1]
    expect(applyProjectedMutationToRows(
      sparseRows,
      createQuery({
        result: sparseRows,
        rowIdentityIndex: new Map([[1, 0], [2, 1], [3, 2]]),
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { title: 'Second updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { status: 'open' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { title: 'Second' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back for unsafe projected previous-row ordering and window states without returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
        rows: undefined,
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title', 'status', 'priority', 'missing'],
        selectionResultKeys: ['id', 'title', 'status', 'priority', 'missing'],
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    const keyedRows = Object.freeze([
      Object.freeze({ key: 'first', missing: 'visible', priority: 1, status: 'open', title: 'First' }),
    ]) satisfies readonly TestRow[]
    expect(applyProjectedMutationToRows(
      keyedRows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: keyedRows,
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { key: 'second', priority: 2, status: 'closed', title: 'Second' },
        ],
        rows: undefined,
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        projectedIdentityColumn: 'key',
        queryPredicates: openPredicateContext,
        selectionColumns: ['key', 'title', 'status', 'priority', 'missing'],
        selectionResultKeys: ['key', 'title', 'status', 'priority', 'missing'],
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
        rows: undefined,
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })

    const invalidOrderRows = Object.freeze([
      Object.freeze({ id: 1, priority: {}, status: 'open', title: 'First' }),
    ]) satisfies readonly TestRow[]
    expect(applyProjectedMutationToRows(
      invalidOrderRows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: invalidOrderRows,
        rowIdentityIndex: new Map([[1, 0]]),
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
        rows: undefined,
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 100,
        offset: 10,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        rowWindowMode: 'limited',
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: undefined,
        rowWindowMode: 'limited',
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { title: 'Second updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })
  })

  it('requests bounded backfill for projected previous-row mutation values that shrink full limited windows', () => {
    expect(applyProjectedMutationToRows(
      rows.slice(0, 2),
      createQuery({
        limit: 2,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: rows.slice(0, 2),
        rowIdentityIndex: new Map([[1, 0], [2, 1]]),
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: undefined,
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      backfill: true,
      patched: true,
      rows: [
        rows[0]!,
      ],
    })
  })

  it('keeps exact-id projected inserts unchanged when mutation ids cannot affect the query', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        rowIdentityIndex: undefined,
      }),
      createMutation({
        exactId: 99,
        kind: 'insert',
        rows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
      }),
      createContext({
        exactMutationId: 99,
        exactQueryId: 1,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('projects matching inserts and keeps nonmatching inserts unchanged', () => {
    const context = createContext({
      queryPredicates: openPredicateContext,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
      }),
      context,
    )).toEqual({
      patched: true,
      rows: [
        ...rows,
        { id: 4, title: 'Fourth' },
      ],
    })
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 5, priority: 5, status: 'closed', title: 'Fifth' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when projected insert predicate matches are unknown', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, priority: 4, title: 'Unknown status' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when projected inserts cannot preserve required ordering', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        selectionColumns: ['id', 'title', 'status'],
        selectionResultKeys: ['id', 'title', 'status'],
      }),
    )).toEqual({ patched: false })
  })

  it('removes projected upsert rows that stop matching predicates', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'upsert',
        rows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
      ],
    })
  })

  it('falls back when nonmatching projected upserts cannot identify rows to remove', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'upsert',
        rows: [
          { priority: 2, status: 'closed', title: 'Missing id' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('deletes projected rows and requests backfill for full ordered limited windows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'delete',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
      }),
      createContext(),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
      ],
    })
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'delete',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
      }),
      createContext(),
    )).toEqual({
      backfill: true,
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
      ],
    })
  })

  it('keeps projected deletes unchanged when exact ids or row identities miss', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        exactId: 99,
        kind: 'delete',
        rows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
      }),
      createContext({
        exactMutationId: 99,
        exactQueryId: 1,
      }),
    )).toEqual({ patched: true, unchanged: true })
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'delete',
        rows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
      }),
      createContext(),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when projected delete rows omit projected identity', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'delete',
        rows: [
          { priority: 2, status: 'open', title: 'Missing id' },
        ],
      }),
      createContext(),
    )).toEqual({ patched: false })
  })

  it('patches stable projected updates without rerunning when selected values change', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
        rows[2]!,
      ],
    })
  })

  it('patches stable projected updates across sparse current rows', () => {
    const sparseRows = [
      rows[0],
      undefined,
      rows[1],
      rows[2],
    ] as unknown as readonly TestRow[]

    expect(applyProjectedMutationToRows(
      sparseRows,
      createQuery({
        result: sparseRows,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
        rows[2]!,
      ],
    })
  })

  it('falls back when stable projected updates find invalid current identities', () => {
    const invalidRows = Object.freeze([
      Object.freeze({ title: 'Missing identity' }),
    ]) satisfies readonly TestRow[]

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { priority: 2, status: 'open' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      invalidRows,
      createQuery({
        result: invalidRows,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext(),
    )).toEqual({ patched: false })
  })

  it('patches non-projected stable rows through the projected applier when selected mode is disabled', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, status: 'open' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        hasProjectedSelections: false,
        queryPredicates: openPredicateContext,
        selectionColumns: [],
        selectionResultKeys: [],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
        rows[2]!,
      ],
    })
  })

  it('patches exact-query-id projected stable rows without selected identity columns', () => {
    const exactRows = Object.freeze([
      Object.freeze({ title: 'Second' }),
    ]) satisfies readonly TestRow[]

    expect(applyProjectedMutationToRows(
      exactRows,
      createQuery({
        result: exactRows,
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { status: 'open' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 2,
        exactQueryId: 2,
        projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
        selectionColumns: ['title'],
        selectionResultKeys: ['title'],
        usesExactQueryIdAsProjectedIdentity: true,
      }),
    )).toEqual({
      patched: true,
      rows: [
        { title: 'Updated' },
      ],
    })
  })

  it('falls back when projected stable rows have no usable identity source', () => {
    const exactRows = Object.freeze([
      Object.freeze({ title: 'Second' }),
    ]) satisfies readonly TestRow[]

    expect(applyProjectedMutationToRows(
      exactRows,
      createQuery({
        result: exactRows,
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { status: 'open' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
        selectionColumns: ['title'],
        selectionResultKeys: ['title'],
        usesExactQueryIdAsProjectedIdentity: false,
      }),
    )).toEqual({ patched: false })
  })

  it('repairs duplicate projected identities through the returned update fallback', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]

    expect(applyProjectedMutationToRows(
      duplicateRows,
      createQuery({
        result: duplicateRows,
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'open', title: 'Updated' },
      ],
    })
  })

  it('keeps sparse stable projected updates unchanged', () => {
    const sparseRows: TestRow[] = []
    sparseRows.length = 1

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: sparseRows,
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext(),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps stable projected updates silent when selected values do not change', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { body: 'Hidden' },
        valueKeys: ['body'],
      }),
      createContext({
        projectedSelectionChanged: false,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps stable projected updates unchanged when nonmatching rows are absent', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 99, priority: 99, status: 'closed', title: 'Outside' },
        ],
        values: { title: 'Outside' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('patches stable projected updates when selected values come from mutation values', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
        rows[2]!,
      ],
    })
  })

  it('falls back when single stable projected update rows cannot be evaluated safely', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, title: 'Missing status' },
        ],
        values: { title: 'Missing status' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: [
          { priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })

    const sparseCurrentRows: TestRow[] = []
    sparseCurrentRows[0] = rows[0]!
    sparseCurrentRows.length = 2

    expect(applyProjectedMutationToRows(
      sparseCurrentRows,
      createQuery({
        result: sparseCurrentRows,
        rowIdentityIndex: new Map([
          [1, 0],
          [2, 1],
        ]),
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
      ],
    })
  })

  it('keeps stable projected updates unchanged when exact metadata excludes returned rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        exactId: 99,
        kind: 'update',
        rows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
        values: { title: 'Outside' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 99,
        exactQueryId: 1,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps stable projected updates unchanged when projected output is identical', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        values: { title: 'Second' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('patches stable projected updates through the returned-row path when identity changes', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
        values: { id: 4, title: 'Fourth' },
        valueKeys: ['id', 'title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
        { id: 4, priority: 4, status: 'open', title: 'Fourth' },
      ],
    })
  })

  it('patches multi-row stable projected updates in place', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First updated' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'open', title: 'First updated' },
        { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        rows[2]!,
      ],
    })
  })

  it('handles multi-row stable projected update edge cases without rerunning supported patches', () => {
    const sparseMutationRows: TestRow[] = []
    sparseMutationRows.length = 2
    sparseMutationRows[1] = { id: 2, priority: 2, status: 'open', title: 'Second updated' }

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: sparseMutationRows,
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        rows[2]!,
      ],
    })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 99, priority: 99, status: 'closed', title: 'Outside' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        rows[2]!,
      ],
    })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        rows[2]!,
      ],
    })
  })

  it('falls back from multi-row stable projected updates when required metadata is unsafe', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 1, priority: 2, status: 'open', title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]

    expect(applyProjectedMutationToRows(
      duplicateRows,
      createQuery({
        result: duplicateRows,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First updated' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'open', title: 'First updated' },
        { id: 2, priority: 2, status: 'open', title: 'Second updated' },
      ],
    })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { priority: 1, status: 'open', title: 'Missing id' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
        { id: 99, priority: 99, status: 'open', title: 'Outside' },
        { id: 2, priority: 2, status: 'open', title: 'Second updated' },
      ],
    })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First updated' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { body: 'Hidden' },
        valueKeys: ['body'],
      }),
      createContext({
        projectedSelectionChanged: false,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, title: 'Missing status' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: [
          { priority: 1, status: 'open', title: 'Missing id' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First updated' },
          { id: 2, priority: 2, status: 'open', title: 'Second updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id'],
      }),
    )).toEqual({ patched: false })
  })

  it('keeps stable projected updates unchanged when exact metadata excludes previous and next rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        exactId: 99,
        kind: 'update',
        previousRows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
        rows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside updated' },
        ],
        values: { title: 'Outside updated' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 99,
        exactQueryId: 1,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps ordered previous-row projected updates unchanged when exact metadata excludes all rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        exactId: 99,
        kind: 'update',
        previousRows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
        rows: [
          { id: 99, priority: 100, status: 'open', title: 'Outside updated' },
        ],
        values: { priority: 100, title: 'Outside updated' },
        valueKeys: ['priority', 'title'],
      }),
      createContext({
        exactMutationId: 99,
        exactQueryId: 1,
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('removes previous projected rows when updates move them out of predicates', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
        ],
        rows: [
          { id: 1, priority: 1, status: 'closed', title: 'First' },
        ],
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[1]!,
        rows[2]!,
      ],
    })
  })

  it('patches previous-row projected updates through fallback removal and upsert', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
        values: { id: 4, title: 'Fourth' },
        valueKeys: ['id', 'title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
        { id: 4, priority: 4, status: 'open', title: 'Fourth' },
      ],
    })
  })

  it('requests bounded backfill for projected upserts that shrink full limited windows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'upsert',
        rows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      backfill: true,
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
      ],
    })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 2,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'upsert',
        rows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when previous projected update rows cannot be identified', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { priority: 1, status: 'open', title: 'First' },
        ],
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First updated' },
        ],
        values: { title: 'First updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when previous-row projected update predicate matches are unknown', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
        ],
        rows: [
          { id: 1, priority: 1, title: 'First updated' },
        ],
        values: { title: 'First updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when previous-row projected updates omit selected values after removal', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
        ],
        rows: [
          { id: 1, priority: 1, status: 'open' },
        ],
        values: { title: 'First updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('keeps previous-row projected updates unchanged when neither removed nor returned rows match', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 99, priority: 99, status: 'closed', title: 'Outside' },
        ],
        rows: [
          { id: 99, priority: 100, status: 'closed', title: 'Outside updated' },
        ],
        values: { title: 'Outside updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps previous-row projected updates unchanged when returned rows already match cached rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
        ],
        values: { title: 'First' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('patches returned update rows without previous rows by replacing projected identities', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'closed', title: 'First' },
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { status: 'closed', title: 'Updated' },
        valueKeys: ['status', 'title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[2]!,
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
      ],
    })
  })

  it('patches returned projected updates through fallback removal and upsert', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
      ],
    })
  })

  it('falls back for returned projected updates without rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: undefined,
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryOrderChanged: true,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when projected identities or selected values are unavailable', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, status: 'open' },
        ],
      }),
      createContext({
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
    )).toEqual({ patched: false })
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, title: 'Updated' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when update metadata is internally inconsistent', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
        ],
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext(),
    )).toEqual({ patched: false })
  })

  it('safely handles returned projected updates without previous row metadata', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { status: 'open', title: 'Missing identity' },
        ],
      }),
      createContext(),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 9, priority: 9, status: 'closed', title: 'Closed' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps returned projected updates unchanged when ordered windows exclude new rows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 99, priority: 99, status: 'open', title: 'Outside' },
        ],
        values: { title: 'Outside' },
        valueKeys: ['title'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when returned projected update rows cannot be ordered locally', () => {
    const projectedRows = Object.freeze([
      Object.freeze({ id: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]

    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, status: 'open' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title', 'status'],
        selectionResultKeys: ['id', 'title', 'status'],
      }),
    )).toEqual({ patched: false })

    expect(applyProjectedMutationToRows(
      projectedRows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: projectedRows,
        rowIdentityIndex: new Map([
          [1, 0],
          [2, 1],
        ]),
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 3, status: 'open', title: 'Updated' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title', 'status'],
        selectionResultKeys: ['id', 'title', 'status'],
      }),
    )).toEqual({ patched: false })
  })

  it('requests bounded backfill only for full limited projected update windows', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      backfill: true,
      patched: true,
      rows: [
        rows[0]!,
        rows[2]!,
      ],
    })

    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 2,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back for previous-row updates that cannot preserve projected ordering', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
        rows: [
          { id: 2, status: 'open', title: 'Updated' },
        ],
        values: { status: 'open', title: 'Updated' },
        valueKeys: ['status', 'title'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title', 'status'],
        selectionResultKeys: ['id', 'title', 'status'],
      }),
    )).toEqual({ patched: false })
  })

  it('keeps exact-id returned projected updates unchanged when they cannot affect the query', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
      }),
      createContext({
        exactMutationId: 2,
        exactQueryId: 1,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when returned projected update predicate matches are unknown', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, title: 'Second' },
        ],
      }),
      createContext({
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when returned projected update rows omit selected values', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, status: 'open' },
        ],
      }),
      createContext({
        exactQueryId: 1,
        projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
        queryOrderChanged: true,
        selectionColumns: ['title'],
        selectionResultKeys: ['title'],
        usesExactQueryIdAsProjectedIdentity: true,
      }),
    )).toEqual({ patched: false })
  })

  it('keeps projected upserts unchanged when nonmatching rows are absent locally', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'upsert',
        rows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps projected upserts unchanged when matching rows do not change visible data', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'upsert',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when projected insert windows cannot be resolved from cached metadata', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        rowWindowMode: 'limited',
      }),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when projected delete shrink cannot be backfilled safely', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        limit: 2,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'delete',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when previous-row projected update windows cannot be resolved from cached metadata', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        rowWindowMode: 'limited',
      }),
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
        ],
        rows: [
          { id: 1, priority: 4, status: 'open', title: 'First' },
        ],
        values: { priority: 4 },
        valueKeys: ['priority'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['priority'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when returned projected update windows cannot be resolved from cached metadata', () => {
    expect(applyProjectedMutationToRows(
      rows,
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
        rowWindowMode: 'limited',
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })
})
