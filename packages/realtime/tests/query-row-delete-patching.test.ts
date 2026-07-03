import { describe, expect, it } from 'vitest'
import {
  NO_EXACT_ID_PREDICATE,
  type DatabaseQueryPredicateObservation,
} from '../src/runtime/predicate-matching'
import { applyDeleteMutationToRows } from '../src/runtime/query-row-delete-patching'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import type {
  DatabaseQueryObservation,
  RowPatchContext,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, title: 'First', status: 'open', priority: 1 }),
  Object.freeze({ id: 2, title: 'Second', status: 'closed', priority: 2 }),
  Object.freeze({ id: 3, title: 'Third', status: 'open', priority: 3 }),
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
    kind: 'delete',
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

function createExactContext(id: unknown): RowPatchContext {
  return createContext({
    exactMutationId: id,
    mutationPredicates: {
      exactId: id,
      predicateCount: 0,
      predicates: [],
    },
  })
}

function createPredicateContext(predicate: DatabaseQueryPredicateObservation): RowPatchContext {
  return createContext({
    mutationPredicates: {
      exactId: NO_EXACT_ID_PREDICATE,
      firstPredicate: predicate,
      predicateCount: 1,
      predicates: [predicate],
    },
  })
}

describe('@holo-js/realtime row delete patching', () => {
  it('keeps rows unchanged when exact query and mutation ids differ', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery(),
      createMutation(),
      createContext({
        exactMutationId: 2,
        exactQueryId: 1,
      }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('deletes exact ids through the row identity index', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery({
        rowIdentityIndex: new Map([
          [1, 0],
          [2, 1],
          [3, 2],
        ]),
      }),
      createMutation(),
      createExactContext(2),
    )).toEqual({
      patched: true,
      rows: [
        rows[0],
        rows[2],
      ],
    })
  })

  it('keeps rows unchanged when an exact indexed delete misses the query result', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery({
        rowIdentityIndex: new Map([
          [1, 0],
          [2, 1],
          [3, 2],
        ]),
      }),
      createMutation(),
      createExactContext(4),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back to scanning exact deletes when row identities are not indexable', () => {
    const duplicateRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 1, title: 'Duplicate' }),
      Object.freeze({ id: 2, title: 'Second' }),
    ]) satisfies readonly TestRow[]

    expect(applyDeleteMutationToRows(
      duplicateRows,
      createQuery({
        result: duplicateRows,
      }),
      createMutation(),
      createExactContext(1),
    )).toEqual({
      patched: true,
      rows: [
        duplicateRows[2],
      ],
    })
  })

  it('deletes predicate matches while preserving non-matching rows', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery(),
      createMutation(),
      createPredicateContext({ column: 'status', operator: '=', value: 'open' }),
    )).toEqual({
      patched: true,
      rows: [
        rows[1],
      ],
    })
  })

  it('keeps rows unchanged when scanned delete predicates match nothing', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery(),
      createMutation(),
      createPredicateContext({ column: 'status', operator: '=', value: 'archived' }),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back when scanned delete predicates cannot be evaluated', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery(),
      createMutation(),
      createPredicateContext({ column: 'missing', operator: '=', value: 'open' }),
    )).toEqual({ patched: false })

    expect(applyDeleteMutationToRows(
      [
        Object.freeze({ title: 'Missing id' }),
      ],
      createQuery(),
      createMutation(),
      createExactContext(1),
    )).toEqual({ patched: false })
  })

  it('requests backfill when deleting from a full ordered limited window', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation(),
      createPredicateContext({ column: 'status', operator: '=', value: 'closed' }),
    )).toEqual({
      backfill: true,
      patched: true,
      rows: [
        rows[0],
        rows[2],
      ],
    })
  })

  it('falls back when shrinking an offset ordered window cannot be patched or backfilled', () => {
    expect(applyDeleteMutationToRows(
      rows,
      createQuery({
        limit: 3,
        offset: 1,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      createMutation(),
      createPredicateContext({ column: 'status', operator: '=', value: 'closed' }),
    )).toEqual({ patched: false })
  })
})
