import { afterEach, describe, expect, it } from 'vitest'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
} from '../src/runtime/dependencies'
import {
  configureRealtimeRuntime,
  resetRealtimeRuntime,
} from '../src/runtime/lifecycle'
import {
  hydrateBelongsToMutationRows,
  hydrateBelongsToRow,
  readBelongsToHydratedValue,
} from '../src/runtime/query-belongs-to-hydration'
import type {
  BackfillCache,
  BackfillRows,
  DatabaseQueryBelongsToHydrationObservation,
  RowGroupedBackfillCache,
} from '../src/runtime/query-state'
import { createFakeDatabase } from './helpers/fake-database'

function createAuthorHydration(
  overrides: Partial<DatabaseQueryBelongsToHydrationObservation> = {},
): DatabaseQueryBelongsToHydrationObservation {
  return {
    foreignKey: 'author_id',
    ownerKey: 'id',
    relatedConnectionName: 'main',
    relatedTableName: 'users',
    relationKey: 'author',
    ...overrides,
  }
}

function createMutation(
  tableName: string,
  kind: DatabaseMutationEvent['kind'],
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind,
    predicates: [],
    rows,
    tableName,
  }
}

function createBackfills(
  mutations: readonly DatabaseMutationEvent[] = [],
  rowGroups?: RowGroupedBackfillCache,
  rows: readonly (readonly [string, Promise<BackfillRows | undefined>])[] = [],
): BackfillCache {
  const mutationIndex = new Map<string, DatabaseMutationEvent[]>()
  for (const mutation of mutations) {
    const key = createMutationIndexKey(mutation.connectionName, mutation.tableName)
    const indexed = mutationIndex.get(key)
    if (indexed) {
      indexed.push(mutation)
      continue
    }

    mutationIndex.set(key, [mutation])
  }

  return {
    aggregateSql: new Map(),
    aggregates: new Map(),
    entries: [],
    mutationMetadata: new WeakMap(),
    mutations: mutationIndex,
    paginationCounts: new Map(),
    rowGroups,
    rows: new Map(rows),
  }
}

describe('@holo-js/realtime belongs-to hydration', () => {
  afterEach(() => {
    resetRealtimeRuntime()
  })

  it('keeps mutations unchanged when belongs-to hydration is not applicable', async () => {
    const mutation = createMutation('posts', 'insert', [
      { author_id: 1, id: 1, title: 'Post' },
    ])

    await expect(hydrateBelongsToMutationRows(mutation, undefined, createBackfills())).resolves.toBe(mutation)
    await expect(hydrateBelongsToMutationRows(mutation, [], createBackfills())).resolves.toBe(mutation)
    await expect(hydrateBelongsToMutationRows({
      ...mutation,
      rows: undefined,
    }, [createAuthorHydration()], createBackfills())).resolves.toEqual({
      ...mutation,
      rows: undefined,
    })
    await expect(hydrateBelongsToMutationRows({
      ...mutation,
      kind: 'delete',
    }, [createAuthorHydration()], createBackfills())).resolves.toEqual({
      ...mutation,
      kind: 'delete',
    })
  })

  it('keeps unchanged mutation rows and rejects sparse mutation rows', async () => {
    const unchangedMutation = createMutation('posts', 'insert', [
      { author: null, author_id: null, id: 1 },
    ])
    const sparseRows: Readonly<Record<string, unknown>>[] = [
      { author_id: 1, id: 1 },
    ]
    sparseRows.length = 2

    await expect(hydrateBelongsToMutationRows(
      unchangedMutation,
      [createAuthorHydration()],
      createBackfills(),
    )).resolves.toBe(unchangedMutation)
    await expect(hydrateBelongsToMutationRows(
      createMutation('posts', 'insert', sparseRows),
      [createAuthorHydration()],
      createBackfills(),
    )).resolves.toBeUndefined()
  })

  it('hydrates belongs-to rows from related mutation rows and deletes', async () => {
    const hydration = createAuthorHydration()
    const row = Object.freeze({ author_id: 1, id: 10, title: 'Post' })
    const deletedRow = Object.freeze({ author_id: 2, id: 11, title: 'Deleted author post' })

    await expect(hydrateBelongsToRow(row, [hydration], createBackfills([
      createMutation('users', 'insert', [
        { id: 1, name: 'Ada' },
      ]),
    ]))).resolves.toEqual({
      author: { id: 1, name: 'Ada' },
      author_id: 1,
      id: 10,
      title: 'Post',
    })

    await expect(hydrateBelongsToRow(deletedRow, [hydration], createBackfills([
      createMutation('users', 'delete', [
        { id: 2, name: 'Grace' },
      ]),
    ]))).resolves.toEqual({
      author: null,
      author_id: 2,
      id: 11,
      title: 'Deleted author post',
    })
  })

  it('hydrates null and missing belongs-to keys without backfilling', async () => {
    await expect(hydrateBelongsToRow(
      Object.freeze({ author_id: null, id: 1 }),
      [createAuthorHydration()],
      createBackfills(),
    )).resolves.toEqual({
      author: null,
      author_id: null,
      id: 1,
    })
    await expect(hydrateBelongsToRow(
      Object.freeze({ id: 2 }),
      [createAuthorHydration()],
      createBackfills(),
    )).resolves.toEqual({
      author: null,
      id: 2,
    })
  })

  it('preserves unchanged rows when the belongs-to relation value is already current', async () => {
    const author = Object.freeze({ id: 1, name: 'Ada' })
    const row = Object.freeze({
      author,
      author_id: 1,
      id: 1,
    })

    await expect(hydrateBelongsToRow(row, [createAuthorHydration()], createBackfills([
      createMutation('users', 'insert', [author]),
    ]))).resolves.toBe(row)
  })

  it('hydrates grouped belongs-to rows with one related backfill', async () => {
    const database = createFakeDatabase(() => [
      { id: 1, name: 'Ada' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const mutation = createMutation('posts', 'insert', [
      { author_id: 1, id: 10, title: 'First' },
      { author_id: 2, id: 11, title: 'Second' },
      { author_id: 1, id: 12, title: 'Duplicate author' },
      { author_id: null, id: 13, title: 'No author' },
    ])

    await expect(hydrateBelongsToMutationRows(
      mutation,
      [createAuthorHydration()],
      createBackfills([mutation], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 10,
          title: 'First',
        },
        {
          author: null,
          author_id: 2,
          id: 11,
          title: 'Second',
        },
        {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 12,
          title: 'Duplicate author',
        },
        {
          author: null,
          author_id: null,
          id: 13,
          title: 'No author',
        },
      ],
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.bindings).toEqual([1, 2])
  })

  it('falls back to single belongs-to backfills when grouped rows cannot be keyed', async () => {
    const database = createFakeDatabase(() => [
      { name: 'Missing id' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const mutation = createMutation('posts', 'insert', [
      { author_id: 1, id: 10, title: 'First' },
      { author_id: 2, id: 11, title: 'Second' },
    ])

    await expect(hydrateBelongsToMutationRows(
      mutation,
      [createAuthorHydration()],
      createBackfills([mutation], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          author: { name: 'Missing id' },
          author_id: 1,
          id: 10,
          title: 'First',
        },
        {
          author: { name: 'Missing id' },
          author_id: 2,
          id: 11,
          title: 'Second',
        },
      ],
    })
    expect(database.queries).toHaveLength(3)
  })

  it('uses cached single belongs-to backfills and exposes direct value lookup', async () => {
    const hydration = createAuthorHydration()
    const author = Object.freeze({ id: 1, name: 'Ada' })

    await expect(hydrateBelongsToRow(
      Object.freeze({ author_id: 1, id: 1 }),
      [hydration],
      createBackfills([], undefined, [
        ['belongs-to:main:users:id:1', Promise.resolve([author])],
      ]),
    )).resolves.toEqual({
      author,
      author_id: 1,
      id: 1,
    })

    await expect(readBelongsToHydratedValue(
      hydration,
      1,
      createBackfills([], undefined, [
        ['belongs-to:main:users:id:1', Promise.resolve([])],
      ]),
    )).resolves.toBeNull()
  })

  it('continues past related mutations without rows and falls back when none match', async () => {
    const hydration = createAuthorHydration()

    await expect(readBelongsToHydratedValue(
      hydration,
      1,
      createBackfills([
        createMutation('users', 'update', undefined),
        createMutation('users', 'insert', [
          { id: 2, name: 'Grace' },
        ]),
      ]),
    )).resolves.toBeNull()
  })

  it('falls back from grouped belongs-to backfills when grouping is not useful', async () => {
    const hydration = createAuthorHydration()
    const mutation = createMutation('posts', 'insert', [
      { author_id: 1, id: 10 },
    ])

    await expect(readBelongsToHydratedValue(
      hydration,
      1,
      createBackfills([
        mutation,
      ], new Map()),
      mutation,
    )).resolves.toBeNull()
    await expect(readBelongsToHydratedValue(
      hydration,
      1,
      createBackfills([], new Map()),
      mutation,
    )).resolves.toBeNull()
  })

  it('falls back from grouped belongs-to backfills when source rows are ignored or unavailable', async () => {
    const hydration = createAuthorHydration()
    const mutation = createMutation('posts', 'insert', [
      { author_id: 1, id: 10 },
      { author_id: 2, id: 11 },
    ])

    await expect(readBelongsToHydratedValue(
      hydration,
      1,
      createBackfills([
        createMutation('posts', 'delete', [
          { author_id: 1, id: 10 },
        ]),
        createMutation('posts', 'insert', undefined),
        mutation,
      ], new Map()),
      mutation,
    )).resolves.toBeNull()
  })
})
