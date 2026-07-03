import { describe, expect, it } from 'vitest'
import {
  NO_EXACT_ID_PREDICATE,
  type PredicateMatchContext,
} from '../src/runtime/predicate-matching'
import { selectRowMutationApplier } from '../src/runtime/query-row-patching'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import type {
  DatabaseQueryObservation,
  RowPatchContext,
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
    tableName: 'posts',
    ...overrides,
  }
}

function createContext(overrides: Partial<RowPatchContext> = {}): RowPatchContext {
  return {
    exactMutationId: NO_EXACT_ID_PREDICATE,
    exactQueryId: NO_EXACT_ID_PREDICATE,
    hasProjectedSelections: false,
    mutationPredicates: emptyPredicateContext,
    orderColumns: [],
    orderMultipliers: [],
    projectedIdentityColumn: 'id',
    projectedSelectionChanged: true,
    queryOrderChanged: false,
    queryPredicates: emptyPredicateContext,
    selectionColumns: [],
    selectionResultKeys: [],
    usesExactQueryIdAsProjectedIdentity: false,
    valueKeys: [],
    ...overrides,
  }
}

function applyRows(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): ReturnType<ReturnType<typeof selectRowMutationApplier>> {
  return selectRowMutationApplier(query)(rows, query, mutation, context)
}

function applyCustomRows(
  queryRows: readonly TestRow[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): ReturnType<ReturnType<typeof selectRowMutationApplier>> {
  return selectRowMutationApplier(query)(queryRows, query, mutation, context)
}

describe('@holo-js/realtime plain row patching', () => {
  it('rejects plain unordered inserts unless they are known update-style upserts', () => {
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })

    expect(applyRows(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
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
        rows[0],
        rows[2],
      ],
    })
  })

  it('patches ordered inserts and falls back when predicate matches cannot be evaluated', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        rows[0],
        rows[1],
        rows[2],
      ],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'insert',
        rows: [
          { id: 5, priority: 5, title: 'Missing status' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when ordered inserts cannot be sorted after patching', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, status: 'open', title: 'Missing priority' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: false })
  })

  it('rejects ordered inserts without returned rows and ignores exact-id excluded inserts', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'insert',
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
      }),
    )).toEqual({ patched: false })

    expect(applyRows(
      query,
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
        orderColumns: ['priority'],
        orderMultipliers: [1],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps ordered inserts unchanged when no returned row matches the query', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('requests bounded backfill when known upserts shrink full limited windows', () => {
    expect(applyRows(
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
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
        rows[0],
        rows[2],
      ],
    })
  })

  it('patches exact returned updates without scanning every row', () => {
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 4,
        mutationPredicates: {
          exactId: 4,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        ...rows,
        { id: 4, priority: 4, status: 'open', title: 'Fourth' },
      ],
    })
  })

  it('keeps exact returned updates unchanged when the returned row is identical', () => {
    expect(applyRows(
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when exact returned update rows cannot be evaluated', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, title: 'Missing status' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('keeps returned updates unchanged when exact query rows are excluded', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        exactQueryId: 1,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('handles generic returned updates that are invalid, unchanged, or unsortable', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const context = createContext({
      orderColumns: ['priority'],
      orderMultipliers: [1],
      queryOrderChanged: true,
      queryPredicates: openPredicateContext,
      valueKeys: ['status'],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 5, priority: 5, title: 'Missing status' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      context,
    )).toEqual({ patched: false })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 5, priority: 5, status: 'closed', title: 'Closed' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      context,
    )).toEqual({ patched: true, unchanged: true })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: {}, status: 'open', title: 'Second' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      context,
    )).toEqual({ patched: false })

    const sparseRows: Readonly<Record<string, unknown>>[] = [
      { id: 2, priority: 2, status: 'closed', title: 'Second' },
    ]
    sparseRows.length = 2
    const sparsePreviousRows: Readonly<Record<string, unknown>>[] = [
      { id: 2, priority: 2, status: 'open', title: 'Second' },
    ]
    sparsePreviousRows.length = 2

    expect(applyRows(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: sparsePreviousRows,
        rows: sparseRows,
      }),
      context,
    )).toEqual({ patched: false })
  })

  it('keeps exact returned updates unchanged when returned rows do not change local rows', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when exact returned updates cannot preserve query ordering', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: {}, status: 'open', title: 'Second' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back to generic returned update patching when exact returned update indexes are unavailable', () => {
    const query = createQuery({
      rowIdentityIndex: undefined,
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Updated' },
        ],
        values: { status: 'open', title: 'Updated' },
        valueKeys: ['status', 'title'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status', 'title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0],
        { id: 2, priority: 2, status: 'open', title: 'Updated' },
        rows[2],
      ],
    })
  })

  it('keeps exact returned updates unchanged when returned rows no longer match the query', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back to generic returned updates when exact returned row ids differ', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 5, priority: 5, status: 'open', title: 'Fifth' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 4,
        mutationPredicates: {
          exactId: 4,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        ...rows,
        { id: 5, priority: 5, status: 'open', title: 'Fifth' },
      ],
    })
  })

  it('keeps returned updates unchanged when duplicate identities prevent exact indexing', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 1, priority: 2, status: 'open', title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: duplicateRows,
      rowIdentityIndex: undefined,
    })

    expect(applyCustomRows(
      duplicateRows,
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'Updated' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps exact returned updates unchanged when duplicate identities prevent indexed replacement', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 1, priority: 2, status: 'open', title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: duplicateRows,
      rowIdentityIndex: undefined,
    })

    expect(applyCustomRows(
      duplicateRows,
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'Updated' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when update predicate changes cannot be evaluated', () => {
    const query = createQuery({
      predicates: [{ column: 'priority', operator: '>', value: 1 }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        values: { priority: 'unknown' },
        valueKeys: ['priority'],
      }),
      createContext({
        queryPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'priority', operator: '>', value: 1 },
          predicateCount: 1,
          predicates: [{ column: 'priority', operator: '>', value: 1 }],
        },
        valueKeys: ['priority'],
      }),
    )).toEqual({ patched: false })
  })

  it('rejects predicate-changing updates without returned rows', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        exactId: 99,
        kind: 'update',
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 99,
        mutationPredicates: {
          exactId: 99,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 1, priority: 2, status: 'open', title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]

    expect(applyCustomRows(
      duplicateRows,
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
        result: duplicateRows,
        rowIdentityIndex: undefined,
      }),
      createMutation({
        exactId: 1,
        kind: 'update',
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
        rowIdentityIndex: new Map([[1, 99]]),
      }),
      createMutation({
        exactId: 1,
        kind: 'update',
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('patches previous-row predicate-changing retained updates without returned rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })
    const queryPredicates = {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: { column: 'status', operator: 'in', value: ['open', 'pending'] },
      predicateCount: 1,
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    } satisfies PredicateMatchContext

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 2, priority: 2, status: 'open', title: 'Second' }],
        values: { status: 'pending' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        queryRows[0],
        { id: 2, priority: 2, status: 'pending', title: 'Second' },
      ],
    })
  })

  it('removes previous-row predicate-changing updates without returned rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 2, priority: 2, status: 'open', title: 'Second' }],
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
        queryRows[0],
      ],
    })
  })

  it('patches ordered previous-row predicate entries without returned rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 3, priority: 0, status: 'closed', title: 'Third' }],
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
        { id: 3, priority: 0, status: 'open', title: 'Third' },
        queryRows[0],
        queryRows[1],
      ],
    })
  })

  it('falls back for unordered previous-row predicate entries without returned rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 3, priority: 3, status: 'closed', title: 'Third' }],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('keeps previous-row updates unchanged when affected rows stay outside the query', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 3, priority: 3, status: 'closed', title: 'Third' }],
        values: { title: 'Archived' },
        valueKeys: ['title'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 3, priority: 3, status: 'open', title: 'Third' }],
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 2, priority: 2, status: 'open', title: 'Second' }],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('patches multiple previous-row updates after the first mutation changes retained rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })
    const queryPredicates = {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: { column: 'status', operator: 'in', value: ['open', 'pending'] },
      predicateCount: 1,
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    } satisfies PredicateMatchContext

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [
          { id: 1, priority: 1, status: 'open', title: 'First' },
          { id: 2, priority: 2, status: 'open', title: 'Second' },
          { id: 3, priority: 3, status: 'open', title: 'Third' },
        ],
        values: { status: 'pending' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'pending', title: 'First' },
        { id: 2, priority: 2, status: 'pending', title: 'Second' },
      ],
    })
  })

  it('relocates ordered previous-row retained updates without returned rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 2, priority: 2, status: 'open', title: 'Second' }],
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
    )).toEqual({
      patched: true,
      rows: [
        { id: 2, priority: 0, status: 'open', title: 'Second' },
        queryRows[0],
      ],
    })
  })

  it('keeps full ordered windows unchanged when previous-row entries remain past the tail', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 3, priority: 3, status: 'closed', title: 'Third' }],
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
  })

  it('falls back for malformed previous-row updates without returned rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 1, priority: 2, status: 'open', title: 'Duplicate' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      duplicateRows,
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
        result: duplicateRows,
        rowIdentityIndex: undefined,
      }),
      createMutation({
        kind: 'update',
        previousRows: [{ id: 1, priority: 1, status: 'open', title: 'First' }],
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [undefined as unknown as Readonly<Record<string, unknown>>],
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ priority: 2, status: 'open', title: 'Second' }],
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })

    expect(applyCustomRows(
      queryRows,
      createQuery({
        predicates: [
          { column: 'status', operator: '=', value: 'open' },
          { column: 'priority', operator: '>', value: 1 },
        ],
        result: queryRows,
        rowIdentityIndex: new Map([[1, 0], [2, 1]]),
      }),
      createMutation({
        kind: 'update',
        previousRows: [{ id: 2, priority: 2, status: 'open', title: 'Second' }],
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
  })

  it('falls back for ambiguous ordered previous-row updates without returned rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, priority: 1, status: 'open', title: 'First' }),
      Object.freeze({ id: 2, priority: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0], [2, 1]]),
    })

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 3, priority: 3, status: 'open', title: 'Third' }],
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

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        kind: 'update',
        previousRows: [{ id: 2, priority: 2, status: 'open', title: 'Second' }],
        values: { priority: {} },
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
  })

  it('patches exact existing predicate-changing updates without returned rows', () => {
    const query = createQuery({
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    })
    const queryPredicates = {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: { column: 'status', operator: 'in', value: ['open', 'pending'] },
      predicateCount: 1,
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    } satisfies PredicateMatchContext

    expect(applyRows(
      query,
      createMutation({
        exactId: 1,
        kind: 'update',
        values: { status: 'pending' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'pending', title: 'First' },
        rows[1],
        rows[2],
      ],
    })

    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        exactId: 1,
        kind: 'update',
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('removes exact existing predicate-changing updates without returned rows when patched rows no longer match', () => {
    const query = createQuery({
      predicates: [
        { column: 'status', operator: 'in', value: ['open', 'pending'] },
        { column: 'title', operator: '=', value: 'Expected' },
      ],
    })
    const queryPredicates = {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: { column: 'status', operator: 'in', value: ['open', 'pending'] },
      predicateCount: 2,
      predicates: [
        { column: 'status', operator: 'in', value: ['open', 'pending'] },
        { column: 'title', operator: '=', value: 'Expected' },
      ],
    } satisfies PredicateMatchContext

    expect(applyRows(
      query,
      createMutation({
        exactId: 1,
        kind: 'update',
        values: { status: 'pending' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[1],
        rows[2],
      ],
    })
  })

  it('falls back when exact existing predicate-changing updates cannot evaluate patched rows', () => {
    const queryRows = Object.freeze([
      Object.freeze({ id: 1, status: 'open', title: 'First' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [
        { column: 'status', operator: 'in', value: ['open', 'pending'] },
        { column: 'priority', operator: '>', value: 1 },
      ],
      result: queryRows,
      rowIdentityIndex: new Map([[1, 0]]),
    })
    const queryPredicates = {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: { column: 'status', operator: 'in', value: ['open', 'pending'] },
      predicateCount: 2,
      predicates: [
        { column: 'status', operator: 'in', value: ['open', 'pending'] },
        { column: 'priority', operator: '>', value: 1 },
      ],
    } satisfies PredicateMatchContext

    expect(applyCustomRows(
      queryRows,
      query,
      createMutation({
        exactId: 1,
        kind: 'update',
        values: { status: 'pending' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('relocates exact existing predicate-changing ordered updates without returned rows', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    })
    const queryPredicates = {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: { column: 'status', operator: 'in', value: ['open', 'pending'] },
      predicateCount: 1,
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    } satisfies PredicateMatchContext

    expect(applyRows(
      query,
      createMutation({
        exactId: 2,
        kind: 'update',
        values: { priority: 0, status: 'pending' },
        valueKeys: ['priority', 'status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates,
        valueKeys: ['priority', 'status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 2, priority: 0, status: 'pending', title: 'Second' },
        rows[0],
        rows[2],
      ],
    })
  })

  it('falls back when exact existing predicate-changing ordered updates cannot be relocated', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    })
    const queryPredicates = {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: { column: 'status', operator: 'in', value: ['open', 'pending'] },
      predicateCount: 1,
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    } satisfies PredicateMatchContext

    expect(applyRows(
      query,
      createMutation({
        exactId: 2,
        kind: 'update',
        values: { priority: {}, status: 'pending' },
        valueKeys: ['priority', 'status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates,
        valueKeys: ['priority', 'status'],
      }),
    )).toEqual({ patched: false })
  })

  it('preserves unchanged rows after scanned updates start mutating rows', () => {
    expect(applyRows(
      createQuery(),
      createMutation({
        kind: 'update',
        values: { title: 'Second' },
        valueKeys: ['title'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'status', operator: '=', value: 'open' },
          predicateCount: 1,
          predicates: [{ column: 'status', operator: '=', value: 'open' }],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'open', title: 'Second' },
        rows[1],
        rows[2],
      ],
    })
  })

  it('falls back when changed scan updates cannot be sorted by query ordering', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        values: { priority: {} },
        valueKeys: ['priority'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'id', operator: '=', value: 2 },
          predicateCount: 1,
          predicates: [{ column: 'id', operator: '=', value: 2 }],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['priority'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when scanned update mutation predicates cannot be evaluated', () => {
    const invalidRows = Object.freeze([
      Object.freeze({ id: 1, priority: {}, status: 'open', title: 'First' }),
    ]) satisfies readonly TestRow[]

    expect(applyCustomRows(
      invalidRows,
      createQuery({
        result: invalidRows,
        rowIdentityIndex: new Map([[1, 0]]),
      }),
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'priority', operator: '>', value: 1 },
          predicateCount: 1,
          predicates: [{ column: 'priority', operator: '>', value: 1 }],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when scanned update query predicates cannot be evaluated after patching', () => {
    const invalidRows = Object.freeze([
      Object.freeze({ id: 2, priority: {}, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'priority', operator: '>', value: 1 }],
      result: invalidRows,
      rowIdentityIndex: new Map([[2, 0]]),
    })

    expect(applyCustomRows(
      invalidRows,
      query,
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'priority', operator: '>', value: 1 },
          predicateCount: 1,
          predicates: [{ column: 'priority', operator: '>', value: 1 }],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })
  })

  it('requests bounded backfill for plain updates that shrink full limited windows', () => {
    const query = createQuery({
      limit: 3,
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'id', operator: '=', value: 2 },
          predicateCount: 1,
          predicates: [{ column: 'id', operator: '=', value: 2 }],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      backfill: true,
      patched: true,
      rows: [
        rows[0],
        rows[2],
      ],
    })

    expect(applyRows(
      createQuery({
        limit: 2,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'id', operator: '=', value: 2 },
          predicateCount: 1,
          predicates: [{ column: 'id', operator: '=', value: 2 }],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('requests bounded backfill for sorted plain updates that shrink full limited windows', () => {
    const unsortedRows = Object.freeze([
      Object.freeze({ group: 'keep', id: 1, status: 'open', title: 'First' }),
      Object.freeze({ group: 'remove', id: 2, status: 'open', title: 'Second' }),
      Object.freeze({ group: 'keep', id: 3, status: 'open', title: 'Third' }),
    ]) satisfies readonly TestRow[]

    expect(applyCustomRows(
      unsortedRows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'id', direction: 'desc' }],
        predicates: [{ column: 'group', operator: '!=', value: 'remove' }],
      }),
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'status', operator: '=', value: 'open' },
          predicateCount: 1,
          predicates: [{ column: 'status', operator: '=', value: 'open' }],
        },
        orderColumns: ['id'],
        orderMultipliers: [-1],
        queryOrderChanged: true,
        queryPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'group', operator: '!=', value: 'remove' },
          predicateCount: 1,
          predicates: [{ column: 'group', operator: '!=', value: 'remove' }],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({
      backfill: true,
      patched: true,
      rows: [
        { group: 'keep', id: 3, status: 'open', title: 'Updated' },
        { group: 'keep', id: 1, status: 'open', title: 'Updated' },
      ],
    })
  })

  it('rejects unsafe known-upsert metadata for unordered queries', () => {
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const context = createContext({
      queryPredicates: openPredicateContext,
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: [
          { id: 2, priority: 2, status: 'closed', title: 'Second' },
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
      }),
      context,
    )).toEqual({ patched: false })

    expect(applyRows(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
      }),
      context,
    )).toEqual({ patched: false })

    expect(applyRows(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 4, priority: 4, title: 'Fourth' },
        ],
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
      }),
      context,
    )).toEqual({ patched: false })

    const sparseRows: Readonly<Record<string, unknown>>[] = [
      { id: 2, priority: 2, status: 'closed', title: 'Second' },
    ]
    sparseRows.length = 2
    const sparsePreviousRows: Readonly<Record<string, unknown>>[] = [
      { id: 2, priority: 2, status: 'open', title: 'Second' },
    ]
    sparsePreviousRows.length = 2

    expect(applyRows(
      query,
      createMutation({
        kind: 'upsert',
        previousRows: sparsePreviousRows,
        rows: sparseRows,
      }),
      context,
    )).toEqual({ patched: false })
  })

  it('rejects updates without values and keeps exact-id misses unchanged', () => {
    expect(applyRows(
      createQuery(),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
      }),
      createContext(),
    )).toEqual({ patched: false })

    expect(applyRows(
      createQuery(),
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 9,
        mutationPredicates: {
          exactId: 9,
          predicateCount: 0,
          predicates: [],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when exact updates cannot evaluate patched predicate matches', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'priority', operator: '>', value: 1 }],
      }),
      createMutation({
        kind: 'update',
        values: { priority: {} },
        valueKeys: ['priority'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'priority', operator: '>', value: 1 },
          predicateCount: 1,
          predicates: [{ column: 'priority', operator: '>', value: 1 }],
        },
        valueKeys: ['priority'],
      }),
    )).toEqual({ patched: false })
  })

  it('patches exact existing rows by merging partial returned rows with mutation values', () => {
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, status: 'open' },
        ],
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'open', title: 'Updated' },
        rows[1],
        rows[2],
      ],
    })
  })

  it('falls back for sparse exact updated mutation rows', () => {
    const sparseRows: Readonly<Record<string, unknown>>[] = []
    sparseRows.length = 1

    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: sparseRows,
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('continues exact updated mutation rows when current row identity cannot be indexed', () => {
    const noIdentityRows = Object.freeze([
      Object.freeze({ priority: 1, status: 'open', title: 'First' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: noIdentityRows,
      rowIdentityIndex: undefined,
    })

    expect(applyCustomRows(
      noIdentityRows,
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'Updated' },
        ],
        values: { status: 'open' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        noIdentityRows[0],
        { id: 1, priority: 1, status: 'open', title: 'Updated' },
      ],
    })
  })

  it('keeps exact updated mutation rows unchanged when appended rows cannot enter the window', () => {
    const query = createQuery({
      limit: 3,
      orderBy: [{ column: 'priority', direction: 'asc' }],
      rowWindowMode: 'limited',
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
        values: { title: 'Fourth' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 4,
        mutationPredicates: {
          exactId: 4,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps exact updated mutation rows unchanged when incoming order metadata is missing', () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })

    expect(applyRows(
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 4, status: 'open', title: 'Fourth' },
        ],
        values: { title: 'Fourth' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 4,
        mutationPredicates: {
          exactId: 4,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when appended exact updated mutation rows cannot be sorted with current rows', () => {
    const invalidRows = Object.freeze([
      Object.freeze({ id: 1, status: 'open', title: 'First' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      result: invalidRows,
      rowIdentityIndex: new Map([[1, 0]]),
    })

    expect(applyCustomRows(
      invalidRows,
      query,
      createMutation({
        kind: 'update',
        rows: [
          { id: 4, priority: 4, status: 'open', title: 'Fourth' },
        ],
        values: { status: 'open', title: 'Fourth' },
        valueKeys: ['status', 'title'],
      }),
      createContext({
        exactMutationId: 4,
        mutationPredicates: {
          exactId: 4,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
        queryOrderChanged: true,
        valueKeys: ['status', 'title'],
      }),
    )).toEqual({ patched: false })
  })

  it('ignores stale exact update identity indexes', () => {
    expect(applyRows(
      createQuery({
        rowIdentityIndex: new Map([[9, 9]]),
      }),
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 9,
        mutationPredicates: {
          exactId: 9,
          predicateCount: 0,
          predicates: [],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls through stale exact updated mutation row identity indexes', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
        rowIdentityIndex: new Map([[1, 9]]),
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'Updated' },
        ],
        values: { status: 'open', title: 'Updated' },
        valueKeys: ['status', 'title'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status', 'title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 1, priority: 1, status: 'open', title: 'Updated' },
        rows[1],
        rows[2],
      ],
    })
  })

  it('falls back when exact updated mutation rows cannot produce a supported window', () => {
    expect(applyRows(
      createQuery({
        offset: 1,
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 1, priority: 1, status: 'open', title: 'Updated' },
        ],
        values: { status: 'open', title: 'Updated' },
        valueKeys: ['status', 'title'],
      }),
      createContext({
        exactMutationId: 1,
        mutationPredicates: {
          exactId: 1,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status', 'title'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when exact update query predicates cannot be evaluated from stored rows', () => {
    const invalidRows = Object.freeze([
      Object.freeze({ id: 2, status: 'open', title: 'Second' }),
    ]) satisfies readonly TestRow[]

    expect(applyCustomRows(
      invalidRows,
      createQuery({
        predicates: [{ column: 'priority', operator: '>', value: 1 }],
        result: invalidRows,
        rowIdentityIndex: new Map([[2, 0]]),
      }),
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'priority', operator: '>', value: 1 },
          predicateCount: 1,
          predicates: [{ column: 'priority', operator: '>', value: 1 }],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })
  })

  it('keeps updates unchanged when exact query and mutation ids differ', () => {
    expect(applyRows(
      createQuery(),
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 2,
        exactQueryId: 1,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('patches exact-id removals when changed values move rows out of the query', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        rows[0],
        rows[2],
      ],
    })
  })

  it('patches full ordered windows from returned rows when no scanned row changed', () => {
    expect(applyRows(
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        ],
        values: { title: 'No row matches this title' },
        valueKeys: ['title'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'title', operator: '=', value: 'No row matches this title' },
          predicateCount: 1,
          predicates: [{ column: 'title', operator: '=', value: 'No row matches this title' }],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        rows[0],
        rows[1],
      ],
    })
  })

  it('patches exact-id full ordered window misses from returned rows', () => {
    expect(applyRows(
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        ],
        values: { priority: 0, status: 'open' },
        valueKeys: ['priority', 'status'],
      }),
      createContext({
        exactMutationId: 4,
        mutationPredicates: {
          exactId: 4,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['priority'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 4, priority: 0, status: 'open', title: 'Fourth' },
        rows[0],
        rows[1],
      ],
    })
  })

  it('patches exact-id full ordered windows from returned rows when local values are unchanged', () => {
    expect(applyRows(
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 0, status: 'open', title: 'Second' },
        ],
        values: { title: 'Second' },
        valueKeys: ['title'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['title'],
      }),
    )).toEqual({
      patched: true,
      rows: [
        { id: 2, priority: 0, status: 'open', title: 'Second' },
        rows[0],
        rows[2],
      ],
    })
  })

  it('keeps ordered upserts unchanged when matching rows do not change local rows', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
      }),
      createContext({
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps unordered known upserts unchanged when non-matching rows are absent locally', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
        rows: [
          { id: 4, priority: 4, status: 'closed', title: 'Fourth' },
        ],
      }),
      createContext({
        queryPredicates: openPredicateContext,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when shrinking known upserts cannot be backfilled safely', () => {
    expect(applyRows(
      createQuery({
        limit: 2,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'upsert',
        previousRows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
        ],
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

  it('falls back when ordered insert windows cannot be resolved from cached metadata', () => {
    expect(applyRows(
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
      }),
    )).toEqual({ patched: false })
  })

  it('keeps returned updates unchanged when matching rows do not change local rows', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, priority: 2, status: 'open', title: 'Second' },
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
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when returned update windows cannot be resolved from cached metadata', () => {
    expect(applyRows(
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

  it('falls back when exact returned update windows cannot be resolved from cached metadata', () => {
    expect(applyRows(
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
        values: { priority: 0, status: 'open' },
        valueKeys: ['priority', 'status'],
      }),
      createContext({
        exactMutationId: 4,
        mutationPredicates: {
          exactId: 4,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        queryPredicates: openPredicateContext,
        valueKeys: ['priority', 'status'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when exact updates change ordering but cannot be relocated safely', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation({
        kind: 'update',
        values: { priority: {} },
        valueKeys: ['priority'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['priority'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when exact update removal windows cannot be resolved from cached metadata', () => {
    expect(applyRows(
      createQuery({
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
        rowWindowMode: 'limited',
      }),
      createMutation({
        kind: 'update',
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
      createContext({
        exactMutationId: 2,
        mutationPredicates: {
          exactId: 2,
          predicateCount: 0,
          predicates: [],
        },
        queryPredicates: openPredicateContext,
        valueKeys: ['status'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when sorted shrinking updates cannot be backfilled safely', () => {
    const unsortedRows = Object.freeze([
      Object.freeze({ group: 'keep', id: 1, status: 'open', title: 'First' }),
      Object.freeze({ group: 'remove', id: 2, status: 'open', title: 'Second' }),
      Object.freeze({ group: 'keep', id: 3, status: 'open', title: 'Third' }),
    ]) satisfies readonly TestRow[]

    expect(applyCustomRows(
      unsortedRows,
      createQuery({
        limit: 2,
        orderBy: [{ column: 'id', direction: 'desc' }],
        predicates: [{ column: 'group', operator: '!=', value: 'remove' }],
      }),
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'status', operator: '=', value: 'open' },
          predicateCount: 1,
          predicates: [{ column: 'status', operator: '=', value: 'open' }],
        },
        orderColumns: ['id'],
        orderMultipliers: [-1],
        queryOrderChanged: true,
        queryPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'group', operator: '!=', value: 'remove' },
          predicateCount: 1,
          predicates: [{ column: 'group', operator: '!=', value: 'remove' }],
        },
        valueKeys: ['title'],
      }),
    )).toEqual({ patched: false })
  })

  it('falls back when sorted update windows cannot be resolved from cached metadata', () => {
    expect(applyRows(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        rowWindowMode: 'limited',
      }),
      createMutation({
        kind: 'update',
        values: { priority: 4 },
        valueKeys: ['priority'],
      }),
      createContext({
        mutationPredicates: {
          exactId: NO_EXACT_ID_PREDICATE,
          firstPredicate: { column: 'id', operator: '=', value: 1 },
          predicateCount: 1,
          predicates: [{ column: 'id', operator: '=', value: 1 }],
        },
        orderColumns: ['priority'],
        orderMultipliers: [1],
        queryOrderChanged: true,
        valueKeys: ['priority'],
      }),
    )).toEqual({ patched: false })
  })
})
