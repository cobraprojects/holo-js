import { describe, expect, it } from 'vitest'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
} from '../src/runtime/dependencies'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from '../src/runtime/query-patch-results'
import { tryPatchQueryRelation } from '../src/runtime/query-relation-patching'
import type {
  DatabaseQueryBelongsToParentKeyRelationObservation,
  DatabaseQueryBelongsToManyRelationObservation,
  DatabaseQueryObservation,
} from '../src/runtime/query-state'
import type { BackfillCache } from '../src/runtime/state'

describe('@holo-js/realtime relation query patching', () => {
  it('rejects non-relation, unpatchable, and invalid belongs-to-many values', async () => {
    const query = createBelongsToManyQuery()
    const mutation = createPivotMutation('insert', [
      { post_id: 1, tag_id: 2, position: 20 },
    ])

    await expect(tryPatchQueryRelation(
      { ...query, relation: undefined },
      [],
      [mutation],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      { ...query, patchable: false },
      [],
      [mutation],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      { id: 1 },
      [mutation],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      [1],
      [mutation],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('inserts ordered belongs-to-many rows from mutation-indexed related rows', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(3, 'Third', 30),
    ])
    const mutation = createPivotMutation('insert', [
      { post_id: 1, tag_id: 2, position: 20 },
    ])
    const result = await tryPatchQueryRelation(
      query,
      rows,
      [mutation],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(1, 'First', 10),
        createRelatedRow(2, 'Second', 20),
        createRelatedRow(3, 'Third', 30),
      ],
    })
  })

  it('keeps duplicate ordered belongs-to-many inserts unchanged', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(2, 'Second', 20),
    ])
    const mutation = createPivotMutation('insert', [
      { post_id: 1, tag_id: 2, position: 20 },
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [mutation],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('falls back for unordered belongs-to-many inserts and missing returned rows', async () => {
    const query = createBelongsToManyQuery({
      pivotOrderBy: Object.freeze([]),
    })
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('insert', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      createBelongsToManyQuery(),
      rows,
      [{ ...createPivotMutation('insert', []), rows: undefined }],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('keeps belongs-to-many pivot mutations unchanged when predicates or rows miss', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('insert', [
        { post_id: 2, tag_id: 2, position: 20 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('delete', [
        { post_id: 1, tag_id: 99, position: 99 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
    await expect(tryPatchQueryRelation(
      {
        ...query,
        predicates: Object.freeze([
          { column: 'post_id', operator: '>', value: 0 },
        ]),
      },
      rows,
      [createPivotMutation('insert', [
        { tag_id: 2, position: 20 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('falls back for unsupported belongs-to-many pivot mutation kinds and missing related rows', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('upsert', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('insert', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills([
        { ...createRelatedMutation('insert', []), rows: undefined },
      ]),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('insert', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 99, name: 'Outside' },
        ]),
      ]),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('updates and reorders belongs-to-many pivot rows without refetching', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(2, 'Second', 20),
      createRelatedRow(3, 'Third', 30),
    ])
    const result = await tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('update', [
        { post_id: 1, tag_id: 3, position: 5 },
      ])],
      createBackfills(),
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(3, 'Third', 5),
        createRelatedRow(1, 'First', 10),
        createRelatedRow(2, 'Second', 20),
      ],
    })
  })

  it('keeps belongs-to-many pivot updates unchanged when the related row is outside the current relation', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('update', [
        { post_id: 1, tag_id: 99, position: 5 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('updates unordered belongs-to-many pivot rows without reordering', async () => {
    const query = createBelongsToManyQuery({
      pivotOrderBy: Object.freeze([]),
    })
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(2, 'Second', 20),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('update', [
        { post_id: 1, tag_id: 2, position: 5 },
      ])],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(1, 'First', 10),
        createRelatedRow(2, 'Second', 5),
      ],
    })
  })

  it('orders belongs-to-many rows with descending string pivot columns', async () => {
    const query = createBelongsToManyQuery({
      pivotColumns: Object.freeze(['label']),
      pivotOrderBy: Object.freeze([
        { column: 'label', direction: 'desc' },
      ]),
    })
    const rows = Object.freeze([
      createRelatedRowWithPivot(1, 'First', { label: 'b', post_id: 1, tag_id: 1 }),
      createRelatedRowWithPivot(3, 'Third', { label: 'a', post_id: 1, tag_id: 3 }),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('insert', [
        { label: 'c', post_id: 1, tag_id: 2 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        createRelatedRowWithPivot(2, 'Second', { label: 'c', post_id: 1, tag_id: 2 }),
        createRelatedRowWithPivot(1, 'First', { label: 'b', post_id: 1, tag_id: 1 }),
        createRelatedRowWithPivot(3, 'Third', { label: 'a', post_id: 1, tag_id: 3 }),
      ],
    })
  })

  it('inserts ordered belongs-to-many rows after equal and lower pivot values', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(2, 'Second', 20),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('insert', [
        { post_id: 1, tag_id: 3, position: 20 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 3, name: 'Third' },
        ]),
      ]),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(1, 'First', 10),
        createRelatedRow(2, 'Second', 20),
        createRelatedRow(3, 'Third', 20),
      ],
    })
  })

  it('falls back when ordered belongs-to-many rows contain sparse or non-comparable pivot data', async () => {
    const query = createBelongsToManyQuery()
    const sparseRows: Readonly<Record<string, unknown>>[] = [
      createRelatedRow(1, 'First', 10),
    ]
    sparseRows.length = 2

    await expect(tryPatchQueryRelation(
      query,
      sparseRows,
      [createPivotMutation('insert', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      [
        Object.freeze({
          id: 1,
          name: 'First',
          pivot: 'invalid',
        }),
      ],
      [createPivotMutation('insert', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('falls back when ordered belongs-to-many pivot updates cannot compare retained rows', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      Object.freeze({
        id: 1,
        name: 'First',
        pivot: Object.freeze({
          post_id: 1,
          tag_id: 1,
        }),
      }),
      createRelatedRow(2, 'Second', 20),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('update', [
        { post_id: 1, tag_id: 2, position: 5 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('removes belongs-to-many rows for matching pivot deletes', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(2, 'Second', 20),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('delete', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(1, 'First', 10),
      ],
    })
  })

  it('keeps related belongs-to-many inserts unchanged', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('insert', [
        { id: 1, name: 'Inserted' },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('updates related belongs-to-many rows while preserving pivot data', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(2, 'Second', 20),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('update', [
        { id: 2, name: 'Updated', pivot: { position: 999 } },
      ])],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(1, 'First', 10),
        createRelatedRow(2, 'Updated', 20),
      ],
    })
  })

  it('keeps related belongs-to-many updates unchanged when the related row is outside the current relation', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('update', [
        { id: 99, name: 'Outside' },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('patches related belongs-to-many upserts while preserving pivot data', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('upsert', [
        { id: 1, name: 'Upserted' },
      ])],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(1, 'Upserted', 10),
      ],
    })
  })

  it('removes related belongs-to-many rows for related deletes', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
      createRelatedRow(2, 'Second', 20),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('delete', [
        { id: 1, name: 'First' },
      ])],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        createRelatedRow(2, 'Second', 20),
      ],
    })
  })

  it('keeps related belongs-to-many deletes unchanged when the related row is outside the current relation', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('delete', [
        { id: 99, name: 'Outside' },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('falls back for malformed belongs-to-many relation mutations', async () => {
    const query = createBelongsToManyQuery()
    const rows = Object.freeze([
      createRelatedRow(1, 'First', 10),
    ])
    const sparseRows: Readonly<Record<string, unknown>>[] = [
      createRelatedRow(1, 'First', 10),
    ]
    sparseRows.length = 2

    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('update', [
        { post_id: 1, position: 5 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createPivotMutation('delete', [
        { post_id: 1, position: 5 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('update', [
        { name: 'Missing id' },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      rows,
      [createRelatedMutation('delete', [
        { name: 'Missing id' },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      sparseRows,
      [createRelatedMutation('update', [
        { id: 2, name: 'Sparse' },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      sparseRows,
      [createPivotMutation('update', [
        { post_id: 1, tag_id: 2, position: 5 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      sparseRows,
      [createPivotMutation('delete', [
        { post_id: 1, tag_id: 2, position: 5 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      [
        Object.freeze({
          id: 1,
          name: 'First',
        }),
      ],
      [createPivotMutation('insert', [
        { post_id: 1, tag_id: 2, position: 20 },
      ])],
      createBackfills([
        createRelatedMutation('insert', [
          { id: 2, name: 'Second' },
        ]),
      ]),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('patches belongs-to parent-key relation swaps from returned rows', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))

    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 1, author_id: 2 },
      ])],
      createBackfills([
        createAuthorMutation('update', [
          { id: 2, name: 'New author' },
        ]),
      ]),
    )).resolves.toEqual({
      patched: true,
      query,
      value: createPostValue(2, { id: 2, name: 'New author' }),
    })
  })

  it('patches belongs-to parent-key relations from exact mutation predicates', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))
    const mutation: DatabaseMutationEvent = {
      connectionName: 'main',
      kind: 'update',
      predicates: Object.freeze([
        { column: 'id', operator: '=', value: 1 },
      ]),
      tableName: 'posts',
      values: Object.freeze({ author_id: 2 }),
    }

    await expect(tryPatchQueryRelation(
      query,
      value,
      [mutation],
      createBackfills([
        createAuthorMutation('update', [
          { id: 2, name: 'Second author' },
        ]),
      ]),
    )).resolves.toEqual({
      patched: true,
      query,
      value: createPostValue(2, { id: 2, name: 'Second author' }),
    })
  })

  it('patches belongs-to parent-key relation value changes without changing the foreign key', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))

    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 1, author_id: 1 },
      ])],
      createBackfills([
        createAuthorMutation('update', [
          { id: 1, name: 'Updated author' },
        ]),
      ]),
    )).resolves.toEqual({
      patched: true,
      query,
      value: createPostValue(1, { id: 1, name: 'Updated author' }),
    })
  })

  it('keeps belongs-to parent-key relation unchanged when hydrated value is already current', async () => {
    const query = createBelongsToParentKeyQuery()
    const author = Object.freeze({ id: 1, name: 'Old author' })
    const value = createPostValue(1, author)

    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 1, author_id: 1 },
      ])],
      createBackfills([
        createAuthorMutation('update', [
          author,
        ]),
      ]),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('patches belongs-to parent-key relations to null foreign keys', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))

    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 1, author_id: null },
      ])],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: createPostValue(null, null),
    })
  })

  it('patches belongs-to parent-key relations from mutation values and predicates', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))
    const mutation: DatabaseMutationEvent = {
      connectionName: 'main',
      kind: 'update',
      predicates: Object.freeze([
        { column: 'id', operator: 'in', value: [1, 2] },
      ]),
      tableName: 'posts',
      values: Object.freeze({ author_id: 3 }),
    }

    await expect(tryPatchQueryRelation(
      query,
      value,
      [mutation],
      createBackfills([
        createAuthorMutation('update', [
          { id: 3, name: 'Third author' },
        ]),
      ]),
    )).resolves.toEqual({
      patched: true,
      query,
      value: createPostValue(3, { id: 3, name: 'Third author' }),
    })
  })

  it('keeps belongs-to parent-key mutation values unchanged when predicates exclude the query', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))
    const mutation: DatabaseMutationEvent = {
      connectionName: 'main',
      kind: 'update',
      predicates: Object.freeze([
        { column: 'id', operator: '=', value: 2 },
      ]),
      tableName: 'posts',
      values: Object.freeze({ author_id: 3 }),
    }

    await expect(tryPatchQueryRelation(
      query,
      value,
      [mutation],
      createBackfills([
        createAuthorMutation('update', [
          { id: 3, name: 'Third author' },
        ]),
      ]),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('keeps belongs-to parent-key relation mutations unchanged when they do not affect the row', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))

    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('delete', [
        { id: 1, author_id: 2 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 1, title: 'Updated title' },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      value,
      [{
        connectionName: 'main',
        kind: 'update',
        predicates: Object.freeze([
          { column: 'id', operator: '=', value: 1 },
        ]),
        tableName: 'posts',
        values: Object.freeze({ title: 'Updated title' }),
      }],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 2, author_id: 2 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
  })

  it('falls back for unsafe belongs-to parent-key row predicates', async () => {
    const query = {
      ...createBelongsToParentKeyQuery(),
      predicates: Object.freeze([
        { column: 'id', operator: 'contains', value: 1 },
      ]),
    }
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))

    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 1, author_id: 2 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
  })

  it('falls back for malformed belongs-to parent-key relation mutations', async () => {
    const query = createBelongsToParentKeyQuery()
    const value = createPostValue(1, Object.freeze({ id: 1, name: 'Old author' }))

    await expect(tryPatchQueryRelation(
      query,
      [],
      [createPostMutation('update', [
        { id: 1, author_id: 2 },
      ])],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      value,
      [{
        connectionName: 'main',
        kind: 'update',
        predicates: Object.freeze([]),
        tableName: 'posts',
      }],
      createBackfills(),
    )).resolves.toBe(UNCHANGED_QUERY_RESULT)
    await expect(tryPatchQueryRelation(
      {
        ...query,
        predicates: Object.freeze([
          { column: 'id', operator: '>', value: 0 },
        ]),
      },
      value,
      [{
        connectionName: 'main',
        kind: 'update',
        predicates: Object.freeze([
          { column: 'id', operator: '=', value: 1 },
        ]),
        tableName: 'posts',
        values: Object.freeze({ author_id: 2 }),
      }],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      value,
      [{
        connectionName: 'main',
        kind: 'update',
        predicates: Object.freeze([
          { column: 'title', operator: '=', value: 'Missing id predicate' },
        ]),
        tableName: 'posts',
        values: Object.freeze({ author_id: 2 }),
      }],
      createBackfills(),
    )).resolves.toBe(UNPATCHED_RESULT)
    await expect(tryPatchQueryRelation(
      query,
      value,
      [createPostMutation('update', [
        { id: 1, author_id: 2 },
      ])],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: createPostValue(2, null),
    })
  })
})

function createBelongsToManyQuery(
  relationOverrides: Partial<DatabaseQueryBelongsToManyRelationObservation> = {},
): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: Object.freeze([]),
    orderBy: Object.freeze([]),
    patchable: true,
    predicates: Object.freeze([
      { column: 'post_id', operator: '=', value: 1 },
    ]),
    relation: {
      foreignPivotKey: 'post_id',
      kind: 'belongsToMany',
      pivotAccessor: 'pivot',
      pivotColumns: Object.freeze(['position']),
      pivotOrderBy: Object.freeze([
        { column: 'position', direction: 'asc' },
      ]),
      relatedConnectionName: 'main',
      relatedKey: 'id',
      relatedPivotKey: 'tag_id',
      relatedTableName: 'tags',
      ...relationOverrides,
    },
    tableName: 'post_tags',
  }
}

function createBelongsToParentKeyQuery(
  relationOverrides: Partial<DatabaseQueryBelongsToParentKeyRelationObservation> = {},
): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: Object.freeze([]),
    orderBy: Object.freeze([]),
    patchable: true,
    predicates: Object.freeze([
      { column: 'id', operator: '=', value: 1 },
    ]),
    relation: {
      foreignKey: 'author_id',
      kind: 'belongsToParentKey',
      ownerKey: 'id',
      relationKey: 'author',
      relatedConnectionName: 'main',
      relatedTableName: 'authors',
      ...relationOverrides,
    },
    tableName: 'posts',
  }
}

function createRelatedRow(
  id: number,
  name: string,
  position: number,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id,
    name,
    pivot: Object.freeze({
      post_id: 1,
      tag_id: id,
      position,
    }),
  })
}

function createRelatedRowWithPivot(
  id: number,
  name: string,
  pivot: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id,
    name,
    pivot: Object.freeze(pivot),
  })
}

function createPostValue(
  authorId: number | null,
  author: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: 1,
    author_id: authorId,
    author,
  })
}

function createPivotMutation(
  kind: DatabaseMutationEvent['kind'],
  rows: readonly Readonly<Record<string, unknown>>[],
): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind,
    predicates: Object.freeze([]),
    rows: Object.freeze(rows),
    tableName: 'post_tags',
  }
}

function createRelatedMutation(
  kind: DatabaseMutationEvent['kind'],
  rows: readonly Readonly<Record<string, unknown>>[],
): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind,
    predicates: Object.freeze([]),
    rows: Object.freeze(rows),
    tableName: 'tags',
  }
}

function createPostMutation(
  kind: DatabaseMutationEvent['kind'],
  rows: readonly Readonly<Record<string, unknown>>[],
): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind,
    predicates: Object.freeze([]),
    rows: Object.freeze(rows),
    tableName: 'posts',
  }
}

function createAuthorMutation(
  kind: DatabaseMutationEvent['kind'],
  rows: readonly Readonly<Record<string, unknown>>[],
): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind,
    predicates: Object.freeze([]),
    rows: Object.freeze(rows),
    tableName: 'authors',
  }
}

function createBackfills(
  relatedMutations: readonly DatabaseMutationEvent[] = Object.freeze([]),
): BackfillCache {
  const mutations = new Map<string, DatabaseMutationEvent[]>()
  for (const mutation of relatedMutations) {
    const key = createMutationIndexKey(mutation.connectionName, mutation.tableName)
    const indexedMutations = mutations.get(key)
    if (indexedMutations) {
      indexedMutations.push(mutation)
      continue
    }

    mutations.set(key, [mutation])
  }

  return {
    aggregates: new Map(),
    aggregateSql: new Map(),
    entries: Object.freeze([]),
    mutationMetadata: new WeakMap(),
    mutations,
    paginationCounts: new Map(),
    rows: new Map(),
  }
}
