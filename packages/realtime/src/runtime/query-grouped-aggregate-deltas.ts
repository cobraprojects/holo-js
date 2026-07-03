import type { DatabaseMutationEvent } from './dependencies'
import {
  matchesGroupedCountHaving,
  readGroupedAggregateNumericContribution,
  readMatchingGroupedAggregateValue,
  sortGroupedAggregateRows,
} from './query-grouped-aggregate-common'
import { UNCHANGED_QUERY_RESULT } from './query-patch-results'
import type {
  DatabaseQueryGroupedAggregateObservation,
  DatabaseQueryGroupedAggregateStateObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'

type GroupedAggregateDelta = {
  readonly aggregateDelta: number
  readonly groupValue: unknown
  readonly rowCountDelta: number
}

type DeltaPatchableGroupedAggregateObservation = DatabaseQueryGroupedAggregateObservation & {
  readonly kind: 'count' | 'sum'
}

export type GroupedAggregateDeltaPatchResult =
  | {
    readonly patched: false
  }
  | {
    readonly patched: true
    readonly rows: readonly Readonly<Record<string, unknown>>[]
  }

export function tryPatchGroupedAggregateDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutation: DatabaseMutationEvent,
): GroupedAggregateDeltaPatchResult | undefined {
  const deltas = readGroupedAggregateMutationDeltas(query, groupedAggregate, mutation)
  if (!deltas) {
    return undefined
  }

  if (deltas.length === 0) {
    return Object.freeze({ patched: false })
  }

  const patchedRows = applyGroupedAggregateDeltas(query, groupedAggregate, rows, deltas)
  return patchedRows
    ? Object.freeze({ patched: true, rows: patchedRows })
    : undefined
}

export function tryPatchGroupedAggregateDeltasWithState(
  query: DatabaseQueryObservation,
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
): PatchQueryResult | undefined {
  const aggregateStates = groupedAggregate.aggregateStates
  if (!aggregateStates) {
    return undefined
  }

  let nextRows = rows
  let nextStates = aggregateStates
  let rowsChanged = false
  let statesChanged = false
  for (const mutation of mutations) {
    const deltas = readGroupedAggregateMutationDeltas(query, groupedAggregate, mutation, true)
    if (!deltas) {
      return undefined
    }

    if (deltas.length === 0) {
      continue
    }

    const patchResult = applyGroupedAggregateStateDeltas(query, groupedAggregate, nextRows, nextStates, deltas)
    if (!patchResult) {
      return undefined
    }

    nextRows = patchResult.rows
    nextStates = patchResult.states
    rowsChanged = rowsChanged || patchResult.rowsChanged
    statesChanged = statesChanged || patchResult.statesChanged
  }

  if (!rowsChanged && !statesChanged) {
    return UNCHANGED_QUERY_RESULT
  }

  const nextQuery = createGroupedAggregateStateQuery(query, groupedAggregate, nextStates)
  return rowsChanged
    ? Object.freeze({
        nextQuery,
        patched: true,
        query,
        value: nextRows,
      })
    : Object.freeze({
        nextQuery,
        patched: true,
        unchanged: true,
      })
}

function readGroupedAggregateMutationDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  mutation: DatabaseMutationEvent,
  supportsRemovals = false,
): readonly GroupedAggregateDelta[] | undefined {
  return groupedAggregate.kind === 'sum'
    ? readGroupedSumMutationDeltas(query, groupedAggregate, mutation, supportsRemovals)
    : readGroupedCountMutationDeltas(query, groupedAggregate, mutation)
}

function readGroupedCountMutationDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  mutation: DatabaseMutationEvent,
): readonly GroupedAggregateDelta[] | undefined {
  if (mutation.kind === 'insert') {
    return mutation.rows
      ? readGroupedCountRowsDeltas(query, groupedAggregate, mutation.rows, 1)
      : undefined
  }

  if (mutation.kind === 'delete') {
    return mutation.rows
      ? readGroupedCountRowsDeltas(query, groupedAggregate, mutation.rows, -1)
      : undefined
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  const deltas: GroupedAggregateDelta[] = []
  if (
    !appendGroupedCountRowsDeltas(deltas, query, groupedAggregate, mutation.previousRows, -1)
    || !appendGroupedCountRowsDeltas(deltas, query, groupedAggregate, mutation.rows, 1)
  ) {
    return undefined
  }

  return mergeGroupedAggregateDeltas(deltas)
}

function readGroupedCountRowsDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  multiplier: number,
): readonly GroupedAggregateDelta[] | undefined {
  const deltas: GroupedAggregateDelta[] = []
  return appendGroupedCountRowsDeltas(deltas, query, groupedAggregate, rows, multiplier)
    ? mergeGroupedAggregateDeltas(deltas)
    : undefined
}

function appendGroupedCountRowsDeltas(
  deltas: GroupedAggregateDelta[],
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  multiplier: number,
): boolean {
  for (const row of rows) {
    const groupValue = readMatchingGroupedAggregateValue(query, groupedAggregate, row)
    if (groupValue.matched === 'unknown') {
      return false
    }

    if (!groupValue.matched) {
      continue
    }

    deltas.push(Object.freeze({
      aggregateDelta: multiplier,
      groupValue: groupValue.value,
      rowCountDelta: multiplier,
    }))
  }

  return true
}

function readGroupedSumMutationDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  mutation: DatabaseMutationEvent,
  supportsRemovals: boolean,
): readonly GroupedAggregateDelta[] | undefined {
  if (mutation.kind === 'insert') {
    return mutation.rows
      ? readGroupedSumRowsDeltas(query, groupedAggregate, mutation.rows, 1)
      : undefined
  }

  if (mutation.kind === 'delete') {
    return supportsRemovals && mutation.rows
      ? readGroupedSumRowsDeltas(query, groupedAggregate, mutation.rows, -1)
      : undefined
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  if (supportsRemovals) {
    const deltas: GroupedAggregateDelta[] = []
    if (
      !appendGroupedSumRowsDeltas(deltas, query, groupedAggregate, mutation.previousRows, -1)
      || !appendGroupedSumRowsDeltas(deltas, query, groupedAggregate, mutation.rows, 1)
    ) {
      return undefined
    }

    return mergeGroupedAggregateDeltas(deltas)
  }

  const deltas: GroupedAggregateDelta[] = []
  for (let index = 0; index < mutation.rows.length; index += 1) {
    const previousRow = mutation.previousRows[index]
    const nextRow = mutation.rows[index]
    if (!previousRow || !nextRow) {
      return undefined
    }

    const delta = readGroupedSumUpdateDelta(query, groupedAggregate, previousRow, nextRow)
    if (!delta) {
      return undefined
    }

    if (delta !== GROUPED_AGGREGATE_UNCHANGED) {
      deltas.push(delta)
    }
  }

  return mergeGroupedAggregateDeltas(deltas)
}

function readGroupedSumRowsDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  multiplier: 1 | -1,
): readonly GroupedAggregateDelta[] | undefined {
  const deltas: GroupedAggregateDelta[] = []
  return appendGroupedSumRowsDeltas(deltas, query, groupedAggregate, rows, multiplier)
    ? mergeGroupedAggregateDeltas(deltas)
    : undefined
}

function appendGroupedSumRowsDeltas(
  deltas: GroupedAggregateDelta[],
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  multiplier: 1 | -1,
): boolean {
  for (const row of rows) {
    const groupValue = readMatchingGroupedAggregateValue(query, groupedAggregate, row)
    if (groupValue.matched === 'unknown') {
      return false
    }

    if (!groupValue.matched) {
      continue
    }

    const contribution = readGroupedAggregateNumericContribution(groupedAggregate, row)
    if (typeof contribution === 'undefined') {
      return false
    }

    deltas.push(Object.freeze({
      aggregateDelta: multiplier * contribution,
      groupValue: groupValue.value,
      rowCountDelta: multiplier,
    }))
  }

  return true
}

function readGroupedSumUpdateDelta(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  previousRow: Readonly<Record<string, unknown>>,
  nextRow: Readonly<Record<string, unknown>>,
): GroupedAggregateDelta | typeof GROUPED_AGGREGATE_UNCHANGED | undefined {
  const previousGroupValue = readMatchingGroupedAggregateValue(query, groupedAggregate, previousRow)
  const nextGroupValue = readMatchingGroupedAggregateValue(query, groupedAggregate, nextRow)
  if (previousGroupValue.matched === 'unknown' || nextGroupValue.matched === 'unknown') {
    return undefined
  }

  if (!previousGroupValue.matched) {
    if (!nextGroupValue.matched) {
      return GROUPED_AGGREGATE_UNCHANGED
    }

    const nextContribution = readGroupedAggregateNumericContribution(groupedAggregate, nextRow)
    return typeof nextContribution === 'number'
      ? Object.freeze({ aggregateDelta: nextContribution, groupValue: nextGroupValue.value, rowCountDelta: 1 })
      : undefined
  }

  if (!nextGroupValue.matched || !Object.is(previousGroupValue.value, nextGroupValue.value)) {
    return undefined
  }

  const previousContribution = readGroupedAggregateNumericContribution(groupedAggregate, previousRow)
  const nextContribution = readGroupedAggregateNumericContribution(groupedAggregate, nextRow)
  if (typeof previousContribution !== 'number' || typeof nextContribution !== 'number') {
    return undefined
  }

  const aggregateDelta = nextContribution - previousContribution
  return aggregateDelta === 0
    ? GROUPED_AGGREGATE_UNCHANGED
    : Object.freeze({ aggregateDelta, groupValue: nextGroupValue.value, rowCountDelta: 0 })
}

const GROUPED_AGGREGATE_UNCHANGED = Symbol('grouped aggregate unchanged')

function mergeGroupedAggregateDeltas(deltas: readonly GroupedAggregateDelta[]): readonly GroupedAggregateDelta[] {
  const merged: GroupedAggregateDelta[] = []
  for (const delta of deltas) {
    const index = merged.findIndex(candidate => Object.is(candidate.groupValue, delta.groupValue))
    if (index === -1) {
      merged.push(delta)
      continue
    }

    const current = merged[index]!
    merged[index] = Object.freeze({
      aggregateDelta: current.aggregateDelta + delta.aggregateDelta,
      groupValue: current.groupValue,
      rowCountDelta: current.rowCountDelta + delta.rowCountDelta,
    })
  }

  return Object.freeze(merged.filter(delta => delta.aggregateDelta !== 0 || delta.rowCountDelta !== 0))
}

function applyGroupedAggregateDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  deltas: readonly GroupedAggregateDelta[],
): readonly Readonly<Record<string, unknown>>[] | undefined {
  let nextRows: readonly Readonly<Record<string, unknown>>[] = rows
  for (const delta of deltas) {
    const patchResult = applyGroupedAggregateDelta(groupedAggregate, nextRows, delta)
    if (!patchResult) {
      return undefined
    }

    nextRows = patchResult
  }

  return sortGroupedAggregateRows(query, groupedAggregate, nextRows)
}

function applyGroupedAggregateDelta(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  delta: GroupedAggregateDelta,
): Readonly<Record<string, unknown>>[] | undefined {
  const index = rows.findIndex(row => Object.is(row[groupedAggregate.groupResultKey], delta.groupValue))
  if (index === -1) {
    if (groupedAggregate.having) {
      return undefined
    }

    return delta.aggregateDelta > 0
      ? [...rows, Object.freeze({
          [groupedAggregate.groupResultKey]: delta.groupValue,
          [groupedAggregate.aggregateResultKey]: delta.aggregateDelta,
        })]
      : undefined
  }

  const row = rows[index]!
  const currentAggregate = row[groupedAggregate.aggregateResultKey]
  if (typeof currentAggregate !== 'number') {
    return undefined
  }

  const nextAggregate = currentAggregate + delta.aggregateDelta
  if (groupedAggregate.kind === 'count' && nextAggregate < 0) {
    return undefined
  }

  if (
    groupedAggregate.kind === 'count'
    && (nextAggregate === 0 || !matchesGroupedCountHaving(groupedAggregate, nextAggregate))
  ) {
    return [
      ...rows.slice(0, index),
      ...rows.slice(index + 1),
    ]
  }

  return [
    ...rows.slice(0, index),
    Object.freeze({
      ...row,
      [groupedAggregate.aggregateResultKey]: nextAggregate,
    }),
    ...rows.slice(index + 1),
  ]
}

type GroupedAggregateStatePatchResult = {
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly rowsChanged: boolean
  readonly states: readonly DatabaseQueryGroupedAggregateStateObservation[]
  readonly statesChanged: boolean
}

function applyGroupedAggregateStateDeltas(
  query: DatabaseQueryObservation,
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  deltas: readonly GroupedAggregateDelta[],
): GroupedAggregateStatePatchResult | undefined {
  let nextRows = rows
  let nextStates = states
  let rowsChanged = false
  let statesChanged = false
  for (const delta of deltas) {
    const patchResult = applyGroupedAggregateStateDelta(groupedAggregate, nextRows, nextStates, delta)
    if (!patchResult) {
      return undefined
    }

    nextRows = patchResult.rows
    nextStates = patchResult.states
    rowsChanged = rowsChanged || patchResult.rowsChanged
    statesChanged = statesChanged || patchResult.statesChanged
  }

  if (!rowsChanged) {
    return Object.freeze({
      rows: nextRows,
      rowsChanged,
      states: nextStates,
      statesChanged,
    })
  }

  const sortedRows = sortGroupedAggregateRows(query, groupedAggregate, nextRows)
  return sortedRows
    ? Object.freeze({
        rows: sortedRows,
        rowsChanged,
        states: nextStates,
        statesChanged,
      })
    : undefined
}

function applyGroupedAggregateStateDelta(
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  delta: GroupedAggregateDelta,
): GroupedAggregateStatePatchResult | undefined {
  const stateIndex = states.findIndex(state => Object.is(state.groupValue, delta.groupValue))
  const previousState = states[stateIndex]
  if (!previousState && delta.rowCountDelta <= 0) {
    return undefined
  }

  const previousVisible = previousState
    ? isGroupedAggregateStateVisible(groupedAggregate, previousState)
    : false
  const nextState = previousState
    ? createNextGroupedAggregateState(previousState, delta)
    : createNewGroupedAggregateState(delta)
  if (typeof nextState === 'undefined') {
    return undefined
  }

  const nextStates = replaceGroupedAggregateState(states, stateIndex, nextState)
  const nextVisible = nextState
    ? isGroupedAggregateStateVisible(groupedAggregate, nextState)
    : false
  const rowResult = applyGroupedAggregateStateRow(groupedAggregate, rows, delta.groupValue, previousVisible, nextVisible, nextState)
  if (!rowResult) {
    return undefined
  }

  return Object.freeze({
    rows: rowResult.rows,
    rowsChanged: rowResult.changed,
    states: nextStates,
    statesChanged: true,
  })
}

function createNextGroupedAggregateState(
  previousState: DatabaseQueryGroupedAggregateStateObservation,
  delta: GroupedAggregateDelta,
): DatabaseQueryGroupedAggregateStateObservation | null | undefined {
  const rowCount = previousState.rowCount + delta.rowCountDelta
  const aggregateValue = previousState.aggregateValue + delta.aggregateDelta
  if (rowCount < 0) {
    return undefined
  }

  return rowCount === 0
    ? null
    : Object.freeze({
        aggregateValue,
        groupValue: previousState.groupValue,
        rowCount,
      })
}

function createNewGroupedAggregateState(
  delta: GroupedAggregateDelta,
): DatabaseQueryGroupedAggregateStateObservation {
  return Object.freeze({
    aggregateValue: delta.aggregateDelta,
    groupValue: delta.groupValue,
    rowCount: delta.rowCountDelta,
  })
}

function replaceGroupedAggregateState(
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  index: number,
  nextState: DatabaseQueryGroupedAggregateStateObservation | null,
): readonly DatabaseQueryGroupedAggregateStateObservation[] {
  if (index === -1) {
    return Object.freeze([...states, nextState!])
  }

  return nextState
    ? Object.freeze([
        ...states.slice(0, index),
        nextState,
        ...states.slice(index + 1),
      ])
    : Object.freeze([
        ...states.slice(0, index),
        ...states.slice(index + 1),
      ])
}

function isGroupedAggregateStateVisible(
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  state: DatabaseQueryGroupedAggregateStateObservation,
): boolean {
  return state.rowCount > 0 && matchesGroupedCountHaving(groupedAggregate, state.rowCount)
}

function applyGroupedAggregateStateRow(
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  groupValue: unknown,
  previousVisible: boolean,
  nextVisible: boolean,
  nextState: DatabaseQueryGroupedAggregateStateObservation | null,
): { readonly changed: boolean, readonly rows: readonly Readonly<Record<string, unknown>>[] } | undefined {
  const rowIndex = rows.findIndex(row => Object.is(row[groupedAggregate.groupResultKey], groupValue))
  if (!previousVisible && rowIndex !== -1) {
    return undefined
  }

  if (previousVisible && rowIndex === -1) {
    return undefined
  }

  if (!previousVisible && !nextVisible) {
    return Object.freeze({ changed: false, rows })
  }

  if (!nextVisible) {
    return Object.freeze({
      changed: true,
      rows: Object.freeze([
        ...rows.slice(0, rowIndex),
        ...rows.slice(rowIndex + 1),
      ]),
    })
  }

  const nextRow = Object.freeze({
    [groupedAggregate.groupResultKey]: groupValue,
    [groupedAggregate.aggregateResultKey]: nextState!.aggregateValue,
  })
  if (rowIndex === -1) {
    return Object.freeze({
      changed: true,
      rows: Object.freeze([...rows, nextRow]),
    })
  }

  return Object.freeze({
    changed: true,
    rows: Object.freeze([
      ...rows.slice(0, rowIndex),
      nextRow,
      ...rows.slice(rowIndex + 1),
    ]),
  })
}

function createGroupedAggregateStateQuery(
  query: DatabaseQueryObservation,
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
): DatabaseQueryObservation {
  return Object.freeze({
    ...query,
    groupedAggregate: Object.freeze({
      ...groupedAggregate,
      aggregateStates: states,
    }),
  })
}
