import { describe, expect, it } from 'vitest'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import {
  tryPatchQueryScalar,
  tryPatchQueryScalarList,
} from '../src/runtime/query-scalar-patching'
import type { BackfillCache } from '../src/runtime/state'
import type {
  DatabaseQueryObservation,
  PatchQueryResult,
  QueryRowPatchContext,
  RowMutationApplier,
  RowPatchMode,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, title: 'First', status: 'open', priority: 1 }),
  Object.freeze({ id: 2, title: 'Second', status: 'open', priority: 2 }),
]) satisfies readonly TestRow[]

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    orderBy: [],
    patchable: true,
    predicates: [{ column: 'id', operator: '=', value: 1 }],
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
    ...overrides,
  }
}

function createQueryContext(): QueryRowPatchContext {
  return {
    exactQueryId: NO_EXACT_ID_PREDICATE,
    hasProjectedSelections: false,
    orderColumns: [],
    orderMultipliers: [],
    projectedIdentityColumn: 'id',
    queryPredicates: {
      exactId: NO_EXACT_ID_PREDICATE,
      predicateCount: 0,
      predicates: [],
    },
    selectionColumns: [],
    selectionResultKeys: [],
    usesExactQueryIdAsProjectedIdentity: false,
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

describe('@holo-js/realtime scalar patching', () => {
  it('patches exact scalar values from returned rows and update values', () => {
    const query = createQuery({
      scalarColumn: 'title',
    })

    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: [
            { id: 1, status: 'open', title: 'Updated' },
          ],
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: 'Updated',
    })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: [
            { id: 2, status: 'open', title: 'Second' },
          ],
          values: { title: 'Value update' },
          valueKeys: ['title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: 'Value update',
    })
  })

  it('keeps irrelevant scalar mutations unchanged', () => {
    const query = createQuery({
      scalarColumn: 'title',
    })

    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 2,
          rows: [
            { id: 2, status: 'open', title: 'Second' },
          ],
          values: { title: 'Second' },
          valueKeys: ['title'],
        }),
        createMutation({
          exactId: 1,
          values: { body: 'Hidden' },
          valueKeys: ['body'],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps scalar mutations unchanged when the projected value stays equal', () => {
    const query = createQuery({
      scalarColumn: 'title',
    })

    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: [
            { id: 1, status: 'open', title: 'First' },
          ],
          values: { title: 'First' },
          valueKeys: ['title'],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
  })

  it('patches scalar deletes to undefined and falls back for unsafe exact rows', () => {
    const query = createQuery({
      scalarColumn: 'title',
    })

    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', title: 'First' },
          ],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: undefined,
    })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 2, status: 'open', title: 'Second' },
          ],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          kind: 'delete',
          rows: [
            { status: 'open', title: 'First' },
          ],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          previousRows: [
            { id: 1, status: 'open', title: 'First' },
          ],
          rows: [
            { id: 2, status: 'open', title: 'Second' },
          ],
          valueKeys: ['title'],
          values: { title: 'Updated' },
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: 'Updated',
    })
    expect(tryPatchQueryScalar(
      createQuery({
        exactId: 1,
        predicates: [],
        scalarColumn: 'title',
      }),
      'First',
      [
        createMutation({
          rows: [
            { id: 1 },
          ],
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query: createQuery({
        exactId: 1,
        predicates: [],
        scalarColumn: 'title',
      }),
      value: 'Updated',
    })
  })

  it('rejects scalar queries without exact ids or scalar columns', () => {
    expect(tryPatchQueryScalar(
      createQuery(),
      'First',
      [createMutation()],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      createQuery({
        predicates: [],
        scalarColumn: 'title',
      }),
      'First',
      [createMutation()],
    )).toEqual({ patched: false })
  })

  it('patches scalar rows through query predicates and falls back when selected values are missing', () => {
    const query = createQuery({
      scalarColumn: 'title',
    })

    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          rows: [
            { id: 1, title: 'Updated' },
          ],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: 'Updated',
    })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          rows: [
            { id: 1, status: 'open' },
          ],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          rows: [
            { id: 1, status: 'open' },
          ],
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: 'Updated',
    })
  })

  it('patches scalar mutation values through changed query predicates', () => {
    const query = createQuery({
      exactId: 1,
      predicates: [
        { column: 'id', operator: '=', value: 1 },
        { column: 'status', operator: '=', value: 'open' },
      ],
      scalarColumn: 'title',
    })

    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: undefined,
          values: { status: 'open', title: 'Updated' },
          valueKeys: ['status', 'title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: 'Updated',
    })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: undefined,
          values: { status: 'closed', title: 'Updated' },
          valueKeys: ['status', 'title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: undefined,
    })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: undefined,
          values: { title: 'Updated' },
          valueKeys: ['status', 'title'],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: undefined,
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: undefined,
    })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          exactId: 1,
          rows: undefined,
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          previousRows: [{ id: 1, status: 'open', title: 'First' }],
          rows: undefined,
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
    )).toEqual({
      patched: true,
      query,
      value: undefined,
    })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          rows: undefined,
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      createQuery({
        exactId: 1,
        predicates: [
          { column: 'id', operator: '=', value: 1 },
          { column: 'status', operator: 'like', value: 'open%' },
        ],
        scalarColumn: 'title',
      }),
      'First',
      [
        createMutation({
          previousRows: [{ id: 1, status: 'open', title: 'First' }],
          rows: undefined,
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          previousRows: [{ status: 'open', title: 'First' }],
          rows: undefined,
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          previousRows: [{ id: 2, status: 'open', title: 'Second' }],
          rows: undefined,
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchQueryScalar(
      createQuery({
        exactId: 1,
        predicates: [
          { column: 'id', operator: '=', value: 1 },
          { column: 'status', operator: 'unknown', value: 'open' },
        ],
        scalarColumn: 'title',
      }),
      'First',
      [
        createMutation({
          exactId: 1,
          rows: undefined,
          values: { status: 'open', title: 'Updated' },
          valueKeys: ['status', 'title'],
        }),
      ],
    )).toEqual({ patched: false })
  })

  it('falls back or stays unchanged for unsafe scalar update edges', () => {
    const query = createQuery({
      scalarColumn: 'title',
    })

    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          previousRows: [
            { id: 1, title: 'First' },
          ],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          rows: [],
          values: { id: 1 },
          valueKeys: ['id'],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchQueryScalar(
      query,
      'First',
      [
        createMutation({
          rows: [
            { title: 'Missing id' },
          ],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      createQuery({
        exactId: 1,
        predicates: [
          { column: 'id', operator: '=', value: 1 },
          { column: 'status', operator: 'like', value: 'open%' },
        ],
        scalarColumn: 'title',
      }),
      'First',
      [
        createMutation({
          rows: [
            { id: 1, status: 'open', title: 'Updated' },
          ],
        }),
      ],
    )).toEqual({ patched: false })
    const constrainedQuery = createQuery({
      exactId: 1,
      predicates: [
        { column: 'id', operator: '=', value: 1 },
        { column: 'status', operator: '=', value: 'open' },
      ],
      scalarColumn: 'title',
    })
    expect(tryPatchQueryScalar(
      constrainedQuery,
      'First',
      [
        createMutation({
          rows: [
            { id: 1, status: 'closed', title: 'Updated' },
          ],
        }),
      ],
    )).toEqual({
      patched: true,
      query: constrainedQuery,
      value: undefined,
    })
    expect(tryPatchQueryScalar(
      constrainedQuery,
      'First',
      [
        createMutation({
          rows: [
            { id: 1, status: 'open' },
          ],
          values: { status: 'open', title: 'Updated' },
          valueKeys: ['status', 'title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query: constrainedQuery,
      value: 'Updated',
    })
    expect(tryPatchQueryScalar(
      createQuery({
        exactId: 1,
        predicates: [
          { column: 'id', operator: '=', value: 1 },
          { column: 'status', operator: 'like', value: 'open%' },
        ],
        scalarColumn: 'title',
      }),
      'First',
      [
        createMutation({
          rows: [
            { id: 1, status: 'open' },
          ],
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
    )).toEqual({ patched: false })
    expect(tryPatchQueryScalar(
      constrainedQuery,
      'First',
      [
        createMutation({
          rows: [
            { id: 1, status: 'open' },
          ],
          values: { status: 'closed', title: 'Updated' },
          valueKeys: ['status', 'title'],
        }),
      ],
    )).toEqual({
      patched: true,
      query: constrainedQuery,
      value: undefined,
    })
  })

  it('projects scalar list rows after row patching', async () => {
    const query = createQuery({
      predicates: [],
      scalarListColumn: 'title',
      scalarListRows: rows,
    })
    const patchRows = createPatchRows(() => ({
      patched: true,
      query,
      value: [
        { id: 1, title: 'Updated' },
        { id: 2, title: 'Second' },
      ],
    }))

    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [
        createMutation({
          rows: [{ id: 1, title: 'Updated' }],
          valueKeys: ['title'],
          values: { title: 'Updated' },
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      patchRows,
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        scalarListRows: [
          { id: 1, title: 'Updated' },
          { id: 2, title: 'Second' },
        ],
      },
      patched: true,
      query,
      value: ['Updated', 'Second'],
    })
  })

  it('keeps scalar list values unchanged while updating cached rows', async () => {
    const query = createQuery({
      predicates: [],
      scalarListColumn: 'title',
      scalarListRows: rows,
    })

    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [
        createMutation({
          rows: [{ id: 1, title: 'First' }],
          valueKeys: ['title'],
          values: { title: 'First' },
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows(() => ({
        patched: true,
        query,
        value: [
          { id: 1, title: 'First' },
          { id: 2, title: 'Second' },
        ],
      })),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        scalarListRows: [
          { id: 1, title: 'First' },
          { id: 2, title: 'Second' },
        ],
      },
      patched: true,
      unchanged: true,
    })
  })

  it('uses offset-window row patching for paginated scalar lists', async () => {
    const query = createQuery({
      limit: 2,
      offset: 2,
      orderBy: [{ column: 'priority', direction: 'asc' }],
      predicates: [],
      scalarListColumn: 'title',
      scalarListRows: rows,
    })

    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [
        createMutation({
          rows: [{ id: 3, priority: 3, title: 'Third' }],
          valueKeys: ['priority'],
          values: { priority: 3 },
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows((rowPatchMode) => {
        expect(rowPatchMode).toBe('offset-window')
        return {
          patched: true,
          unchanged: true,
        }
      }),
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('patches scalar list rows when projected value counts change', async () => {
    const query = createQuery({
      predicates: [],
      scalarListColumn: 'title',
      scalarListRows: rows,
    })

    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 3, title: 'Third' }],
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows(() => ({
        patched: true,
        query,
        value: [
          { id: 1, title: 'First' },
        ],
      })),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        scalarListRows: [
          { id: 1, title: 'First' },
        ],
      },
      patched: true,
      query,
      value: ['First'],
    })
  })

  it('passes through unchanged scalar list row patch results', async () => {
    const query = createQuery({
      predicates: [],
      scalarListColumn: 'title',
      scalarListRows: rows,
    })

    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 3, title: 'Third' }],
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows(() => ({
        patched: true,
        unchanged: true,
      })),
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('skips irrelevant scalar list mutations before row patching', async () => {
    const query = createQuery({
      predicates: [],
      scalarListColumn: 'title',
      scalarListRows: rows,
    })
    let patchRowsCalled = false

    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [
        createMutation({
          valueKeys: ['body'],
          values: { body: 'Hidden' },
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows(() => {
        patchRowsCalled = true
        return { patched: false }
      }),
    )).resolves.toEqual({ patched: true, unchanged: true })
    expect(patchRowsCalled).toBe(false)
  })

  it('falls back for invalid scalar list patch results', async () => {
    const query = createQuery({
      predicates: [],
      scalarListColumn: 'title',
      scalarListRows: rows,
    })

    await expect(tryPatchQueryScalarList(
      createQuery({
        scalarListColumn: 'title',
      }),
      ['First', 'Second'],
      [createMutation({ kind: 'insert', rows: [{ id: 3, title: 'Third' }] })],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows(() => ({ patched: false })),
    )).resolves.toEqual({ patched: false })
    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [createMutation({ kind: 'insert', rows: [{ id: 3, title: 'Third' }] })],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows(() => ({
        patched: true,
        query,
        value: { id: 1, title: 'First' },
      })),
    )).resolves.toEqual({ patched: false })
    await expect(tryPatchQueryScalarList(
      query,
      ['First', 'Second'],
      [createMutation({ kind: 'insert', rows: [{ id: 3, title: 'Third' }] })],
      createBackfills(),
      createQueryContext(),
      createNoopMutationApplier(),
      createPatchRows(() => ({
        patched: true,
        query,
        value: [
          { id: 1 },
        ],
      })),
    )).resolves.toEqual({ patched: false })
  })
})

function createNoopMutationApplier(): RowMutationApplier {
  return () => ({ patched: false })
}

function createPatchRows(
  handler: (
    rowPatchMode: RowPatchMode,
  ) => PatchQueryResult | Promise<PatchQueryResult>,
): (
    query: DatabaseQueryObservation,
    rows: readonly TestRow[],
    mutations: readonly DatabaseMutationEvent[],
    backfills: BackfillCache,
    queryContext: QueryRowPatchContext,
    applyMutation: RowMutationApplier,
    rowPatchMode: RowPatchMode,
  ) => Promise<PatchQueryResult> {
  return async (
    _query,
    _rows,
    _mutations,
    _backfills,
    _queryContext,
    _applyMutation,
    rowPatchMode,
  ) => await handler(rowPatchMode)
}
