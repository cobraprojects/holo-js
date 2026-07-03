import { describe, expect, it } from 'vitest'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import { createBackfillQueryKey } from '../src/runtime/query-metadata'
import {
  tryPatchQueryRows,
  tryPatchWrapperDataRows,
} from '../src/runtime/query-rows-patching'
import {
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type QueryRowPatchContext,
  type RowMutationApplier,
} from '../src/runtime/query-state'
import type { BackfillCache } from '../src/runtime/state'

type TestRow = Readonly<Record<string, unknown>>

const firstRow = Object.freeze({ id: 1, priority: 1, title: 'First' }) satisfies TestRow
const secondRow = Object.freeze({ id: 2, priority: 2, title: 'Second' }) satisfies TestRow
const rows = Object.freeze([
  firstRow,
  secondRow,
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

function createQueryContext(overrides: Partial<QueryRowPatchContext> = {}): QueryRowPatchContext {
  return {
    exactQueryId: NO_EXACT_ID_PREDICATE,
    hasProjectedSelections: false,
    orderColumns: [],
    orderMultipliers: [],
    projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
    queryPredicates: {
      exactId: NO_EXACT_ID_PREDICATE,
      predicateCount: 0,
      predicates: [],
    },
    selectionColumns: [],
    selectionResultKeys: [],
    usesExactQueryIdAsProjectedIdentity: false,
    ...overrides,
  }
}

function createBackfills(): BackfillCache {
  return {
    aggregates: new Map(),
    aggregateSql: new Map(),
    entries: [],
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rows: new Map(),
  }
}

function setRowBackfill(
  backfills: BackfillCache,
  query: DatabaseQueryObservation,
  offset: number,
  limit: number,
  value: readonly TestRow[],
): void {
  backfills.rows.set(createBackfillQueryKey(query, offset, limit), Promise.resolve(value))
}

const changedRows = Object.freeze([
  firstRow,
  Object.freeze({ id: 2, priority: 2, title: 'Updated' }),
]) satisfies readonly TestRow[]

describe('@holo-js/realtime query rows patch orchestration', () => {
  it('rejects empty mutation batches', async () => {
    await expect(tryPatchQueryRows(
      createQuery(),
      rows,
      [],
      createBackfills(),
      createQueryContext(),
      () => ({ patched: true, rows: changedRows }),
      'rows',
    )).resolves.toEqual({ patched: false })
  })

  it('backfills current rows when hydration cannot produce patchable rows', async () => {
    const sparseMutationRows = [
      undefined,
    ] as unknown as readonly TestRow[]
    const query = createQuery({
      belongsToHydrations: [{
        foreignKey: 'author_id',
        ownerKey: 'id',
        relationKey: 'author',
        relatedConnectionName: 'main',
        relatedTableName: 'users',
      }],
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })
    const backfills = createBackfills()
    const backfilledRows = Object.freeze([
      Object.freeze({ id: 3, priority: 3, title: 'Backfilled' }),
    ]) satisfies readonly TestRow[]
    const hydratedBackfilledRows = Object.freeze([
      Object.freeze({ author: null, id: 3, priority: 3, title: 'Backfilled' }),
    ]) satisfies readonly TestRow[]
    setRowBackfill(backfills, query, 0, 2, backfilledRows)

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation({ rows: sparseMutationRows })],
      backfills,
      createQueryContext(),
      () => ({ patched: false }),
      'rows',
    )).resolves.toEqual({
      patched: true,
      query,
      value: hydratedBackfilledRows,
    })
  })

  it('uses current backfill when a limited-row backfill cannot fill a shrinking patch', async () => {
    const query = createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })
    const backfills = createBackfills()
    const currentBackfillRows = Object.freeze([
      firstRow,
      Object.freeze({ id: 3, priority: 3, title: 'Backfilled' }),
    ]) satisfies readonly TestRow[]
    setRowBackfill(backfills, query, 0, 2, currentBackfillRows)

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation()],
      backfills,
      createQueryContext(),
      () => ({
        backfill: true,
        patched: true,
        rows: Object.freeze([firstRow]),
      }),
      'rows',
    )).resolves.toEqual({
      patched: true,
      query,
      value: currentBackfillRows,
    })
  })

  it('uses limited-row backfill when shrinking standard rows can be refilled locally', async () => {
    const query = createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })
    const backfills = createBackfills()
    setRowBackfill(backfills, query, 1, 1, Object.freeze([secondRow]))

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation()],
      backfills,
      createQueryContext(),
      () => ({
        backfill: true,
        patched: true,
        rows: Object.freeze([firstRow]),
      }),
      'rows',
    )).resolves.toEqual({
      patched: true,
      query,
      value: rows,
    })
  })

  it('skips projected standard updates and reports unchanged rows', async () => {
    const applyMutation: RowMutationApplier = () => {
      throw new Error('Projected invisible updates should not call the row applier.')
    }

    await expect(tryPatchQueryRows(
      createQuery({
        hasProjectedSelections: true,
        selectionColumns: ['title'],
      }),
      rows,
      [createMutation({
        values: { hidden: 'Changed' },
        valueKeys: ['hidden'],
      })],
      createBackfills(),
      createQueryContext({
        hasProjectedSelections: true,
        selectionColumns: ['title'],
        selectionResultKeys: ['title'],
      }),
      applyMutation,
      'rows',
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('backfills standard rows when local patching fails', async () => {
    const query = createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })
    const backfills = createBackfills()
    const currentBackfillRows = Object.freeze([
      Object.freeze({ id: 3, priority: 3, title: 'Backfilled' }),
    ]) satisfies readonly TestRow[]
    setRowBackfill(backfills, query, 0, 2, currentBackfillRows)

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation()],
      backfills,
      createQueryContext(),
      () => ({ patched: false }),
      'rows',
    )).resolves.toEqual({
      patched: true,
      query,
      value: currentBackfillRows,
    })
  })

  it('keeps standard rows unchanged when local patching reports no row changes', async () => {
    await expect(tryPatchQueryRows(
      createQuery(),
      rows,
      [createMutation()],
      createBackfills(),
      createQueryContext(),
      () => ({ patched: true, unchanged: true }),
      'rows',
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('skips projected wrapper updates that cannot affect visible rows', async () => {
    const applyMutation: RowMutationApplier = () => {
      throw new Error('Projected invisible updates should not call the row applier.')
    }

    await expect(tryPatchWrapperDataRows(
      createQuery({
        hasProjectedSelections: true,
        selectionColumns: ['title'],
      }),
      rows,
      [createMutation({
        values: { hidden: 'Changed' },
        valueKeys: ['hidden'],
      })],
      createBackfills(),
      createQueryContext({
        hasProjectedSelections: true,
        selectionColumns: ['title'],
        selectionResultKeys: ['title'],
      }),
      applyMutation,
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('uses cursor wrapper patches before generic wrapper row patching', async () => {
    const query = createQuery({
      cursorRowCount: 2,
      cursorRows: rows,
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })

    await expect(tryPatchWrapperDataRows(
      query,
      rows,
      [createMutation({
        kind: 'insert',
        rows: [
          Object.freeze({ id: 3, priority: 3, title: 'Third' }),
        ],
      })],
      createBackfills(),
      createQueryContext(),
      () => {
        throw new Error('Cursor wrapper patches should not call the generic row applier.')
      },
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        cursorRowCount: 3,
        cursorRows: Object.freeze([
          ...rows,
          Object.freeze({ id: 3, priority: 3, title: 'Third' }),
        ]),
      },
      patched: true,
      query,
      value: rows,
    })
  })

  it('backfills wrapper rows when hydration or local patching cannot complete', async () => {
    const sparseMutationRows = [
      undefined,
    ] as unknown as readonly TestRow[]
    const query = createQuery({
      belongsToHydrations: [{
        foreignKey: 'author_id',
        ownerKey: 'id',
        relationKey: 'author',
        relatedConnectionName: 'main',
        relatedTableName: 'users',
      }],
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })
    const backfills = createBackfills()
    const currentBackfillRows = Object.freeze([
      firstRow,
      Object.freeze({ id: 3, priority: 3, title: 'Backfilled' }),
    ]) satisfies readonly TestRow[]
    const hydratedCurrentBackfillRows = Object.freeze([
      Object.freeze({ ...firstRow, author: null }),
      Object.freeze({ author: null, id: 3, priority: 3, title: 'Backfilled' }),
    ]) satisfies readonly TestRow[]
    setRowBackfill(backfills, query, 0, 2, currentBackfillRows)

    await expect(tryPatchWrapperDataRows(
      query,
      rows,
      [createMutation({ rows: sparseMutationRows })],
      backfills,
      createQueryContext(),
      () => ({ patched: false }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: hydratedCurrentBackfillRows,
    })

    await expect(tryPatchWrapperDataRows(
      query,
      rows,
      [createMutation()],
      backfills,
      createQueryContext(),
      () => ({ patched: false }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: hydratedCurrentBackfillRows,
    })
  })

  it('backfills wrapper row-count changes and keeps same-length wrapper patches local', async () => {
    const query = createQuery({
      limit: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })
    const changedBackfills = createBackfills()
    const limitedBackfillRows = Object.freeze([
      secondRow,
    ]) satisfies readonly TestRow[]
    setRowBackfill(changedBackfills, query, 1, 1, limitedBackfillRows)

    await expect(tryPatchWrapperDataRows(
      query,
      rows,
      [createMutation()],
      changedBackfills,
      createQueryContext(),
      () => ({
        patched: true,
        rows: Object.freeze([firstRow]),
      }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: rows,
    })

    await expect(tryPatchWrapperDataRows(
      query,
      rows,
      [createMutation()],
      createBackfills(),
      createQueryContext(),
      () => ({
        patched: true,
        rows: changedRows,
      }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: changedRows,
    })

    const fallbackBackfills = createBackfills()
    const currentBackfillRows = Object.freeze([
      Object.freeze({ id: 3, priority: 3, title: 'Backfilled' }),
    ]) satisfies readonly TestRow[]
    setRowBackfill(fallbackBackfills, query, 0, 2, currentBackfillRows)

    await expect(tryPatchWrapperDataRows(
      query,
      rows,
      [createMutation()],
      fallbackBackfills,
      createQueryContext(),
      () => ({
        patched: true,
        rows: Object.freeze([firstRow]),
      }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: currentBackfillRows,
    })
  })

  it('keeps wrapper rows unchanged when local patching reports no row changes', async () => {
    await expect(tryPatchWrapperDataRows(
      createQuery(),
      rows,
      [createMutation()],
      createBackfills(),
      createQueryContext(),
      () => ({ patched: true, unchanged: true }),
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('patches offset windows only when stable local patches keep row count', async () => {
    const query = createQuery({
      limit: 2,
      offset: 1,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })
    const backfills = createBackfills()
    const offsetBackfillRows = Object.freeze([
      Object.freeze({ id: 4, priority: 4, title: 'Offset backfill' }),
    ]) satisfies readonly TestRow[]
    setRowBackfill(backfills, query, 1, 2, offsetBackfillRows)

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation({
        values: { hidden: 'Changed' },
        valueKeys: ['hidden'],
      })],
      backfills,
      createQueryContext({
        hasProjectedSelections: true,
        selectionColumns: ['title'],
        selectionResultKeys: ['title'],
      }),
      () => ({ patched: true, rows: changedRows }),
      'offset-window',
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation()],
      backfills,
      createQueryContext(),
      () => ({ patched: false }),
      'offset-window',
    )).resolves.toEqual({
      patched: true,
      query,
      value: offsetBackfillRows,
    })

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation()],
      backfills,
      createQueryContext(),
      () => ({
        patched: true,
        rows: Object.freeze([firstRow]),
      }),
      'offset-window',
    )).resolves.toEqual({
      patched: true,
      query,
      value: offsetBackfillRows,
    })

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation({
        values: { title: 'Updated' },
        valueKeys: ['title'],
      })],
      backfills,
      createQueryContext(),
      () => ({ patched: true, rows: changedRows }),
      'offset-window',
    )).resolves.toEqual({
      patched: true,
      query,
      value: changedRows,
    })

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation({
        values: { priority: 9 },
        valueKeys: ['priority'],
      })],
      backfills,
      createQueryContext(),
      () => ({ patched: true, rows: changedRows }),
      'offset-window',
    )).resolves.toEqual({
      patched: true,
      query,
      value: offsetBackfillRows,
    })

    const sparseMutationRows = [
      undefined,
    ] as unknown as readonly TestRow[]
    const hydratedOffsetBackfillRows = Object.freeze([
      Object.freeze({ author: null, id: 4, priority: 4, title: 'Offset backfill' }),
    ]) satisfies readonly TestRow[]
    await expect(tryPatchQueryRows(
      createQuery({
        belongsToHydrations: [{
          foreignKey: 'author_id',
          ownerKey: 'id',
          relationKey: 'author',
          relatedConnectionName: 'main',
          relatedTableName: 'users',
        }],
        limit: 2,
        offset: 1,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      rows,
      [createMutation({
        rows: sparseMutationRows,
        values: { title: 'Updated' },
        valueKeys: ['title'],
      })],
      backfills,
      createQueryContext(),
      () => ({ patched: true, rows: changedRows }),
      'offset-window',
    )).resolves.toEqual({
      patched: true,
      query: createQuery({
        belongsToHydrations: [{
          foreignKey: 'author_id',
          ownerKey: 'id',
          relationKey: 'author',
          relatedConnectionName: 'main',
          relatedTableName: 'users',
        }],
        limit: 2,
        offset: 1,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      value: hydratedOffsetBackfillRows,
    })
  })

  it('rejects offset-window patches when local patching and offset backfill both fail', async () => {
    const query = createQuery({
      limit: 2,
      offset: 1,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    })

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation()],
      createBackfills(),
      createQueryContext(),
      () => ({ patched: false }),
      'offset-window',
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryRows(
      query,
      rows,
      [createMutation()],
      createBackfills(),
      createQueryContext(),
      () => ({ patched: true, unchanged: true }),
      'offset-window',
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })
})
