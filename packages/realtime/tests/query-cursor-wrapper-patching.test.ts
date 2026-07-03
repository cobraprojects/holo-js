import { describe, expect, it } from 'vitest'
import { tryPatchCursorWrapperDataRows } from '../src/runtime/query-cursor-wrapper-patching'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'
import type { BackfillCache } from '../src/runtime/state'

const cursorRows = Object.freeze([
  Object.freeze({ id: 3, status: 'open', title: 'Third' }),
  Object.freeze({ id: 2, status: 'open', title: 'Second' }),
  Object.freeze({ id: 1, status: 'open', title: 'First' }),
])

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    cursorRowCount: 3,
    cursorRows,
    dependencies: ['db:main:posts'],
    limit: 2,
    orderBy: [{ column: 'id', direction: 'desc' }],
    patchable: true,
    predicates: [{ column: 'status', operator: '=', value: 'open' }],
    tableName: 'posts',
    ...overrides,
  }
}

function createMutation(overrides: Partial<DatabaseMutationEvent> = {}): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind: 'insert',
    predicates: [],
    rows: [],
    tableName: 'posts',
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

describe('@holo-js/realtime cursor wrapper patching', () => {
  it('rejects cursor wrappers without complete cached metadata', async () => {
    await expect(tryPatchCursorWrapperDataRows(createQuery({
      cursorRows: undefined,
    }), [], createBackfills())).resolves.toBeUndefined()
    await expect(tryPatchCursorWrapperDataRows(createQuery({
      cursorRowCount: undefined,
    }), [], createBackfills())).resolves.toBeUndefined()
    await expect(tryPatchCursorWrapperDataRows(createQuery({
      limit: undefined,
    }), [], createBackfills())).resolves.toBeUndefined()
  })

  it('patches matching cursor inserts and keeps one lookahead row', async () => {
    const query = createQuery()

    await expect(tryPatchCursorWrapperDataRows(query, [
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, status: 'open', title: 'Fourth' },
        ],
      }),
    ], createBackfills())).resolves.toEqual({
      nextQuery: {
        ...query,
        cursorRowCount: 4,
        cursorRows: [
          { id: 4, status: 'open', title: 'Fourth' },
          cursorRows[0],
          cursorRows[1],
        ],
      },
      patched: true,
      query,
      value: [
        { id: 4, status: 'open', title: 'Fourth' },
        cursorRows[0],
      ],
    })
  })

  it('keeps cursor wrappers unchanged when mutations do not match predicates', async () => {
    await expect(tryPatchCursorWrapperDataRows(createQuery(), [
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, status: 'closed', title: 'Fourth' },
        ],
      }),
      createMutation({
        kind: 'delete',
        rows: [
          { id: 9, status: 'closed', title: 'Outside' },
        ],
      }),
    ], createBackfills())).resolves.toEqual({ patched: true, unchanged: true })
  })

  it('patches cursor deletes and preserves retained backfill rows', async () => {
    const query = createQuery()

    await expect(tryPatchCursorWrapperDataRows(query, [
      createMutation({
        kind: 'delete',
        rows: [
          { id: 3, status: 'open', title: 'Third' },
        ],
      }),
    ], createBackfills())).resolves.toEqual({
      nextQuery: {
        ...query,
        cursorRowCount: 2,
        cursorRows: [
          cursorRows[1],
          cursorRows[2],
        ],
      },
      patched: true,
      query,
      value: [
        cursorRows[1],
        cursorRows[2],
      ],
    })
  })

  it('updates cursor row count when a matching delete is outside retained rows', async () => {
    const query = createQuery()

    await expect(tryPatchCursorWrapperDataRows(query, [
      createMutation({
        kind: 'delete',
        rows: [
          { id: 99, status: 'open', title: 'Outside retained rows' },
        ],
      }),
    ], createBackfills())).resolves.toEqual({
      nextQuery: {
        ...query,
        cursorRowCount: 2,
        cursorRows,
      },
      patched: true,
      query,
      value: [
        cursorRows[0],
        cursorRows[1],
      ],
    })
  })

  it('falls back when cursor mutation hydration cannot complete', async () => {
    await expect(tryPatchCursorWrapperDataRows(createQuery({
      relatedHydrations: [
        {
          foreignKey: 'post_id',
          kind: 'hasMany',
          localKey: 'id',
          orderBy: [],
          predicates: [],
          relatedConnectionName: 'main',
          relatedTableName: 'comments',
          relationKey: 'comments',
        },
      ],
    }), [
      createMutation({
        kind: 'insert',
        rows: [
          { author_id: 1, id: 4, status: 'open', title: 'Fourth' },
        ],
      }),
    ], createBackfills())).resolves.toBeUndefined()
  })

  it('falls back when cursor belongs-to hydration cannot read mutation rows', async () => {
    await expect(tryPatchCursorWrapperDataRows(createQuery({
      belongsToHydrations: [
        {
          foreignKey: 'author_id',
          ownerKey: 'id',
          relatedConnectionName: 'main',
          relatedTableName: 'authors',
          relationKey: 'author',
        },
      ],
    }), [
      createMutation({
        kind: 'insert',
        rows: [undefined] as unknown as readonly Readonly<Record<string, unknown>>[],
      }),
    ], createBackfills())).resolves.toBeUndefined()
  })

  it('patches returned cursor update and upsert rows', async () => {
    const query = createQuery()

    await expect(tryPatchCursorWrapperDataRows(query, [
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, status: 'open', title: 'Second updated' },
          { id: 1, status: 'closed', title: 'First closed' },
          { id: 4, status: 'open', title: 'Fourth' },
        ],
      }),
      createMutation({
        kind: 'upsert',
        rows: [
          { id: 5, status: 'closed', title: 'Ignored' },
        ],
      }),
    ], createBackfills())).resolves.toEqual({
      nextQuery: {
        ...query,
        cursorRows: [
          { id: 4, status: 'open', title: 'Fourth' },
          cursorRows[0],
          { id: 2, status: 'open', title: 'Second updated' },
        ],
      },
      patched: true,
      query,
      value: [
        { id: 4, status: 'open', title: 'Fourth' },
        cursorRows[0],
      ],
    })
  })

  it('falls back for malformed cursor wrapper mutations', async () => {
    const query = createQuery()
    const malformedMutations: readonly DatabaseMutationEvent[] = [
      createMutation({
        kind: 'insert',
        rows: undefined,
      }),
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, title: 'Missing status' },
        ],
      }),
      createMutation({
        kind: 'delete',
        rows: undefined,
      }),
      createMutation({
        kind: 'delete',
        rows: [
          { id: 3, title: 'Missing status' },
        ],
      }),
      createMutation({
        kind: 'delete',
        rows: [
          { status: 'open', title: 'Missing id' },
        ],
      }),
      createMutation({
        kind: 'update',
        rows: undefined,
      }),
      createMutation({
        kind: 'update',
        rows: [
          { status: 'open', title: 'Missing id' },
        ],
      }),
      createMutation({
        kind: 'update',
        rows: [
          { id: 2, title: 'Missing status' },
        ],
      }),
      createMutation({
        kind: 'replace' as DatabaseMutationEvent['kind'],
      }),
    ]

    for (const mutation of malformedMutations) {
      await expect(tryPatchCursorWrapperDataRows(query, [mutation], createBackfills())).resolves.toBeUndefined()
    }

    await expect(tryPatchCursorWrapperDataRows(createQuery({
      cursorRowCount: 0,
    }), [
      createMutation({
        kind: 'delete',
        rows: [
          { id: 3, status: 'open', title: 'Third' },
        ],
      }),
    ], createBackfills())).resolves.toBeUndefined()
  })

  it('falls back when changed cursor rows cannot be sorted or fill the visible page', async () => {
    await expect(tryPatchCursorWrapperDataRows(createQuery({
      orderBy: [{ column: 'priority', direction: 'desc' }],
    }), [
      createMutation({
        kind: 'insert',
        rows: [
          { id: 4, status: 'open', title: 'Fourth' },
        ],
      }),
    ], createBackfills())).resolves.toBeUndefined()

    await expect(tryPatchCursorWrapperDataRows(createQuery({
      cursorRows: [
        { id: 1, status: 'open', title: 'First' },
      ],
      cursorRowCount: 2,
      limit: 2,
      orderBy: [{ column: 'id', direction: 'desc' }],
    }), [
      createMutation({
        kind: 'delete',
        rows: [
          { id: 1, status: 'open', title: 'First' },
        ],
      }),
    ], createBackfills())).resolves.toBeUndefined()
  })
})
