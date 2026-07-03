import { describe, expect, it } from 'vitest'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import {
  appendOrderedPatchRowLazily,
  isFullOrderedLimitedWindow,
  patchCanChangeOrder,
  relocateOrderedPatchRowLazily,
  replaceOrderedPatchRowByIndexLazily,
} from '../src/runtime/query-row-ordered-patching'
import type {
  DatabaseQueryObservation,
  RowPatchContext,
  RowsOrderState,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

const firstRow = Object.freeze({ id: 1, priority: 1, title: 'First' }) satisfies TestRow
const secondRow = Object.freeze({ id: 2, priority: 2, title: 'Second' }) satisfies TestRow
const thirdRow = Object.freeze({ id: 3, priority: 3, title: 'Third' }) satisfies TestRow
const rows = Object.freeze([
  firstRow,
  secondRow,
  thirdRow,
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

function createOrderState(): RowsOrderState {
  return { preserved: true }
}

describe('@holo-js/realtime ordered row patch helpers', () => {
  it('checks limited full-window state and invalid replacement indexes', () => {
    expect(isFullOrderedLimitedWindow(rows, createQuery({
      limit: 3,
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toBe(true)
    expect(isFullOrderedLimitedWindow(rows, createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
    }))).toBe(false)

    expect(replaceOrderedPatchRowByIndexLazily(
      rows,
      9,
      { id: 9, priority: 9, title: 'Missing' },
      createContext(),
      ['priority'],
      [1],
      createOrderState(),
    )).toBeUndefined()
  })

  it('appends unwindowed rows with no order columns', () => {
    const orderState = createOrderState()

    expect(appendOrderedPatchRowLazily(
      rows,
      { id: 4, priority: 4, title: 'Fourth' },
      createQuery(),
      [],
      [],
      orderState,
    )).toEqual([
      ...rows,
      { id: 4, priority: 4, title: 'Fourth' },
    ])
    expect(orderState.preserved).toBe(true)
  })

  it('skips rows past a full ordered window tail', () => {
    expect(appendOrderedPatchRowLazily(
      rows,
      { id: 4, priority: 4, title: 'Fourth' },
      createQuery({
        limit: 3,
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      ['priority'],
      [1],
      createOrderState(),
    )).toBeUndefined()
  })

  it('falls back when appended rows cannot be ordered', () => {
    const missingOrderState = createOrderState()

    expect(appendOrderedPatchRowLazily(
      rows,
      { id: 4, title: 'Missing priority' },
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
      }),
      ['priority'],
      [1],
      missingOrderState,
    )).toEqual([
      ...rows,
      { id: 4, title: 'Missing priority' },
    ])
    expect(missingOrderState.preserved).toBe(false)

    const incomparableRows = Object.freeze([
      Object.freeze({ id: 1, priority: { rank: 1 } }),
    ]) satisfies readonly TestRow[]
    const incomparableOrderState = createOrderState()

    expect(appendOrderedPatchRowLazily(
      incomparableRows,
      { id: 2, priority: 2 },
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: incomparableRows,
      }),
      ['priority'],
      [1],
      incomparableOrderState,
    )).toEqual([
      ...incomparableRows,
      { id: 2, priority: 2 },
    ])
    expect(incomparableOrderState.preserved).toBe(false)
  })

  it('keeps empty limited windows patchable when no tail row exists', () => {
    const emptyRows = Object.freeze([]) satisfies readonly TestRow[]

    expect(appendOrderedPatchRowLazily(
      emptyRows,
      { id: 1, priority: 1 },
      createQuery({
        limit: 0,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: emptyRows,
      }),
      ['priority'],
      [1],
      createOrderState(),
    )).toEqual([{ id: 1, priority: 1 }])
  })

  it('marks order unpreserved when inserting into sparse or unsorted rows', () => {
    const sparseRows = [
      firstRow,
      undefined,
      thirdRow,
    ] as unknown as readonly TestRow[]
    const sparseOrderState = createOrderState()

    expect(appendOrderedPatchRowLazily(
      sparseRows,
      { id: 4, priority: 4 },
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: sparseRows,
      }),
      ['priority'],
      [1],
      sparseOrderState,
    )).toEqual([
      firstRow,
      thirdRow,
      { id: 4, priority: 4 },
    ])
    expect(sparseOrderState.preserved).toBe(false)

    const unsortedRows = Object.freeze([
      Object.freeze({ id: 2, priority: 2 }),
      Object.freeze({ id: 1, priority: 1 }),
    ]) satisfies readonly TestRow[]
    const unsortedOrderState = createOrderState()

    expect(appendOrderedPatchRowLazily(
      unsortedRows,
      { id: 3, priority: 3 },
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        result: unsortedRows,
      }),
      ['priority'],
      [1],
      unsortedOrderState,
    )).toEqual([
      ...unsortedRows,
      { id: 3, priority: 3 },
    ])
    expect(unsortedOrderState.preserved).toBe(false)
  })

  it('relocates ordered rows and falls back for sparse neighbors', () => {
    expect(relocateOrderedPatchRowLazily(
      rows,
      0,
      { id: 1, priority: 1, title: 'Stayed first' },
      ['priority'],
      [1],
    )).toEqual([
      { id: 1, priority: 1, title: 'Stayed first' },
      secondRow,
      thirdRow,
    ])

    expect(relocateOrderedPatchRowLazily(
      rows,
      1,
      { id: 2, priority: 2, title: 'Stayed' },
      ['priority'],
      [1],
    )).toEqual([
      firstRow,
      { id: 2, priority: 2, title: 'Stayed' },
      thirdRow,
    ])

    expect(relocateOrderedPatchRowLazily(
      rows,
      1,
      { id: 2, priority: 0, title: 'Before previous' },
      ['priority'],
      [1],
    )).toEqual([
      { id: 2, priority: 0, title: 'Before previous' },
      firstRow,
      thirdRow,
    ])

    expect(relocateOrderedPatchRowLazily(
      rows,
      1,
      { id: 2, priority: 4, title: 'Moved' },
      ['priority'],
      [1],
    )).toEqual([
      firstRow,
      thirdRow,
      { id: 2, priority: 4, title: 'Moved' },
    ])

    expect(relocateOrderedPatchRowLazily(
      rows,
      2,
      { id: 3, priority: 3, title: 'Stayed last' },
      ['priority'],
      [1],
    )).toEqual([
      firstRow,
      secondRow,
      { id: 3, priority: 3, title: 'Stayed last' },
    ])

    const missingPreviousRows = [
      undefined,
      secondRow,
      thirdRow,
    ] as unknown as readonly TestRow[]
    expect(relocateOrderedPatchRowLazily(
      missingPreviousRows,
      1,
      { id: 2, priority: 2 },
      ['priority'],
      [1],
    )).toEqual([
      { id: 2, priority: 2 },
      thirdRow,
    ])

    const missingNextRows = [
      firstRow,
      secondRow,
      undefined,
    ] as unknown as readonly TestRow[]
    expect(relocateOrderedPatchRowLazily(
      missingNextRows,
      1,
      { id: 2, priority: 2 },
      ['priority'],
      [1],
    )).toEqual([
      firstRow,
      { id: 2, priority: 2 },
    ])
  })

  it('replaces ordered rows in place and falls back when relocation cannot preserve order', () => {
    const unchangedOrderState = createOrderState()
    const changedOrderState = createOrderState()
    const fallbackOrderState = createOrderState()
    const unpreservedOrderState = createOrderState()

    expect(replaceOrderedPatchRowByIndexLazily(
      rows,
      1,
      { title: 'Second' },
      createContext(),
      ['priority'],
      [1],
      unchangedOrderState,
    )).toBeUndefined()
    expect(unchangedOrderState.preserved).toBe(true)

    expect(replaceOrderedPatchRowByIndexLazily(
      rows,
      1,
      { title: 'Changed' },
      createContext(),
      ['priority'],
      [1],
      changedOrderState,
    )).toEqual([
      firstRow,
      { id: 2, priority: 2, title: 'Changed' },
      thirdRow,
    ])
    expect(changedOrderState.preserved).toBe(true)

    const sparseRows = [
      firstRow,
      secondRow,
      undefined,
    ] as unknown as readonly TestRow[]

    expect(replaceOrderedPatchRowByIndexLazily(
      sparseRows,
      1,
      { priority: 4 },
      createContext({
        orderColumns: ['priority'],
        queryOrderChanged: true,
      }),
      ['priority'],
      [1],
      fallbackOrderState,
    )).toEqual([
      firstRow,
      { id: 2, priority: 4, title: 'Second' },
    ])
    expect(fallbackOrderState.preserved).toBe(true)

    const incomparableRows = Object.freeze([
      Object.freeze({ id: 1, priority: { rank: 1 } }),
      secondRow,
    ]) satisfies readonly TestRow[]

    expect(replaceOrderedPatchRowByIndexLazily(
      incomparableRows,
      1,
      { priority: 3 },
      createContext({
        orderColumns: ['priority'],
        queryOrderChanged: true,
      }),
      ['priority'],
      [1],
      unpreservedOrderState,
    )).toEqual([
      incomparableRows[0],
      { id: 2, priority: 3, title: 'Second' },
    ])
    expect(unpreservedOrderState.preserved).toBe(false)
  })

  it('detects order-changing patches from changed or missing order columns', () => {
    const context = createContext({
      orderColumns: ['priority'],
      queryOrderChanged: true,
    })

    expect(patchCanChangeOrder(firstRow, { id: 1, priority: 2 }, context)).toBe(true)
    expect(patchCanChangeOrder(firstRow, { id: 1 }, context)).toBe(true)
    expect(patchCanChangeOrder(firstRow, { id: 1, priority: 1 }, context)).toBe(false)
    expect(patchCanChangeOrder(firstRow, { id: 1, priority: 2 }, createContext({
      orderColumns: ['priority'],
      queryOrderChanged: false,
    }))).toBe(false)
  })
})
