import type { DatabaseMutationEvent } from './dependencies'
import {
  groupedExtremeValueReplaces,
  matchesGroupedCountHaving,
  readGroupedAggregateCurrentValue,
  readGroupedAggregateNumericContribution,
  readMatchingGroupedAggregateValue,
  sortGroupedAggregateRows,
} from './query-grouped-aggregate-common'
import { backfillGroupedAggregateRows } from './query-grouped-aggregate-backfill'
import { tryPatchGroupedAverageQuery } from './query-grouped-average-patching'
import {
  tryPatchGroupedAggregateDeltas,
  tryPatchGroupedAggregateDeltasWithState,
} from './query-grouped-aggregate-deltas'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import type {
  BackfillCache,
  DatabaseQueryGroupedAggregateObservation,
  DatabaseQueryGroupedAggregateStateObservation,
  DatabaseQueryGroupedAggregateValueCountObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'

type GroupedExtremePatch = {
  readonly groupValue: unknown
  readonly value: number
}

type GroupedExtremeStatePatchResult = {
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly rowsChanged: boolean
  readonly states: readonly DatabaseQueryGroupedAggregateStateObservation[]
  readonly statesChanged: boolean
}

type DeltaPatchableGroupedAggregateObservation = DatabaseQueryGroupedAggregateObservation & {
  readonly kind: 'count' | 'sum'
}

type ExtremePatchableGroupedAggregateObservation = DatabaseQueryGroupedAggregateObservation & {
  readonly kind: 'max' | 'min'
}

export function tryPatchGroupedAggregateQuery(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills?: BackfillCache,
): PatchQueryResult | Promise<PatchQueryResult> {
  const groupedAggregate = query.groupedAggregate
  if (!groupedAggregate) {
    return UNPATCHED_RESULT
  }

  if (groupedAggregate.kind === 'avg') {
    const averagePatch = tryPatchGroupedAverageQuery(query, groupedAggregate, rows, mutations)
    if (averagePatch) {
      return averagePatch
    }

    return backfills
      ? backfillGroupedAggregateRows(query, groupedAggregate, rows, mutations, backfills)
      : UNPATCHED_RESULT
  }

  if (isDeltaPatchableGroupedAggregate(groupedAggregate)) {
    return tryPatchGroupedDeltaQuery(query, groupedAggregate, rows, mutations, backfills)
  }

  if (isExtremePatchableGroupedAggregate(groupedAggregate)) {
    return tryPatchGroupedExtremeQuery(query, groupedAggregate, rows, mutations, backfills)
  }

  return backfills
    ? backfillGroupedAggregateRows(query, groupedAggregate, rows, mutations, backfills)
    : UNPATCHED_RESULT
}

function isDeltaPatchableGroupedAggregate(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
): groupedAggregate is DeltaPatchableGroupedAggregateObservation {
  return groupedAggregate.kind === 'count' || groupedAggregate.kind === 'sum'
}

function isExtremePatchableGroupedAggregate(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
): groupedAggregate is ExtremePatchableGroupedAggregateObservation {
  return groupedAggregate.kind === 'max' || groupedAggregate.kind === 'min'
}

function tryPatchGroupedDeltaQuery(
  query: DatabaseQueryObservation,
  groupedAggregate: DeltaPatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills?: BackfillCache,
): PatchQueryResult | Promise<PatchQueryResult> {
  const statePatchResult = tryPatchGroupedAggregateDeltasWithState(query, groupedAggregate, rows, mutations)
  if (statePatchResult) {
    return statePatchResult
  }

  if (groupedAggregate.aggregateStates) {
    return backfills
      ? backfillGroupedAggregateRows(query, groupedAggregate, rows, mutations, backfills)
      : UNPATCHED_RESULT
  }

  let patchedRows = rows
  let changed = false
  for (const mutation of mutations) {
    const patchResult = tryPatchGroupedAggregateDeltas(query, groupedAggregate, patchedRows, mutation)
    if (!patchResult) {
      return backfills
        ? backfillGroupedAggregateRows(query, groupedAggregate, rows, mutations, backfills)
        : UNPATCHED_RESULT
    }

    if (!patchResult.patched) {
      continue
    }

    changed = true
    patchedRows = patchResult.rows
  }

  return changed
    ? Object.freeze({
        patched: true,
        query,
        value: patchedRows,
      })
    : UNCHANGED_QUERY_RESULT
}

function tryPatchGroupedExtremeQueryWithState(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
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
    const patchResult = applyGroupedExtremeStateMutation(query, groupedAggregate, nextRows, nextStates, mutation)
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

  const nextQuery = createGroupedExtremeStateQuery(query, groupedAggregate, nextStates)
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

function applyGroupedExtremeStateMutation(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  mutation: DatabaseMutationEvent,
): GroupedExtremeStatePatchResult | undefined {
  if (mutation.kind === 'insert') {
    return mutation.rows
      ? applyGroupedExtremeStateInsertRows(query, groupedAggregate, rows, states, mutation.rows)
      : undefined
  }

  if (mutation.kind === 'delete') {
    return mutation.rows
      ? applyGroupedExtremeStateDeleteRows(query, groupedAggregate, rows, states, mutation.rows)
      : undefined
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  return applyGroupedExtremeStateUpdateRows(query, groupedAggregate, rows, states, mutation.previousRows, mutation.rows)
}

function applyGroupedExtremeStateInsertRows(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  insertedRows: readonly Readonly<Record<string, unknown>>[],
): GroupedExtremeStatePatchResult | undefined {
  let nextRows = rows
  let nextStates = states
  let rowsChanged = false
  let statesChanged = false
  for (const row of insertedRows) {
    const patch = readGroupedExtremePatch(query, groupedAggregate, row)
    if (!patch) {
      return undefined
    }

    if (patch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
      continue
    }

    const patchResult = applyGroupedExtremeStateInsert(query, groupedAggregate, nextRows, nextStates, patch)
    if (!patchResult) {
      return undefined
    }

    nextRows = patchResult.rows
    nextStates = patchResult.states
    rowsChanged = rowsChanged || patchResult.rowsChanged
    statesChanged = statesChanged || patchResult.statesChanged
  }

  return Object.freeze({
    rows: nextRows,
    rowsChanged,
    states: nextStates,
    statesChanged,
  })
}

function applyGroupedExtremeStateDeleteRows(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  deletedRows: readonly Readonly<Record<string, unknown>>[],
): GroupedExtremeStatePatchResult | undefined {
  let nextRows = rows
  let nextStates = states
  let rowsChanged = false
  let statesChanged = false
  for (const row of deletedRows) {
    const patch = readGroupedExtremePatch(query, groupedAggregate, row)
    if (!patch) {
      return undefined
    }

    if (patch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
      continue
    }

    const patchResult = applyGroupedExtremeStateDelete(groupedAggregate, nextRows, nextStates, patch)
    if (!patchResult) {
      return undefined
    }

    nextRows = patchResult.rows
    nextStates = patchResult.states
    rowsChanged = rowsChanged || patchResult.rowsChanged
    statesChanged = statesChanged || patchResult.statesChanged
  }

  const sortedRows = rowsChanged ? sortGroupedAggregateRows(query, groupedAggregate, nextRows) : nextRows
  return sortedRows
    ? Object.freeze({
        rows: sortedRows,
        rowsChanged,
        states: nextStates,
        statesChanged,
      })
    : undefined
}

function applyGroupedExtremeStateUpdateRows(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  previousRows: readonly Readonly<Record<string, unknown>>[],
  nextMutationRows: readonly Readonly<Record<string, unknown>>[],
): GroupedExtremeStatePatchResult | undefined {
  let nextRows = rows
  let nextStates = states
  let rowsChanged = false
  let statesChanged = false
  for (let index = 0; index < nextMutationRows.length; index += 1) {
    const previousRow = previousRows[index]
    const nextRow = nextMutationRows[index]
    if (!previousRow || !nextRow) {
      return undefined
    }

    const previousPatch = readGroupedExtremePatch(query, groupedAggregate, previousRow)
    const nextPatch = readGroupedExtremePatch(query, groupedAggregate, nextRow)
    if (!previousPatch || !nextPatch) {
      return undefined
    }

    const patchResult = applyGroupedExtremeStateUpdate(
      query,
      groupedAggregate,
      nextRows,
      nextStates,
      previousPatch,
      nextPatch,
    )
    if (!patchResult) {
      return undefined
    }

    nextRows = patchResult.rows
    nextStates = patchResult.states
    rowsChanged = rowsChanged || patchResult.rowsChanged
    statesChanged = statesChanged || patchResult.statesChanged
  }

  return Object.freeze({
    rows: nextRows,
    rowsChanged,
    states: nextStates,
    statesChanged,
  })
}

function tryPatchGroupedExtremeQuery(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills?: BackfillCache,
): PatchQueryResult | Promise<PatchQueryResult> {
  const statePatchResult = tryPatchGroupedExtremeQueryWithState(query, groupedAggregate, rows, mutations)
  if (statePatchResult) {
    return statePatchResult
  }

  if (groupedAggregate.aggregateStates || groupedAggregate.having) {
    return backfills
      ? backfillGroupedAggregateRows(query, groupedAggregate, rows, mutations, backfills)
      : UNPATCHED_RESULT
  }

  let patchedRows = rows
  let changed = false
  for (const mutation of mutations) {
    const nextRows = applyGroupedExtremeMutation(query, groupedAggregate, patchedRows, mutation)
    if (!nextRows) {
      return backfills
        ? backfillGroupedAggregateRows(query, groupedAggregate, rows, mutations, backfills)
        : UNPATCHED_RESULT
    }

    if (nextRows !== GROUPED_AGGREGATE_UNCHANGED_ROWS) {
      changed = true
      patchedRows = nextRows
    }
  }

  return changed
    ? Object.freeze({
        patched: true,
        query,
        value: patchedRows,
      })
    : UNCHANGED_QUERY_RESULT
}

function applyGroupedExtremeStateInsert(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  patch: GroupedExtremePatch,
): GroupedExtremeStatePatchResult | undefined {
  const stateIndex = states.findIndex(state => Object.is(state.groupValue, patch.groupValue))
  const previousState = states[stateIndex]
  const previousVisible = previousState ? matchesGroupedExtremeStateHaving(groupedAggregate, previousState) : false
  const nextValueCounts = previousState ? readNextGroupedExtremeValueCounts(previousState, patch.value, 1) : undefined
  if (previousState?.valueCounts && !nextValueCounts) {
    return undefined
  }

  const nextAggregateValue = nextValueCounts
    ? readGroupedExtremeValueCountsExtreme(groupedAggregate, nextValueCounts.valueCounts)
    : undefined
  if (nextValueCounts && typeof nextAggregateValue === 'undefined') {
    return undefined
  }

  const nextState = previousState
    ? createGroupedExtremeInsertState(groupedAggregate, previousState, patch.value, nextValueCounts, nextAggregateValue)
    : Object.freeze({
      aggregateValue: patch.value,
      groupValue: patch.groupValue,
      rowCount: 1,
      valueCounts: Object.freeze([Object.freeze({ count: 1, value: patch.value })]),
    })
  const nextStates = replaceGroupedExtremeState(states, stateIndex, nextState)
  const rowResult = applyGroupedExtremeStateRow(
    groupedAggregate,
    rows,
    patch.groupValue,
    previousVisible,
    matchesGroupedExtremeStateHaving(groupedAggregate, nextState),
    nextState,
  )
  if (!rowResult) {
    return undefined
  }

  const sortedRows = rowResult.changed ? sortGroupedAggregateRows(query, groupedAggregate, rowResult.rows) : rowResult.rows
  return sortedRows
    ? Object.freeze({
        rows: sortedRows,
        rowsChanged: rowResult.changed,
        states: nextStates,
        statesChanged: true,
      })
    : undefined
}

function applyGroupedExtremeStateDelete(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  patch: GroupedExtremePatch,
): GroupedExtremeStatePatchResult | undefined {
  const stateIndex = states.findIndex(state => Object.is(state.groupValue, patch.groupValue))
  const previousState = states[stateIndex]
  if (!previousState || previousState.rowCount <= 0) {
    return undefined
  }

  const nextRowCount = previousState.rowCount - 1
  const nextValueCounts = readNextGroupedExtremeValueCounts(previousState, patch.value, -1)
  if (previousState.valueCounts && !nextValueCounts) {
    return undefined
  }

  const previousVisible = matchesGroupedExtremeStateHaving(groupedAggregate, previousState)
  let nextState: DatabaseQueryGroupedAggregateStateObservation | null = null
  if (nextRowCount > 0) {
    const deleteState = createGroupedExtremeDeleteState(
      groupedAggregate,
      previousState,
      patch.value,
      nextRowCount,
      nextValueCounts,
    )
    if (!deleteState) {
      return undefined
    }

    nextState = deleteState
  }
  const nextStates = replaceGroupedExtremeState(states, stateIndex, nextState)
  const rowResult = applyGroupedExtremeStateRow(
    groupedAggregate,
    rows,
    patch.groupValue,
    previousVisible,
    nextState ? matchesGroupedExtremeStateHaving(groupedAggregate, nextState) : false,
    nextState,
  )
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

function applyGroupedExtremeStateUpdate(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  previousPatch: GroupedExtremePatch | typeof GROUPED_AGGREGATE_UNCHANGED_PATCH,
  nextPatch: GroupedExtremePatch | typeof GROUPED_AGGREGATE_UNCHANGED_PATCH,
): GroupedExtremeStatePatchResult | undefined {
  if (previousPatch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
    return nextPatch === GROUPED_AGGREGATE_UNCHANGED_PATCH
      ? Object.freeze({ rows, rowsChanged: false, states, statesChanged: false })
      : applyGroupedExtremeStateInsert(query, groupedAggregate, rows, states, nextPatch)
  }

  if (nextPatch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
    return applyGroupedExtremeStateDelete(groupedAggregate, rows, states, previousPatch)
  }

  if (!Object.is(previousPatch.groupValue, nextPatch.groupValue)) {
    const deleteResult = applyGroupedExtremeStateDelete(groupedAggregate, rows, states, previousPatch)
    if (!deleteResult) {
      return undefined
    }

    const insertResult = applyGroupedExtremeStateInsert(query, groupedAggregate, deleteResult.rows, deleteResult.states, nextPatch)
    return insertResult
      ? Object.freeze({
          rows: insertResult.rows,
          rowsChanged: deleteResult.rowsChanged || insertResult.rowsChanged,
          states: insertResult.states,
          statesChanged: true,
        })
      : undefined
  }

  return applyGroupedExtremeSameGroupStateUpdate(query, groupedAggregate, rows, states, previousPatch, nextPatch)
}

function applyGroupedExtremeSameGroupStateUpdate(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  states: readonly DatabaseQueryGroupedAggregateStateObservation[],
  previousPatch: GroupedExtremePatch,
  nextPatch: GroupedExtremePatch,
): GroupedExtremeStatePatchResult | undefined {
  const stateIndex = states.findIndex(state => Object.is(state.groupValue, previousPatch.groupValue))
  const previousState = states[stateIndex]
  if (!previousState) {
    return undefined
  }

  const previousVisible = matchesGroupedExtremeStateHaving(groupedAggregate, previousState)
  const nextValueCounts = readNextGroupedExtremeUpdateValueCounts(previousState, previousPatch.value, nextPatch.value)
  if (previousState.valueCounts && !nextValueCounts) {
    return undefined
  }

  const nextAggregateValue = nextValueCounts
    ? readGroupedExtremeValueCountsExtreme(groupedAggregate, nextValueCounts.valueCounts)
    : readNextGroupedExtremeStateValue(groupedAggregate, previousState, previousPatch, nextPatch)
  if (typeof nextAggregateValue === 'undefined') {
    return undefined
  }

  const nextState = Object.freeze({
    aggregateValue: nextAggregateValue,
    groupValue: previousState.groupValue,
    rowCount: previousState.rowCount,
    ...nextValueCounts,
  })
  const nextStates = replaceGroupedExtremeState(states, stateIndex, nextState)
  const rowResult = applyGroupedExtremeStateRow(
    groupedAggregate,
    rows,
    previousPatch.groupValue,
    previousVisible,
    matchesGroupedExtremeStateHaving(groupedAggregate, nextState),
    nextState,
  )
  if (!rowResult) {
    return undefined
  }

  const sortedRows = rowResult.changed ? sortGroupedAggregateRows(query, groupedAggregate, rowResult.rows) : rowResult.rows
  return sortedRows
    ? Object.freeze({
        rows: sortedRows,
        rowsChanged: rowResult.changed,
        states: nextStates,
        statesChanged: !Object.is(nextAggregateValue, previousState.aggregateValue),
      })
    : undefined
}

function applyGroupedExtremeMutation(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutation: DatabaseMutationEvent,
): readonly Readonly<Record<string, unknown>>[] | typeof GROUPED_AGGREGATE_UNCHANGED_ROWS | undefined {
  if (mutation.kind === 'insert') {
    return mutation.rows
      ? applyGroupedExtremeInsertRows(query, groupedAggregate, rows, mutation.rows)
      : undefined
  }

  if (mutation.kind === 'delete') {
    return mutation.rows
      ? applyGroupedExtremeDeleteRows(query, groupedAggregate, rows, mutation.rows)
      : undefined
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  return applyGroupedExtremeUpdateRows(query, groupedAggregate, rows, mutation.previousRows, mutation.rows)
}

function applyGroupedExtremeInsertRows(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  insertedRows: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] | typeof GROUPED_AGGREGATE_UNCHANGED_ROWS | undefined {
  let nextRows = rows
  let changed = false
  for (const row of insertedRows) {
    const patch = readGroupedExtremePatch(query, groupedAggregate, row)
    if (!patch) {
      return undefined
    }

    if (patch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
      continue
    }

    const patchedRows = applyGroupedExtremePatch(query, groupedAggregate, nextRows, patch)
    if (!patchedRows) {
      return undefined
    }

    if (patchedRows !== nextRows) {
      changed = true
      nextRows = patchedRows
    }
  }

  return changed ? nextRows : GROUPED_AGGREGATE_UNCHANGED_ROWS
}

function applyGroupedExtremeDeleteRows(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  deletedRows: readonly Readonly<Record<string, unknown>>[],
): typeof GROUPED_AGGREGATE_UNCHANGED_ROWS | undefined {
  for (const row of deletedRows) {
    const patch = readGroupedExtremePatch(query, groupedAggregate, row)
    if (!patch) {
      return undefined
    }

    if (patch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
      continue
    }

    const currentValue = readGroupedAggregateCurrentValue(groupedAggregate, rows, patch.groupValue)
    if (typeof currentValue !== 'number') {
      return undefined
    }

    if (Object.is(currentValue, patch.value)) {
      return undefined
    }
  }

  return GROUPED_AGGREGATE_UNCHANGED_ROWS
}

function applyGroupedExtremeUpdateRows(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  previousRows: readonly Readonly<Record<string, unknown>>[],
  nextMutationRows: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] | typeof GROUPED_AGGREGATE_UNCHANGED_ROWS | undefined {
  let nextRows = rows
  let changed = false
  for (let index = 0; index < nextMutationRows.length; index += 1) {
    const previousRow = previousRows[index]
    const nextRow = nextMutationRows[index]
    if (!previousRow || !nextRow) {
      return undefined
    }

    const previousPatch = readGroupedExtremePatch(query, groupedAggregate, previousRow)
    const nextPatch = readGroupedExtremePatch(query, groupedAggregate, nextRow)
    if (!previousPatch || !nextPatch) {
      return undefined
    }

    const patchedRows = applyGroupedExtremeUpdatePatch(
      query,
      groupedAggregate,
      nextRows,
      previousPatch,
      nextPatch,
    )
    if (!patchedRows) {
      return undefined
    }

    if (patchedRows !== GROUPED_AGGREGATE_UNCHANGED_ROWS && patchedRows !== nextRows) {
      changed = true
      nextRows = patchedRows
    }
  }

  return changed ? nextRows : GROUPED_AGGREGATE_UNCHANGED_ROWS
}

function applyGroupedExtremeUpdatePatch(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  previousPatch: GroupedExtremePatch | typeof GROUPED_AGGREGATE_UNCHANGED_PATCH,
  nextPatch: GroupedExtremePatch | typeof GROUPED_AGGREGATE_UNCHANGED_PATCH,
): readonly Readonly<Record<string, unknown>>[] | typeof GROUPED_AGGREGATE_UNCHANGED_ROWS | undefined {
  if (previousPatch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
    return nextPatch === GROUPED_AGGREGATE_UNCHANGED_PATCH
      ? GROUPED_AGGREGATE_UNCHANGED_ROWS
      : applyGroupedExtremePatch(query, groupedAggregate, rows, nextPatch)
  }

  const currentValue = readGroupedAggregateCurrentValue(groupedAggregate, rows, previousPatch.groupValue)
  if (typeof currentValue !== 'number') {
    return undefined
  }

  if (nextPatch === GROUPED_AGGREGATE_UNCHANGED_PATCH) {
    return Object.is(currentValue, previousPatch.value) ? undefined : GROUPED_AGGREGATE_UNCHANGED_ROWS
  }

  if (!Object.is(previousPatch.groupValue, nextPatch.groupValue)) {
    return Object.is(currentValue, previousPatch.value)
      ? undefined
      : applyGroupedExtremePatch(query, groupedAggregate, rows, nextPatch)
  }

  if (Object.is(currentValue, previousPatch.value)) {
    if (groupedExtremeValueReplaces(groupedAggregate, currentValue, nextPatch.value)) {
      return applyGroupedExtremePatch(query, groupedAggregate, rows, nextPatch)
    }

    return Object.is(currentValue, nextPatch.value) ? GROUPED_AGGREGATE_UNCHANGED_ROWS : undefined
  }

  return groupedExtremeValueReplaces(groupedAggregate, currentValue, nextPatch.value)
    ? applyGroupedExtremePatch(query, groupedAggregate, rows, nextPatch)
    : GROUPED_AGGREGATE_UNCHANGED_ROWS
}

const GROUPED_AGGREGATE_UNCHANGED_PATCH = Symbol('grouped aggregate unchanged patch')
const GROUPED_AGGREGATE_UNCHANGED_ROWS = Symbol('grouped aggregate unchanged rows')

function readGroupedExtremePatch(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  row: Readonly<Record<string, unknown>>,
): GroupedExtremePatch | typeof GROUPED_AGGREGATE_UNCHANGED_PATCH | undefined {
  const groupValue = readMatchingGroupedAggregateValue(query, groupedAggregate, row)
  if (groupValue.matched === 'unknown') {
    return undefined
  }

  if (!groupValue.matched) {
    return GROUPED_AGGREGATE_UNCHANGED_PATCH
  }

  const value = readGroupedAggregateNumericContribution(groupedAggregate, row)
  return typeof value === 'number'
    ? Object.freeze({ groupValue: groupValue.value, value })
    : undefined
}

function applyGroupedExtremePatch(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  patch: GroupedExtremePatch,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const index = rows.findIndex(row => Object.is(row[groupedAggregate.groupResultKey], patch.groupValue))
  if (index === -1) {
    return sortGroupedAggregateRows(query, groupedAggregate, [
      ...rows,
      Object.freeze({
        [groupedAggregate.groupResultKey]: patch.groupValue,
        [groupedAggregate.aggregateResultKey]: patch.value,
      }),
    ])
  }

  const row = rows[index]!
  const currentValue = row[groupedAggregate.aggregateResultKey]
  if (typeof currentValue !== 'number') {
    return undefined
  }

  if (!groupedExtremeValueReplaces(groupedAggregate, currentValue, patch.value)) {
    return rows
  }

  return [
    ...rows.slice(0, index),
    Object.freeze({
      ...row,
      [groupedAggregate.aggregateResultKey]: patch.value,
    }),
    ...rows.slice(index + 1),
  ]
}

function readNextGroupedExtremeStateValue(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  state: DatabaseQueryGroupedAggregateStateObservation,
  previousPatch: GroupedExtremePatch,
  nextPatch: GroupedExtremePatch,
): number | undefined {
  if (!Object.is(state.aggregateValue, previousPatch.value)) {
    return groupedExtremeValueReplaces(groupedAggregate, state.aggregateValue, nextPatch.value)
      ? nextPatch.value
      : state.aggregateValue
  }

  if (state.rowCount === 1) {
    return nextPatch.value
  }

  if (
    Object.is(previousPatch.value, nextPatch.value)
    || groupedExtremeValueReplaces(groupedAggregate, previousPatch.value, nextPatch.value)
  ) {
    return nextPatch.value
  }

  return undefined
}

function createGroupedExtremeInsertState(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  previousState: DatabaseQueryGroupedAggregateStateObservation,
  insertedValue: number,
  valueCounts: { readonly valueCounts: readonly DatabaseQueryGroupedAggregateValueCountObservation[] } | undefined,
  aggregateValue: number | undefined,
): DatabaseQueryGroupedAggregateStateObservation {
  return Object.freeze({
    aggregateValue: typeof aggregateValue === 'number'
      ? aggregateValue
      : readNextGroupedExtremeStateInsertValue(groupedAggregate, previousState, insertedValue),
    groupValue: previousState.groupValue,
    rowCount: previousState.rowCount + 1,
    ...valueCounts,
  })
}

function createGroupedExtremeDeleteState(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  previousState: DatabaseQueryGroupedAggregateStateObservation,
  deletedValue: number,
  rowCount: number,
  valueCounts: { readonly valueCounts: readonly DatabaseQueryGroupedAggregateValueCountObservation[] } | undefined,
): DatabaseQueryGroupedAggregateStateObservation | undefined {
  const aggregateValue = readNextGroupedExtremeDeleteValue(
    groupedAggregate,
    previousState,
    deletedValue,
    valueCounts?.valueCounts,
  )
  if (typeof aggregateValue === 'undefined') {
    return undefined
  }

  return Object.freeze({
    aggregateValue,
    groupValue: previousState.groupValue,
    rowCount,
    ...valueCounts,
  })
}

function readNextGroupedExtremeStateInsertValue(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  state: DatabaseQueryGroupedAggregateStateObservation,
  value: number,
): number {
  return groupedExtremeValueReplaces(groupedAggregate, state.aggregateValue, value)
    ? value
    : state.aggregateValue
}

function readNextGroupedExtremeDeleteValue(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  state: DatabaseQueryGroupedAggregateStateObservation,
  value: number,
  valueCounts: readonly DatabaseQueryGroupedAggregateValueCountObservation[] | undefined,
): number | undefined {
  if (valueCounts) {
    return readGroupedExtremeValueCountsExtreme(groupedAggregate, valueCounts)
  }

  return Object.is(state.aggregateValue, value)
    ? undefined
    : state.aggregateValue
}

function readNextGroupedExtremeUpdateValueCounts(
  state: DatabaseQueryGroupedAggregateStateObservation,
  previousValue: number,
  nextValue: number,
): { readonly valueCounts: readonly DatabaseQueryGroupedAggregateValueCountObservation[] } | undefined {
  const decrementedCounts = readNextGroupedExtremeValueCounts(state, previousValue, -1)
  if (!decrementedCounts) {
    return undefined
  }

  return readNextGroupedExtremeValueCounts(
    Object.freeze({
      ...state,
      valueCounts: decrementedCounts.valueCounts,
    }),
    nextValue,
    1,
  )
}

function readNextGroupedExtremeValueCounts(
  state: DatabaseQueryGroupedAggregateStateObservation,
  value: number,
  delta: -1 | 1,
): { readonly valueCounts: readonly DatabaseQueryGroupedAggregateValueCountObservation[] } | undefined {
  const valueCounts = state.valueCounts
  if (!valueCounts) {
    return undefined
  }

  const nextValueCounts: DatabaseQueryGroupedAggregateValueCountObservation[] = []
  let matched = false
  for (const valueCount of valueCounts) {
    if (!Object.is(valueCount.value, value)) {
      nextValueCounts.push(valueCount)
      continue
    }

    matched = true
    const nextCount = valueCount.count + delta
    if (nextCount < 0) {
      return undefined
    }

    if (nextCount > 0) {
      nextValueCounts.push(Object.freeze({
        count: nextCount,
        value: valueCount.value,
      }))
    }
  }

  if (!matched) {
    if (delta < 0) {
      return undefined
    }

    nextValueCounts.push(Object.freeze({ count: 1, value }))
  }

  return Object.freeze({
    valueCounts: Object.freeze([...nextValueCounts].sort((left, right) => left.value - right.value)),
  })
}

function readGroupedExtremeValueCountsExtreme(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  valueCounts: readonly DatabaseQueryGroupedAggregateValueCountObservation[],
): number | undefined {
  let result: number | undefined
  for (const valueCount of valueCounts) {
    if (valueCount.count <= 0) {
      return undefined
    }

    result = typeof result === 'undefined' || groupedExtremeValueReplaces(groupedAggregate, result, valueCount.value)
      ? valueCount.value
      : result
  }

  return result
}

function replaceGroupedExtremeState(
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

function matchesGroupedExtremeStateHaving(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
  state: DatabaseQueryGroupedAggregateStateObservation,
): boolean {
  return state.rowCount > 0 && matchesGroupedCountHaving(groupedAggregate, state.rowCount)
}

function applyGroupedExtremeStateRow(
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
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

  const currentRow = rows[rowIndex]!
  if (Object.is(currentRow[groupedAggregate.aggregateResultKey], nextState!.aggregateValue)) {
    return Object.freeze({ changed: false, rows })
  }

  return Object.freeze({
    changed: true,
    rows: Object.freeze([
      ...rows.slice(0, rowIndex),
      Object.freeze({
        ...currentRow,
        [groupedAggregate.aggregateResultKey]: nextState!.aggregateValue,
      }),
      ...rows.slice(rowIndex + 1),
    ]),
  })
}

function createGroupedExtremeStateQuery(
  query: DatabaseQueryObservation,
  groupedAggregate: ExtremePatchableGroupedAggregateObservation,
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
