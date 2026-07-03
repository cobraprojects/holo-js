import type { DatabaseMutationEvent } from './dependencies'
import {
  matchesGroupedCountHaving,
  readGroupedAggregateNumericContribution,
  readMatchingGroupedAggregateValue,
  sortGroupedAggregateRows,
} from './query-grouped-aggregate-common'
import {
  UNCHANGED_QUERY_RESULT,
} from './query-patch-results'
import type {
  DatabaseQueryGroupedAggregateObservation,
  DatabaseQueryGroupedAverageStateObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'

type GroupedAverageChange = {
  readonly countDelta: number
  readonly groupValue: unknown
  readonly rowCountDelta: number
  readonly sumDelta: number
}

type GroupedAveragePatchState = {
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly states: readonly DatabaseQueryGroupedAverageStateObservation[]
}

type GroupedAveragePatchResult = GroupedAveragePatchState & {
  readonly rowsChanged: boolean
  readonly statesChanged: boolean
}

export function tryPatchGroupedAverageQuery(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
): PatchQueryResult | undefined {
  const averageStates = groupedAggregate.averageStates
  if (!averageStates) {
    return undefined
  }

  let state: GroupedAveragePatchState = {
    rows,
    states: averageStates,
  }
  let rowsChanged = false
  let statesChanged = false
  for (const mutation of mutations) {
    const changes = readGroupedAverageMutationChanges(query, groupedAggregate, mutation)
    if (!changes) {
      return undefined
    }

    if (changes.length === 0) {
      continue
    }

    const nextState = applyGroupedAverageChanges(query, groupedAggregate, state, changes)
    if (!nextState) {
      return undefined
    }

    state = {
      rows: nextState.rows,
      states: nextState.states,
    }
    rowsChanged = rowsChanged || nextState.rowsChanged
    statesChanged = statesChanged || nextState.statesChanged
  }

  if (!rowsChanged && !statesChanged) {
    return UNCHANGED_QUERY_RESULT
  }

  const nextQuery = createGroupedAverageQueryState(query, groupedAggregate, state.states)
  return rowsChanged
    ? Object.freeze({
        nextQuery,
        patched: true,
        query,
        value: state.rows,
      })
    : Object.freeze({
        nextQuery,
        patched: true,
        unchanged: true,
      })
}

function readGroupedAverageMutationChanges(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  mutation: DatabaseMutationEvent,
): readonly GroupedAverageChange[] | undefined {
  if (mutation.kind === 'insert') {
    return mutation.rows
      ? readGroupedAverageRowsChanges(query, groupedAggregate, mutation.rows, 1)
      : undefined
  }

  if (mutation.kind === 'delete') {
    return mutation.rows
      ? readGroupedAverageRowsChanges(query, groupedAggregate, mutation.rows, -1)
      : undefined
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  const changes: GroupedAverageChange[] = []
  if (
    !appendGroupedAverageRowsChanges(changes, query, groupedAggregate, mutation.previousRows, -1)
    || !appendGroupedAverageRowsChanges(changes, query, groupedAggregate, mutation.rows, 1)
  ) {
    return undefined
  }

  return mergeGroupedAverageChanges(changes)
}

function readGroupedAverageRowsChanges(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  direction: 1 | -1,
): readonly GroupedAverageChange[] | undefined {
  const changes: GroupedAverageChange[] = []
  return appendGroupedAverageRowsChanges(changes, query, groupedAggregate, rows, direction)
    ? mergeGroupedAverageChanges(changes)
    : undefined
}

function appendGroupedAverageRowsChanges(
  changes: GroupedAverageChange[],
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  direction: 1 | -1,
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

    changes.push(Object.freeze({
      countDelta: direction,
      groupValue: groupValue.value,
      rowCountDelta: direction,
      sumDelta: direction * contribution,
    }))
  }

  return true
}

function mergeGroupedAverageChanges(
  changes: readonly GroupedAverageChange[],
): readonly GroupedAverageChange[] {
  const merged: GroupedAverageChange[] = []
  for (const change of changes) {
    const index = merged.findIndex(candidate => Object.is(candidate.groupValue, change.groupValue))
    if (index === -1) {
      merged.push(change)
      continue
    }

    const current = merged[index]!
    merged[index] = Object.freeze({
      countDelta: current.countDelta + change.countDelta,
      groupValue: current.groupValue,
      rowCountDelta: current.rowCountDelta + change.rowCountDelta,
      sumDelta: current.sumDelta + change.sumDelta,
    })
  }

  return Object.freeze(merged.filter(change => (
    change.countDelta !== 0
    || change.rowCountDelta !== 0
    || change.sumDelta !== 0
  )))
}

function applyGroupedAverageChanges(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  state: GroupedAveragePatchState,
  changes: readonly GroupedAverageChange[],
): GroupedAveragePatchResult | undefined {
  let rows = state.rows
  let states = state.states
  let rowsChanged = false
  let statesChanged = false
  for (const change of changes) {
    const nextState = applyGroupedAverageChange(query, groupedAggregate, rows, states, change)
    if (!nextState) {
      return undefined
    }

    rows = nextState.rows
    states = nextState.states
    rowsChanged = rowsChanged || nextState.rowsChanged
    statesChanged = statesChanged || nextState.statesChanged
  }

  return Object.freeze({
    rows,
    rowsChanged,
    states,
    statesChanged,
  })
}

function applyGroupedAverageChange(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAverageStateObservation[],
  change: GroupedAverageChange,
): GroupedAveragePatchResult | undefined {
  const stateIndex = states.findIndex(state => Object.is(state.groupValue, change.groupValue))
  const currentState = stateIndex === -1
    ? createNewGroupedAverageState(groupedAggregate, change)
    : states[stateIndex]
  if (!currentState) {
    return undefined
  }

  const nextState = applyGroupedAverageStateChange(currentState, change)
  if (!nextState) {
    return undefined
  }

  const nextStates = updateGroupedAverageStates(states, stateIndex, nextState)
  const nextRows = updateGroupedAverageRows(groupedAggregate, rows, change.groupValue, nextState)
  const sortedRows = sortGroupedAggregateRows(query, groupedAggregate, nextRows)
  if (!sortedRows) {
    return undefined
  }

  return Object.freeze({
    rows: sortedRows,
    rowsChanged: sortedRows !== rows,
    states: nextStates,
    statesChanged: nextStates !== states,
  })
}

function createNewGroupedAverageState(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  change: GroupedAverageChange,
): DatabaseQueryGroupedAverageStateObservation | undefined {
  if (groupedAggregate.having || change.rowCountDelta <= 0 || change.countDelta <= 0) {
    return undefined
  }

  return Object.freeze({
    count: 0,
    groupValue: change.groupValue,
    rowCount: 0,
    sum: 0,
  })
}

function applyGroupedAverageStateChange(
  currentState: DatabaseQueryGroupedAverageStateObservation,
  change: GroupedAverageChange,
): DatabaseQueryGroupedAverageStateObservation | undefined {
  const count = currentState.count + change.countDelta
  const rowCount = currentState.rowCount + change.rowCountDelta
  const sum = currentState.sum + change.sumDelta
  if (count < 0 || rowCount < 0) {
    return undefined
  }

  return Object.freeze({
    count,
    groupValue: currentState.groupValue,
    rowCount,
    sum,
  })
}

function updateGroupedAverageStates(
  states: readonly DatabaseQueryGroupedAverageStateObservation[],
  stateIndex: number,
  nextState: DatabaseQueryGroupedAverageStateObservation,
): readonly DatabaseQueryGroupedAverageStateObservation[] {
  if (nextState.rowCount === 0) {
    return Object.freeze([
      ...states.slice(0, stateIndex),
      ...states.slice(stateIndex + 1),
    ])
  }

  if (stateIndex === -1) {
    return Object.freeze([...states, nextState])
  }

  return Object.freeze([
    ...states.slice(0, stateIndex),
    nextState,
    ...states.slice(stateIndex + 1),
  ])
}

function updateGroupedAverageRows(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  groupValue: unknown,
  nextState: DatabaseQueryGroupedAverageStateObservation,
): readonly Readonly<Record<string, unknown>>[] {
  const rowIndex = rows.findIndex(row => Object.is(row[groupedAggregate.groupResultKey], groupValue))
  const visible = nextState.rowCount > 0 && matchesGroupedCountHaving(groupedAggregate, nextState.rowCount)
  if (!visible) {
    return rowIndex === -1
      ? rows
      : Object.freeze([
          ...rows.slice(0, rowIndex),
          ...rows.slice(rowIndex + 1),
        ])
  }

  const average = nextState.count === 0 ? null : nextState.sum / nextState.count
  if (rowIndex === -1) {
    return Object.freeze([
      ...rows,
      Object.freeze({
        [groupedAggregate.aggregateResultKey]: average,
        [groupedAggregate.groupResultKey]: groupValue,
      }),
    ])
  }

  const currentRow = rows[rowIndex]!
  if (currentRow[groupedAggregate.aggregateResultKey] === average) {
    return rows
  }

  return Object.freeze([
    ...rows.slice(0, rowIndex),
    Object.freeze({
      ...currentRow,
      [groupedAggregate.aggregateResultKey]: average,
    }),
    ...rows.slice(rowIndex + 1),
  ])
}

function createGroupedAverageQueryState(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  states: readonly DatabaseQueryGroupedAverageStateObservation[],
): DatabaseQueryObservation {
  return Object.freeze({
    ...query,
    groupedAggregate: Object.freeze({
      ...groupedAggregate,
      averageStates: states,
    }),
  })
}
