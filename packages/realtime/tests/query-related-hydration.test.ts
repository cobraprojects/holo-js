import {
  createCapabilities,
  DatabaseContext,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
} from '@holo-js/db'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
} from '../src/runtime/dependencies'
import {
  hydrateRelatedMutationRows,
  hydrateRelatedRow,
} from '../src/runtime/query-related-hydration'
import type {
  BackfillCache,
  DatabaseQueryRelatedHydrationObservation,
} from '../src/runtime/query-state'
import {
  configureRealtimeRuntime,
  resetRealtimeRuntime,
} from '../src/server'
import { stableStringify } from '../src/runtime/stable-stringify'

describe('@holo-js/realtime related query hydration', () => {
  afterEach(() => {
    resetRealtimeRuntime()
  })

  it('keeps mutations unchanged when related hydration is not applicable', async () => {
    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
    ])

    await expect(hydrateRelatedMutationRows(
      mutation,
      undefined,
      createBackfills(),
    )).resolves.toBe(mutation)
    await expect(hydrateRelatedMutationRows(
      mutation,
      Object.freeze([]),
      createBackfills(),
    )).resolves.toBe(mutation)
    await expect(hydrateRelatedMutationRows(
      { ...mutation, rows: undefined },
      [createPostsHydration()],
      createBackfills(),
    )).resolves.toEqual({ ...mutation, rows: undefined })
    await expect(hydrateRelatedMutationRows(
      { ...mutation, kind: 'delete' },
      [createPostsHydration()],
      createBackfills(),
    )).resolves.toEqual({ ...mutation, kind: 'delete' })
  })

  it('hydrates has-many relation rows from related mutation rows', async () => {
    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
    ])
    const hydration = createPostsHydration({
      orderBy: Object.freeze([
        { column: 'title', direction: 'asc' },
      ]),
      predicates: Object.freeze([
        { column: 'status', operator: '=', value: 'published' },
      ]),
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([
        createPostMutation('insert', [
          { id: 2, user_id: 1, status: 'published', title: 'B' },
          { id: 1, user_id: 1, status: 'published', title: 'A' },
          { id: 3, user_id: 1, status: 'draft', title: 'C' },
          { id: 4, user_id: 2, status: 'published', title: 'D' },
        ]),
      ]),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, user_id: 1, status: 'published', title: 'A' },
            { id: 2, user_id: 1, status: 'published', title: 'B' },
          ],
        },
      ],
    })
  })

  it('hydrates has-one relation rows from related mutation rows', async () => {
    const row = Object.freeze({ id: 1, name: 'Ada' })
    const hydration = createPostsHydration({
      kind: 'hasOne',
      orderBy: Object.freeze([
        { column: 'score', direction: 'desc' },
      ]),
      relationKey: 'featuredPost',
    })

    await expect(hydrateRelatedRow(
      row,
      [hydration],
      createBackfills([
        createPostMutation('insert', [
          { id: 1, user_id: 1, score: 10, title: 'Low' },
          { id: 2, user_id: 1, score: 20, title: 'High' },
        ]),
      ]),
    )).resolves.toEqual({
      id: 1,
      name: 'Ada',
      featuredPost: { id: 2, user_id: 1, score: 20, title: 'High' },
    })
  })

  it('hydrates null and missing local keys without backfilling', async () => {
    await expect(hydrateRelatedRow(
      Object.freeze({ id: null }),
      [createPostsHydration()],
      createBackfills(),
    )).resolves.toEqual({
      id: null,
      posts: [],
    })
    await expect(hydrateRelatedRow(
      Object.freeze({ name: 'Missing id' }),
      [createPostsHydration({
        kind: 'hasOne',
        relationKey: 'featuredPost',
      })],
      createBackfills(),
    )).resolves.toEqual({
      name: 'Missing id',
      featuredPost: null,
    })
  })

  it('uses cached related backfill rows and preserves unchanged row references', async () => {
    const hydration = createPostsHydration()
    const posts = Object.freeze([
      Object.freeze({ id: 1, user_id: 1, title: 'Cached' }),
    ])
    const row = Object.freeze({
      id: 1,
      name: 'Ada',
      posts,
    })

    await expect(hydrateRelatedRow(
      row,
      [hydration],
      createBackfills([], [
        [createRelatedHydrationBackfillKey(hydration, 1), Promise.resolve(posts)],
      ]),
    )).resolves.toBe(row)
  })

  it('hydrates single rows from direct related backfill queries with predicates and ordering', async () => {
    const adapter = new RelatedHydrationAdapter([
      { id: 2, status: 'published', title: 'Beta', user_id: 1 },
      { id: 1, status: 'published', title: 'Alpha', user_id: 1 },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const hydration = createPostsHydration({
      orderBy: Object.freeze([
        { column: 'title', direction: 'asc' },
      ]),
      predicates: Object.freeze([
        { column: 'status', operator: '=', value: 'published' },
      ]),
    })

    await expect(hydrateRelatedRow(
      Object.freeze({ id: 1, name: 'Ada' }),
      [hydration],
      createBackfills(),
    )).resolves.toEqual({
      id: 1,
      name: 'Ada',
      posts: [
        { id: 1, status: 'published', title: 'Alpha', user_id: 1 },
        { id: 2, status: 'published', title: 'Beta', user_id: 1 },
      ],
    })
    expect(adapter.queries).toHaveLength(1)
    expect(adapter.queries[0]?.sql).toContain('"status" = ?2')
    expect(adapter.queries[0]?.sql).toContain('ORDER BY "title" ASC')
  })

  it('keeps mutation rows unchanged when existing related values are current', async () => {
    const hydration = createPostsHydration()
    const posts = Object.freeze([
      Object.freeze({ id: 1, user_id: 1, title: 'Cached' }),
    ])
    const mutation = createUserMutation('insert', [
      Object.freeze({
        id: 1,
        name: 'Ada',
        posts,
      }),
    ])

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([], [
        [createRelatedHydrationBackfillKey(hydration, 1), Promise.resolve(posts)],
      ]),
    )).resolves.toBe(mutation)
  })

  it('preserves earlier mutation rows before later rows are hydrated', async () => {
    const hydration = createPostsHydration()
    const firstPosts = Object.freeze([
      Object.freeze({ id: 1, user_id: 1, title: 'Cached' }),
    ])
    const mutation = createUserMutation('insert', [
      Object.freeze({
        id: 1,
        name: 'Ada',
        posts: firstPosts,
      }),
      Object.freeze({
        id: 2,
        name: 'Grace',
      }),
    ])

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([
        createPostMutation('insert', [
          { id: 2, user_id: 2, title: 'New' },
        ]),
      ], [
        [createRelatedHydrationBackfillKey(hydration, 1), Promise.resolve(firstPosts)],
      ]),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        mutation.rows?.[0],
        {
          id: 2,
          name: 'Grace',
          posts: [
            { id: 2, user_id: 2, title: 'New' },
          ],
        },
      ],
    })
  })

  it('returns undefined when related rows cannot be hydrated safely', async () => {
    await expect(hydrateRelatedRow(
      Object.freeze({ id: 1 }),
      [createPostsHydration()],
      createBackfills(),
    )).resolves.toBeUndefined()

    const sparseRows: Readonly<Record<string, unknown>>[] = [
      Object.freeze({ id: 1 }),
    ]
    sparseRows.length = 2

    await expect(hydrateRelatedMutationRows(
      createUserMutation('insert', sparseRows),
      [createPostsHydration()],
      createBackfills([
        createPostMutation('insert', [
          { id: 1, user_id: 1 },
        ]),
      ]),
    )).resolves.toBeUndefined()
  })

  it('skips unusable related mutation rows before falling back', async () => {
    await expect(hydrateRelatedRow(
      Object.freeze({ id: 1 }),
      [createPostsHydration()],
      createBackfills([
        createPostMutation('delete', [
          { id: 1, user_id: 1 },
        ]),
        createPostMutation('insert', undefined),
      ]),
    )).resolves.toBeUndefined()
  })

  it('falls back when grouped related hydration has no source mutation rows', async () => {
    await expect(hydrateRelatedMutationRows(
      createUserMutation('insert', [
        { id: 1, name: 'Ada' },
      ]),
      [createPostsHydration()],
      createBackfills([], [], new Map()),
    )).resolves.toBeUndefined()

    await expect(hydrateRelatedMutationRows(
      createUserMutation('insert', [
        { id: 1, name: 'Ada' },
      ]),
      [createPostsHydration()],
      createBackfills([
        createUserMutation('delete', [
          { id: 1, name: 'Ada' },
        ]),
        createUserMutation('insert', undefined),
        createUserMutation('insert', [
          { id: null, name: 'No id' },
          { name: 'Missing id' },
          { id: 1, name: 'Ada' },
          { id: 1, name: 'Duplicate' },
        ]),
      ], [], new Map()),
    )).resolves.toBeUndefined()
  })

  it('falls back when related hydration predicates cannot be backfilled', async () => {
    const adapter = new RelatedHydrationAdapter([])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    await expect(hydrateRelatedRow(
      Object.freeze({ id: 1 }),
      [createPostsHydration({
        predicates: Object.freeze([
          { column: 'title', operator: 'regex', value: '^A' },
        ]),
      })],
      createBackfills(),
    )).resolves.toBeUndefined()
    expect(adapter.queries).toHaveLength(0)
  })

  it('sorts related mutation rows with equal, null, and missing order values', async () => {
    const row = Object.freeze({ id: 1, name: 'Ada' })
    const hydration = createPostsHydration({
      orderBy: Object.freeze([
        { column: 'score', direction: 'asc' },
        { column: 'title', direction: 'asc' },
      ]),
    })

    await expect(hydrateRelatedRow(
      row,
      [hydration],
      createBackfills([
        createPostMutation('insert', [
          { id: 3, user_id: 1, score: 2, title: 'Beta' },
          { id: 1, user_id: 1, score: null, title: 'Null' },
          { id: 2, user_id: 1, title: 'Missing' },
          { id: 4, user_id: 1, score: 2, title: 'Alpha' },
        ]),
      ]),
    )).resolves.toEqual({
      id: 1,
      name: 'Ada',
      posts: [
        { id: 2, user_id: 1, title: 'Missing' },
        { id: 1, user_id: 1, score: null, title: 'Null' },
        { id: 4, user_id: 1, score: 2, title: 'Alpha' },
        { id: 3, user_id: 1, score: 2, title: 'Beta' },
      ],
    })
  })

  it('keeps equal related order rows stable', async () => {
    const row = Object.freeze({ id: 1, name: 'Ada' })
    const hydration = createPostsHydration({
      orderBy: Object.freeze([
        { column: 'score', direction: 'asc' },
        { column: 'title', direction: 'asc' },
      ]),
    })

    await expect(hydrateRelatedRow(
      row,
      [hydration],
      createBackfills([
        createPostMutation('insert', [
          { id: 1, user_id: 1, score: 1, title: 'Same' },
          { id: 2, user_id: 1, score: 1, title: 'Same' },
        ]),
      ]),
    )).resolves.toEqual({
      id: 1,
      name: 'Ada',
      posts: [
        { id: 1, user_id: 1, score: 1, title: 'Same' },
        { id: 2, user_id: 1, score: 1, title: 'Same' },
      ],
    })
  })

  it('hydrates multiple rows with one grouped related backfill', async () => {
    const adapter = new RelatedHydrationAdapter([
      { id: 3, user_id: 2, title: 'Beta' },
      { id: 1, user_id: 1, title: 'Alpha' },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])
    const hydration = createPostsHydration({
      orderBy: Object.freeze([
        { column: 'title', direction: 'asc' },
      ]),
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([mutation], [], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, user_id: 1, title: 'Alpha' },
          ],
        },
        {
          id: 2,
          name: 'Grace',
          posts: [
            { id: 3, user_id: 2, title: 'Beta' },
          ],
        },
      ],
    })
    expect(adapter.queries).toHaveLength(1)
    expect(adapter.queries[0]?.bindings).toEqual([1, 2])
  })

  it('hydrates grouped has-many rows with empty buckets for missing related rows', async () => {
    const adapter = new RelatedHydrationAdapter([
      { id: 1, user_id: 1, title: 'Only' },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])

    await expect(hydrateRelatedMutationRows(
      mutation,
      [createPostsHydration()],
      createBackfills([mutation], [], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, user_id: 1, title: 'Only' },
          ],
        },
        {
          id: 2,
          name: 'Grace',
          posts: [],
        },
      ],
    })
    expect(adapter.queries).toHaveLength(1)
  })

  it('hydrates grouped has-many rows with predicates', async () => {
    const adapter = new RelatedHydrationAdapter([
      { id: 1, status: 'published', user_id: 1 },
      { id: 3, status: 'published', user_id: 2 },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])
    const hydration = createPostsHydration({
      predicates: Object.freeze([
        { column: 'status', operator: '=', value: 'published' },
      ]),
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([mutation], [], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, status: 'published', user_id: 1 },
          ],
        },
        {
          id: 2,
          name: 'Grace',
          posts: [
            { id: 3, status: 'published', user_id: 2 },
          ],
        },
      ],
    })
    expect(adapter.queries).toHaveLength(1)
    expect(adapter.queries[0]?.sql).toContain('"status" = ?3')
  })

  it('falls back when grouped related backfill has no database connection', async () => {
    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])

    await expect(hydrateRelatedMutationRows(
      mutation,
      [createPostsHydration()],
      createBackfills([mutation], [], new Map()),
    )).resolves.toBeUndefined()
  })

  it('hydrates grouped has-one rows with a top-one query', async () => {
    const adapter = new RelatedHydrationAdapter([
      {
        __holo_related_group_id: 1,
        __holo_related_row_number: 1,
        id: 2,
        score: 30,
        user_id: 1,
      },
      {
        __holo_related_group_id: 2,
        __holo_related_row_number: 1,
        id: 4,
        score: 50,
        user_id: 2,
      },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])
    const hydration = createPostsHydration({
      kind: 'hasOne',
      orderBy: Object.freeze([
        { column: 'score', direction: 'desc' },
      ]),
      relationKey: 'featuredPost',
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([mutation], [], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          featuredPost: {
            id: 2,
            score: 30,
            user_id: 1,
          },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: {
            id: 4,
            score: 50,
            user_id: 2,
          },
          id: 2,
          name: 'Grace',
        },
      ],
    })
    expect(adapter.queries).toHaveLength(1)
    expect(adapter.queries[0]?.sql).toContain('ROW_NUMBER() OVER')
    expect(adapter.queries[0]?.bindings).toEqual([1, 2, 1])
  })

  it('hydrates grouped has-one rows with null buckets for missing top-one rows', async () => {
    const adapter = new RelatedHydrationAdapter([
      {
        __holo_related_group_id: 1,
        __holo_related_row_number: 1,
        id: 2,
        score: 30,
        user_id: 1,
      },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])
    const hydration = createPostsHydration({
      kind: 'hasOne',
      orderBy: Object.freeze([
        { column: 'score', direction: 'desc' },
      ]),
      relationKey: 'featuredPost',
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([mutation], [], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          featuredPost: {
            id: 2,
            score: 30,
            user_id: 1,
          },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: null,
          id: 2,
          name: 'Grace',
        },
      ],
    })
    expect(adapter.queries).toHaveLength(1)
  })

  it('falls back to generic grouped relation backfill when top-one rows are missing group keys', async () => {
    const adapter = new RelatedHydrationAdapter([], [
      [
        { id: 2, score: 30, user_id: 1 },
      ],
      [
        { id: 2, score: 30, user_id: 1 },
        { id: 4, score: 50, user_id: 2 },
      ],
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])
    const hydration = createPostsHydration({
      kind: 'hasOne',
      orderBy: Object.freeze([
        { column: 'score', direction: 'desc' },
      ]),
      relationKey: 'featuredPost',
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([mutation], [], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          featuredPost: {
            id: 2,
            score: 30,
            user_id: 1,
          },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: {
            id: 4,
            score: 50,
            user_id: 2,
          },
          id: 2,
          name: 'Grace',
        },
      ],
    })
    expect(adapter.queries).toHaveLength(2)
    expect(adapter.queries[0]?.sql).toContain('ROW_NUMBER() OVER')
    expect(adapter.queries[1]?.sql).not.toContain('ROW_NUMBER() OVER')
  })

  it('compiles grouped top-one predicates into one related backfill query', async () => {
    const adapter = new RelatedHydrationAdapter([
      {
        __holo_related_group_id: 1,
        __holo_related_row_number: 1,
        id: 2,
        score: 30,
        user_id: 1,
      },
      {
        __holo_related_group_id: 2,
        __holo_related_row_number: 1,
        id: 4,
        score: 50,
        user_id: 2,
      },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])
    const hydration = createPostsHydration({
      kind: 'hasOne',
      orderBy: Object.freeze([
        { column: 'score', direction: 'desc' },
      ]),
      predicates: Object.freeze([
        { column: 'status', operator: '=', value: 'published' },
        { column: 'title', operator: 'like', value: 'A%' },
        { column: 'kind', operator: 'in', value: ['note', 'post'] },
        { column: 'visibility', operator: 'not in', value: ['archived'] },
        { column: 'score', operator: 'between', value: [10, 90] },
        { column: 'rank', operator: 'not between', value: [100, 200] },
      ]),
      relationKey: 'featuredPost',
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([mutation], [], new Map()),
    )).resolves.toEqual({
      ...mutation,
      rows: [
        {
          featuredPost: {
            id: 2,
            score: 30,
            user_id: 1,
          },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: {
            id: 4,
            score: 50,
            user_id: 2,
          },
          id: 2,
          name: 'Grace',
        },
      ],
    })
    expect(adapter.queries).toHaveLength(1)
    expect(adapter.queries[0]?.sql).toContain('"title" LIKE ?4')
    expect(adapter.queries[0]?.sql).toContain('"kind" IN (?5, ?6)')
    expect(adapter.queries[0]?.sql).toContain('"visibility" NOT IN (?7)')
    expect(adapter.queries[0]?.sql).toContain('"score" BETWEEN ?8 AND ?9')
    expect(adapter.queries[0]?.sql).toContain('"rank" NOT BETWEEN ?10 AND ?11')
    expect(adapter.queries[0]?.bindings).toEqual([
      1,
      2,
      'published',
      'A%',
      'note',
      'post',
      'archived',
      10,
      90,
      100,
      200,
      1,
    ])
  })

  it('falls back from grouped top-one SQL when predicate values cannot be compiled safely', async () => {
    const adapter = new RelatedHydrationAdapter([
      { id: 2, score: 30, user_id: 1 },
      { id: 4, score: 50, user_id: 2 },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])
    const hydration = createPostsHydration({
      kind: 'hasOne',
      orderBy: Object.freeze([
        { column: 'score', direction: 'desc' },
      ]),
      predicates: Object.freeze([
        { column: 'kind', operator: 'in', value: [] },
      ]),
      relationKey: 'featuredPost',
    })

    await expect(hydrateRelatedMutationRows(
      mutation,
      [hydration],
      createBackfills([mutation], [], new Map()),
    )).resolves.toBeUndefined()
    expect(adapter.queries).toHaveLength(0)
  })

  it('falls back from grouped top-one SQL when predicate operators cannot be compiled safely', async () => {
    const adapter = new RelatedHydrationAdapter([])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])

    await expect(hydrateRelatedMutationRows(
      mutation,
      [createPostsHydration({
        kind: 'hasOne',
        orderBy: Object.freeze([
          { column: 'score', direction: 'desc' },
        ]),
        predicates: Object.freeze([
          { column: 'score', operator: 'between', value: [10] },
        ]),
        relationKey: 'featuredPost',
      })],
      createBackfills([mutation], [], new Map()),
    )).resolves.toBeUndefined()
    expect(adapter.queries).toHaveLength(0)
  })

  it('falls back when grouped related backfill rows cannot be matched to a local key', async () => {
    const adapter = new RelatedHydrationAdapter([
      { id: 1, title: 'Missing owner' },
    ])
    const db = createRelatedHydrationDatabase(adapter)
    configureRealtimeRuntime({ db: () => db })

    const mutation = createUserMutation('insert', [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ])

    await expect(hydrateRelatedMutationRows(
      mutation,
      [createPostsHydration()],
      createBackfills([mutation], [], new Map()),
    )).resolves.toBeUndefined()
    expect(adapter.queries).toHaveLength(2)
  })
})

function createPostsHydration(
  overrides: Partial<DatabaseQueryRelatedHydrationObservation> = {},
): DatabaseQueryRelatedHydrationObservation {
  return {
    foreignKey: 'user_id',
    kind: 'hasMany',
    localKey: 'id',
    orderBy: Object.freeze([]),
    predicates: Object.freeze([]),
    relationKey: 'posts',
    relatedConnectionName: 'main',
    relatedTableName: 'posts',
    ...overrides,
  }
}

function createUserMutation(
  kind: DatabaseMutationEvent['kind'],
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind,
    predicates: Object.freeze([]),
    rows: rows ? Object.freeze(rows) : undefined,
    tableName: 'users',
  }
}

function createPostMutation(
  kind: DatabaseMutationEvent['kind'],
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind,
    predicates: Object.freeze([]),
    rows: rows ? Object.freeze(rows) : undefined,
    tableName: 'posts',
  }
}

function createBackfills(
  relatedMutations: readonly DatabaseMutationEvent[] = Object.freeze([]),
  rows: readonly (readonly [string, Promise<readonly Readonly<Record<string, unknown>>[] | undefined>])[] = Object.freeze([]),
  rowGroups?: Map<string, Promise<ReadonlyMap<unknown, readonly Readonly<Record<string, unknown>>[]> | undefined>>,
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
    rowGroups,
    rows: new Map(rows),
  }
}

function createRelatedHydrationBackfillKey(
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
): string {
  return `related:${hydration.kind}:${hydration.relatedConnectionName}:${hydration.relatedTableName}:${hydration.foreignKey}:${stableStringify(localKey)}:${stableStringify(hydration.predicates)}:${stableStringify(hydration.orderBy)}`
}

class RelatedHydrationAdapter implements DriverAdapter {
  readonly queries: Array<{ readonly sql: string, readonly bindings: readonly unknown[] }> = []

  constructor(
    private readonly rows: readonly Readonly<Record<string, unknown>>[],
    private readonly queuedRows: readonly (readonly Readonly<Record<string, unknown>>[])[] = Object.freeze([]),
  ) {}

  async initialize(): Promise<void> {}

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return true
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = Object.freeze([]),
  ): Promise<DriverQueryResult<TRow>> {
    const queryIndex = this.queries.length
    this.queries.push({ bindings, sql })
    const rows = (this.queuedRows[queryIndex] ?? this.rows).map(row => ({ ...row }) as TRow)
    return {
      rowCount: rows.length,
      rows,
    }
  }

  async execute(): Promise<DriverExecutionResult> {
    return {}
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}
}

function createRelatedHydrationDatabase(adapter: RelatedHydrationAdapter): DatabaseContext {
  return new DatabaseContext({
    adapter,
    connectionName: 'main',
    dialect: createRelatedHydrationDialect(),
  })
}

function createRelatedHydrationDialect(): Dialect {
  return {
    capabilities: createCapabilities({
      returning: true,
    }),
    createPlaceholder(index: number): string {
      return `?${index}`
    },
    name: 'sqlite-related-hydration',
    quoteIdentifier(identifier: string): string {
      return `"${identifier}"`
    },
  }
}
