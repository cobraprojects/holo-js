import { describe, expect, it } from 'vitest'
import {
  NO_EXACT_ID_PREDICATE,
  type PredicateMatchContext,
} from '../src/runtime/predicate-matching'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import { createBackfillQueryKey } from '../src/runtime/query-metadata'
import { createQueryPatchTargets, isPatchableQueryPatchTarget } from '../src/runtime/query-patch-targets'
import { tryPatchObservedQuery } from '../src/runtime/query-patching'
import { tryPatchQueryRecord } from '../src/runtime/query-record-patching'
import {
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type QueryRowPatchContext,
  type RowMutationApplier,
} from '../src/runtime/query-state'
import type { BackfillCache } from '../src/runtime/state'

const emptyPredicateContext = Object.freeze({
  exactId: NO_EXACT_ID_PREDICATE,
  predicateCount: 0,
  predicates: [],
}) satisfies PredicateMatchContext

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    limit: 1,
    orderBy: [],
    patchable: true,
    predicates: [{ column: 'id', operator: '=', value: 1 }],
    rowWindowMode: 'single',
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

function createBackfills(overrides: Partial<BackfillCache> = {}): BackfillCache {
  return {
    aggregateSql: new Map(),
    aggregates: new Map(),
    entries: [],
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rows: new Map(),
    ...overrides,
  }
}

function createQueryContext(overrides: Partial<QueryRowPatchContext> = {}): QueryRowPatchContext {
  return {
    exactQueryId: NO_EXACT_ID_PREDICATE,
    hasProjectedSelections: false,
    orderColumns: [],
    orderMultipliers: [],
    projectedIdentityColumn: 'id',
    queryPredicates: emptyPredicateContext,
    selectionColumns: [],
    selectionResultKeys: [],
    usesExactQueryIdAsProjectedIdentity: false,
    ...overrides,
  }
}

function createApplier(
  result: ReturnType<RowMutationApplier>,
): RowMutationApplier {
  return () => result
}

describe('@holo-js/realtime record patching', () => {
  it('rejects record patching when there are no mutations', async () => {
    await expect(tryPatchQueryRecord(
      createQuery(),
      { id: 1, title: 'First' },
      [],
      createBackfills(),
      createQueryContext(),
      createApplier({ patched: true, rows: [] }),
    )).resolves.toEqual({ patched: false })
  })

  it('keeps projected record updates unchanged when hidden values change', async () => {
    const query = createQuery({
      hasProjectedSelections: true,
      selectionColumns: ['id', 'title'],
      selectionResultKeys: ['id', 'title'],
    })

    await expect(tryPatchQueryRecord(
      query,
      { id: 1, title: 'First' },
      [
        createMutation({
          values: { hidden: 'changed' },
          valueKeys: ['hidden'],
        }),
      ],
      createBackfills(),
      createQueryContext({
        hasProjectedSelections: true,
        selectionColumns: ['id', 'title'],
        selectionResultKeys: ['id', 'title'],
      }),
      createApplier({ patched: false }),
    )).resolves.toEqual({ patched: true, unchanged: true })
  })

  it('patches exact projected records from mutation values without returned rows', async () => {
    const query = createQuery({
      hasProjectedSelections: true,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      resultPath: [],
      result: { title: 'First' },
      selectionColumns: ['title'],
      selectionResultKeys: ['title'],
    })
    const [target] = createQueryPatchTargets([query], { title: 'First' })
    if (!target || !isPatchableQueryPatchTarget(target)) {
      throw new Error('Expected patchable record target.')
    }

    await expect(tryPatchObservedQuery(
      target,
      [
        createMutation({
          exactId: 1,
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: { title: 'Updated' },
    })
  })

  it('patches exact projected records from partial selected mutation values', async () => {
    const query = createQuery({
      hasProjectedSelections: true,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      resultPath: [],
      result: { body: 'Body', title: 'First' },
      selectionColumns: ['title', 'body'],
      selectionResultKeys: ['title', 'body'],
    })
    const [target] = createQueryPatchTargets([query], { body: 'Body', title: 'First' })
    if (!target || !isPatchableQueryPatchTarget(target)) {
      throw new Error('Expected patchable record target.')
    }

    await expect(tryPatchObservedQuery(
      target,
      [
        createMutation({
          exactId: 1,
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: { body: 'Body', title: 'Updated' },
    })
  })

  it('removes exact projected records when mutation values move the id out of the query', async () => {
    const query = createQuery({
      hasProjectedSelections: true,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      resultPath: [],
      result: { title: 'First' },
      selectionColumns: ['title'],
      selectionResultKeys: ['title'],
    })
    const [target] = createQueryPatchTargets([query], { title: 'First' })
    if (!target || !isPatchableQueryPatchTarget(target)) {
      throw new Error('Expected patchable record target.')
    }

    await expect(tryPatchObservedQuery(
      target,
      [
        createMutation({
          exactId: 1,
          values: { id: 2, title: 'Updated' },
          valueKeys: ['id', 'title'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: undefined,
    })
  })

  it('falls back when record hydration or row patching cannot complete', async () => {
    const sparseRows: Readonly<Record<string, unknown>>[] = [
      { author_id: 1, id: 1, title: 'First' },
    ]
    sparseRows.length = 2
    const query = createQuery({
      belongsToHydrations: [{
        foreignKey: 'author_id',
        ownerKey: 'id',
        relatedConnectionName: 'main',
        relatedTableName: 'users',
        relationKey: 'author',
      }],
    })

    await expect(tryPatchQueryRecord(
      query,
      { author_id: 1, id: 1, title: 'First' },
      [
        createMutation({
          rows: sparseRows,
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createApplier({ patched: true, rows: [] }),
    )).resolves.toEqual({ patched: false })
    await expect(tryPatchQueryRecord(
      createQuery(),
      { id: 1, title: 'First' },
      [
        createMutation({
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createApplier({ patched: false }),
    )).resolves.toEqual({ patched: false })
  })

  it('uses current row backfills when direct record patching fails', async () => {
    const query = createQuery()
    const backfillKey = createBackfillQueryKey(query, 0, 1)

    await expect(tryPatchQueryRecord(
      query,
      { id: 1, title: 'First' },
      [
        createMutation({
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills({
        rows: new Map([
          [backfillKey, Promise.resolve([
            { id: 1, title: 'Backfilled' },
          ])],
        ]),
      }),
      createQueryContext(),
      createApplier({ patched: false }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: { id: 1, title: 'Backfilled' },
    })

    await expect(tryPatchQueryRecord(
      query,
      null,
      [
        createMutation({
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills({
        rows: new Map([
          [backfillKey, Promise.resolve([])],
        ]),
      }),
      createQueryContext(),
      createApplier({ patched: false }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: null,
    })
  })

  it('rejects record patches that produce more than one row', async () => {
    const query = createQuery()

    await expect(tryPatchQueryRecord(
      query,
      { id: 1, title: 'First' },
      [
        createMutation({
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createApplier({
        patched: true,
        rows: [
          { id: 1, title: 'First' },
          { id: 2, title: 'Second' },
        ],
      }),
    )).resolves.toEqual({ patched: false })
  })

  it('patches record values and preserves configured empty values', async () => {
    const query = createQuery()
    const nullQuery = createQuery({
      emptyRecordValue: null,
    })

    await expect(tryPatchQueryRecord(
      query,
      { id: 1, title: 'First' },
      [
        createMutation({
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createApplier({
        patched: true,
        rows: [
          { id: 1, title: 'Updated' },
        ],
      }),
    )).resolves.toEqual({
      patched: true,
      query,
      value: { id: 1, title: 'Updated' },
    })
    await expect(tryPatchQueryRecord(
      nullQuery,
      null,
      [
        createMutation({
          kind: 'delete',
          rows: [{ id: 1, title: 'First' }],
        }),
      ],
      createBackfills(),
      createQueryContext(),
      createApplier({
        patched: true,
        rows: [],
      }),
    )).resolves.toEqual({
      patched: true,
      query: nullQuery,
      value: null,
    })
  })
})
