import { describe, expect, it } from 'vitest'
import {
  removeRowByProjectedIdentityLazily,
  removeRowsByProjectedIdentity,
  removeRowsByProjectedIdentityLazily,
} from '../src/runtime/query-row-projected-removal'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import {
  MISSING_PROJECTED_IDENTITY,
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type RowPatchContext,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const rows = Object.freeze([
  Object.freeze({ id: 1, title: 'First' }),
  Object.freeze({ id: 2, title: 'Second' }),
  Object.freeze({ id: 3, title: 'Third' }),
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

function createContext(overrides: Partial<RowPatchContext> = {}): RowPatchContext {
  return {
    exactMutationId: NO_EXACT_ID_PREDICATE,
    exactQueryId: NO_EXACT_ID_PREDICATE,
    hasProjectedSelections: true,
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
    selectionColumns: ['id', 'title'],
    selectionResultKeys: ['id', 'title'],
    usesExactQueryIdAsProjectedIdentity: false,
    valueKeys: [],
    ...overrides,
  }
}

describe('@holo-js/realtime projected row removal', () => {
  it('removes projected rows by selected identity for single, pair, and set removals', () => {
    const query = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const context = createContext()

    expect(removeRowsByProjectedIdentity(rows, query, context, [])).toBe(rows)
    expect(removeRowsByProjectedIdentity(rows, query, context, [{ id: 2, title: 'Second' }])).toEqual([
      rows[0],
      rows[2],
    ])
    expect(removeRowsByProjectedIdentity(rows, query, context, [
      { id: 1, title: 'First' },
      { id: 3, title: 'Third' },
    ])).toEqual([rows[1]])
    expect(removeRowsByProjectedIdentity(rows, query, context, [
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
      { id: 3, title: 'Third' },
    ])).toEqual([])
  })

  it('returns missing identity markers when selected identity columns are unavailable', () => {
    const query = createQuery()
    const context = createContext()

    expect(removeRowsByProjectedIdentity(rows, query, context, [{ id: 2 }])).toBeUndefined()
    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [{ id: 2 }])).toBe(MISSING_PROJECTED_IDENTITY)
    expect(removeRowByProjectedIdentityLazily(rows, undefined, query, context, { id: 2 })).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('returns missing identity markers for pair removals with incomplete selected identity rows', () => {
    const query = createQuery()
    const context = createContext()

    expect(removeRowsByProjectedIdentity(rows, query, context, [
      { id: 1, title: 'First' },
      { id: 2 },
    ])).toBeUndefined()
    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [
      { id: 1, title: 'First' },
      { id: 2 },
    ])).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('removes projected rows lazily while reusing existing row buffers', () => {
    const query = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const context = createContext()
    const nextRows = [...rows]

    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [])).toBeUndefined()
    expect(removeRowByProjectedIdentityLazily(rows, undefined, query, context, { id: 3, title: 'Third' })).toEqual([
      rows[0],
      rows[1],
    ])
    expect(removeRowsByProjectedIdentityLazily(rows, nextRows, query, context, [
      { id: 1, title: 'First' },
      { id: 3, title: 'Third' },
    ])).toBe(nextRows)
    expect(nextRows).toEqual([rows[1]])
  })

  it('removes projected row sets lazily and reports missing identities', () => {
    const query = createQuery({
      rowIdentityIndex: new Map([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
    })
    const context = createContext()

    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
      { id: 3, title: 'Third' },
    ])).toEqual([])
    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [
      { id: 1, title: 'First' },
      { id: 2 },
      { id: 3, title: 'Third' },
    ])).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('falls back when projected row set removals miss selected identity data', () => {
    const query = createQuery()
    const context = createContext()

    expect(removeRowsByProjectedIdentity(rows, query, context, [
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
      { id: 3 },
    ])).toBeUndefined()
  })

  it('scans exact selected records when the query id is the projected identity', () => {
    const exactRows = Object.freeze([
      Object.freeze({ title: 'Only selected title' }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: exactRows,
    })
    const context = createContext({
      exactQueryId: 10,
      projectedIdentityColumn: NO_PROJECTED_IDENTITY_COLUMN,
      selectionColumns: ['title'],
      selectionResultKeys: ['title'],
      usesExactQueryIdAsProjectedIdentity: true,
    })

    expect(removeRowsByProjectedIdentity(exactRows, query, context, [{ title: 'Only selected title' }])).toEqual([])
    expect(removeRowsByProjectedIdentity(exactRows, query, context, [])).toBe(exactRows)

    const nextRows = [...exactRows]
    expect(removeRowsByProjectedIdentityLazily(exactRows, nextRows, query, context, [{ title: 'Only selected title' }])).toBe(nextRows)
    expect(nextRows).toEqual([])
    expect(removeRowByProjectedIdentityLazily(exactRows, undefined, query, context, { title: 'Only selected title' })).toEqual([])
  })

  it('keeps scanned exact-id removals unchanged when projected identities do not match current rows', () => {
    const query = createQuery()
    const context = createContext({
      usesExactQueryIdAsProjectedIdentity: true,
    })

    expect(removeRowsByProjectedIdentity(rows, query, context, [{ id: 9, title: 'Different title' }])).toBe(rows)
    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [{ id: 9, title: 'Different title' }])).toBeUndefined()
  })

  it('scans projected identities lazily when exact-query-id mode still has selected ids', () => {
    const query = createQuery()
    const context = createContext({
      usesExactQueryIdAsProjectedIdentity: true,
    })

    expect(removeRowsByProjectedIdentity(rows, query, context, [{ id: 2, title: 'Second' }])).toEqual([
      rows[0],
      rows[2],
    ])
    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [{ id: 2, title: 'Second' }])).toEqual([
      rows[0],
      rows[2],
    ])

    const nextRows = [
      rows[0],
      undefined,
      rows[1],
      rows[2],
    ] as unknown as TestRow[]

    expect(removeRowsByProjectedIdentityLazily(rows, nextRows, query, context, [{ id: 2, title: 'Second' }])).toBe(nextRows)
    expect(nextRows).toEqual([rows[0], rows[2]])
  })

  it('skips sparse rows while scanning projected identities', () => {
    const sparseRows = [
      rows[0],
      undefined,
      rows[1],
      rows[2],
    ] as unknown as TestRow[]
    const query = createQuery({
      result: sparseRows,
    })
    const context = createContext({
      usesExactQueryIdAsProjectedIdentity: true,
    })

    expect(removeRowsByProjectedIdentity(sparseRows, query, context, [{ id: 2, title: 'Second' }])).toEqual([
      rows[0],
      rows[2],
    ])
    expect(removeRowsByProjectedIdentityLazily(sparseRows, undefined, query, context, [{ id: 2, title: 'Second' }])).toEqual([
      rows[0],
      rows[2],
    ])
  })

  it('fails scanned projected removal when current projected rows miss selected identity data', () => {
    const invalidRows = Object.freeze([
      Object.freeze({ id: 1, title: 'First' }),
      Object.freeze({ id: 2 }),
    ]) satisfies readonly TestRow[]
    const query = createQuery({
      result: invalidRows,
    })
    const context = createContext({
      usesExactQueryIdAsProjectedIdentity: true,
    })

    expect(removeRowsByProjectedIdentity(invalidRows, query, context, [{ id: 1, title: 'First' }])).toBeUndefined()
    expect(removeRowsByProjectedIdentityLazily(invalidRows, undefined, query, context, [{ id: 1, title: 'First' }])).toBe(MISSING_PROJECTED_IDENTITY)
    expect(removeRowsByProjectedIdentityLazily(invalidRows, [...invalidRows], query, context, [{ id: 1, title: 'First' }])).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('fails scanned projected removal when removed rows miss selected identity data', () => {
    const query = createQuery()
    const context = createContext({
      usesExactQueryIdAsProjectedIdentity: true,
    })

    expect(removeRowsByProjectedIdentity(rows, query, context, [{ id: 1 }])).toBeUndefined()
    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [{ id: 1 }])).toBe(MISSING_PROJECTED_IDENTITY)
  })

  it('uses projected identity caching without changing removal results', () => {
    const query = createQuery()
    const context = createContext()
    const identityCache = new WeakMap<Readonly<Record<string, unknown>>, unknown>()
    const removedRow = Object.freeze({ id: 2, title: 'Second' })

    expect(removeRowsByProjectedIdentity(rows, query, context, [removedRow], identityCache)).toEqual([
      rows[0],
      rows[2],
    ])
    expect(removeRowsByProjectedIdentityLazily(rows, undefined, query, context, [removedRow], identityCache)).toEqual([
      rows[0],
      rows[2],
    ])
  })
})
