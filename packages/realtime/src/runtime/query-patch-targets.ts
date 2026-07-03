import {
  createMutationIndexKey,
} from './dependencies'
import {
  hasRecordKey,
  readQueryExactIdPredicateValue,
} from './predicate-matching'
import {
  hasProjectedSelections,
  hasQueryOrderBy,
  isOffsetOrderedLimitedWindow,
  isSingleIdQuery,
  readQueryOrderColumns,
  readQueryOrderMultipliers,
  readQueryPredicateColumns,
  readQueryProjectedIdentityColumn,
  readQueryRowWindowMode,
  readQuerySelectionColumns,
  readQuerySelectionResultKeys,
} from './query-metadata'
import {
  selectAggregatePatchMode,
} from './query-aggregate-patching'
import {
  createQueryRowIdentityIndex,
} from './query-row-identity'
import {
  createQueryRowPatchContext,
  selectRowMutationApplier,
} from './query-row-patching'
import {
  EMPTY_RESULT_PATH,
  EMPTY_RESULT_PATH_KEY,
  createResultPathKey,
  getValueAtPath,
  type RealtimePatchPathSegment,
} from './result-patching'
import type {
  AggregatePatchMode,
  DatabaseQueryObservation,
  PatchableQueryPatchTarget,
  QueryPatchCapability,
  QueryPatchPlan,
  QueryPatchTarget,
  RecordQueryPatchTarget,
  RowPatchMode,
  RowsQueryPatchTarget,
  ScalarListQueryPatchTarget,
  ScalarQueryPatchTarget,
} from './query-state'
import type { ActiveQueryEntry } from './state'
import { isRecord, isRecordArray } from './value'
import type { RealtimeQueryDefinitionMetadata } from '../contracts'

function createPatchPathKey(query: DatabaseQueryObservation): string {
  return query.resultPathKey ?? (query.resultPath ? createResultPathKey(query.resultPath) : EMPTY_RESULT_PATH_KEY)
}

export function readPatchPathKey(
  query: DatabaseQueryObservation,
  target?: QueryPatchTarget,
): string {
  if (query.resultPathKey) {
    return query.resultPathKey
  }

  if (target && (query.resultPath ?? EMPTY_RESULT_PATH) === target.resultPath) {
    return target.resultPathKey
  }

  return createPatchPathKey(query)
}

function createQueryPatchPlan(query: DatabaseQueryObservation): QueryPatchPlan {
  const aggregatePatchMode = query.groupedAggregate ? undefined : selectAggregatePatchMode(query)
  return Object.freeze({
    aggregatePatchMode,
    mutationIndexKey: query.mutationIndexKey ?? createMutationIndexKey(query.connectionName, query.tableName),
    resultPath: query.resultPath ?? EMPTY_RESULT_PATH,
    resultPathKey: readPatchPathKey(query),
    rowContext: aggregatePatchMode ? undefined : createQueryRowPatchContext(query),
    rowMutationApplier: aggregatePatchMode ? undefined : selectRowMutationApplier(query),
  })
}

function readQueryPatchPlan(query: DatabaseQueryObservation): QueryPatchPlan {
  return query.patchPlan ?? createQueryPatchPlan(query)
}

export function createPatchedQueryObservation(
  query: DatabaseQueryObservation,
  result: unknown,
  resultPathKey: string,
): DatabaseQueryObservation {
  return Object.freeze({
    aggregate: query.aggregate,
    aggregateBackfillKey: query.aggregateBackfillKey,
    aggregateScopeKey: query.aggregateScopeKey,
    belongsToHydrations: query.belongsToHydrations,
    connectionName: query.connectionName,
    cursorRowCount: query.cursorRowCount,
    cursorRows: query.cursorRows,
    dependencies: query.dependencies,
    emptyRecordValue: query.emptyRecordValue,
    exactId: readQueryExactIdPredicateValue(query),
    groupedAggregate: query.groupedAggregate,
    hasOrderBy: hasQueryOrderBy(query),
    hasProjectedSelections: hasProjectedSelections(query),
    isOffsetOrderedLimited: isOffsetOrderedLimitedWindow(query),
    isSingleId: isSingleIdQuery(query),
    limit: query.limit,
    mutationIndexKey: query.mutationIndexKey,
    offset: query.offset,
    orderBy: query.orderBy,
    orderColumns: readQueryOrderColumns(query),
    orderMultipliers: readQueryOrderMultipliers(query),
    patchable: query.patchable,
    pagination: query.pagination,
    patchPlan: query.patchPlan?.resultPathKey === resultPathKey ? query.patchPlan : undefined,
    predicateColumns: readQueryPredicateColumns(query),
    predicates: query.predicates,
    relation: query.relation,
    projectedIdentityColumn: readQueryProjectedIdentityColumn(query),
    result,
    resultBound: query.resultBound,
    resultPath: query.resultPath ?? EMPTY_RESULT_PATH,
    resultPathKey,
    relatedHydrations: query.relatedHydrations,
    rowIdentityIndex: createQueryRowIdentityIndex(result),
    rowWindowMode: readQueryRowWindowMode(query),
    rowBackfillKeyPrefix: query.rowBackfillKeyPrefix,
    scalarColumn: query.scalarColumn,
    scalarListColumn: query.scalarListColumn,
    scalarListRows: query.scalarListRows,
    selectionColumns: readQuerySelectionColumns(query),
    selectionResultKeys: readQuerySelectionResultKeys(query),
    selections: query.selections,
    tableName: query.tableName,
  })
}

export function createQueryPatchTargets(
  queries: readonly DatabaseQueryObservation[],
  data: unknown,
): QueryPatchTarget[] {
  const targets: QueryPatchTarget[] = []
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index]
    if (query) {
      targets.push(createQueryPatchTarget(query, index, data))
    }
  }

  return targets
}

function createQueryPatchTarget(
  query: DatabaseQueryObservation,
  index: number,
  data: unknown,
): QueryPatchTarget {
  const plan = readQueryPatchPlan(query)
  const aggregatePatchMode = plan.aggregatePatchMode
  const resultPath = plan.resultPath
  const currentValue = query.resultBound === true ? query.result : getValueAtPath(data, resultPath)
  const rowPatchMode = selectRowPatchMode(currentValue, query, aggregatePatchMode)
  const skipsPatching = shouldSkipQueryPatchTarget(resultPath, data)
  return Object.freeze({
    aggregatePatchMode,
    currentValue,
    index,
    mutationIndexKey: plan.mutationIndexKey,
    patchCapability: selectQueryPatchCapability(query, aggregatePatchMode, rowPatchMode, skipsPatching),
    query,
    rowMutationApplier: plan.rowMutationApplier,
    rowContext: plan.rowContext,
    rowPatchMode,
    skipsPatching,
    resultPath,
    resultPathKey: plan.resultPathKey,
  })
}

export function updatePatchedQueryPatchTarget(
  target: QueryPatchTarget,
  query: DatabaseQueryObservation,
  value: unknown,
  data: unknown,
  resultPath = query.resultPath ?? EMPTY_RESULT_PATH,
  resultPathKey = createPatchPathKey(query),
): QueryPatchTarget {
  const currentValue = resultPathKey === target.resultPathKey
    ? value
    : query.resultBound === true
      ? query.result
      : getValueAtPath(data, resultPath)
  const rowPatchMode = selectRowPatchMode(currentValue, query, target.aggregatePatchMode)
  const skipsPatching = shouldSkipQueryPatchTarget(resultPath, data)
  return Object.freeze({
    aggregatePatchMode: target.aggregatePatchMode,
    currentValue,
    index: target.index,
    mutationIndexKey: target.mutationIndexKey,
    patchCapability: selectQueryPatchCapability(query, target.aggregatePatchMode, rowPatchMode, skipsPatching),
    query,
    rowMutationApplier: target.rowMutationApplier,
    rowContext: target.rowContext,
    rowPatchMode,
    skipsPatching,
    resultPath,
    resultPathKey,
  })
}

export function updateQueryPatchTargetCurrentValue(
  target: QueryPatchTarget,
  query: DatabaseQueryObservation,
  data: unknown,
): QueryPatchTarget {
  const resultPath = query.resultPath ?? EMPTY_RESULT_PATH
  const currentValue = query.resultBound === true ? query.result : getValueAtPath(data, resultPath)
  const rowPatchMode = selectRowPatchMode(currentValue, query, target.aggregatePatchMode)
  const skipsPatching = shouldSkipQueryPatchTarget(resultPath, data)
  return Object.freeze({
    aggregatePatchMode: target.aggregatePatchMode,
    currentValue,
    index: target.index,
    mutationIndexKey: target.mutationIndexKey,
    patchCapability: selectQueryPatchCapability(query, target.aggregatePatchMode, rowPatchMode, skipsPatching),
    query,
    rowMutationApplier: target.rowMutationApplier,
    rowContext: target.rowContext,
    rowPatchMode,
    skipsPatching,
    resultPath: target.resultPath,
    resultPathKey: target.resultPathKey,
  })
}

export function updateDelayedPatchedQueryPatchTarget(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  index: number,
  data: unknown,
): void {
  const query = entry.queries[index]
  const target = entry.patchTargets[index]
  if (!query || !target) {
    return
  }

  const resultPath = query.resultPath ?? EMPTY_RESULT_PATH
  const resultPathKey = readPatchPathKey(query, target)
  entry.patchTargets[index] = updatePatchedQueryPatchTarget(
    target,
    query,
    query.result,
    data,
    resultPath,
    resultPathKey,
  )
}

function canReuseQueryPatchTarget(
  target: QueryPatchTarget | undefined,
  previousQuery: DatabaseQueryObservation | undefined,
  query: DatabaseQueryObservation,
  index: number,
  data: unknown,
): target is QueryPatchTarget {
  return typeof target !== 'undefined'
    && target.index === index
    && previousQuery === query
    && target.skipsPatching === shouldSkipQueryPatchTarget(query.resultPath ?? EMPTY_RESULT_PATH, data)
}

function updateQueryPatchTargets(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  previousQueries: readonly DatabaseQueryObservation[],
  queries: readonly DatabaseQueryObservation[],
  data: unknown,
): QueryPatchTarget[] {
  if (entry.patchTargets.length !== queries.length) {
    return createQueryPatchTargets(queries, data)
  }

  let nextTargets: QueryPatchTarget[] | undefined
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index]
    if (!query) {
      return createQueryPatchTargets(queries, data)
    }

    const previousTarget = entry.patchTargets[index]
    const canReuseTarget = canReuseQueryPatchTarget(
      previousTarget,
      previousQueries[index],
      query,
      index,
      data,
    )
    const target = canReuseTarget
      ? query.resultBound === true || entry.current?.data === data
        ? previousTarget
        : updateQueryPatchTargetCurrentValue(previousTarget, query, data)
      : createQueryPatchTarget(query, index, data)

    if (target !== previousTarget) {
      nextTargets ??= copyQueryPatchTargetsRange(entry.patchTargets, 0, index)
    }

    nextTargets?.push(target)
  }

  return nextTargets ?? entry.patchTargets
}

function copyQueryPatchTargetsRange(
  targets: readonly QueryPatchTarget[],
  start: number,
  end: number,
): QueryPatchTarget[] {
  const nextTargets: QueryPatchTarget[] = []
  for (let index = start; index < end; index += 1) {
    nextTargets.push(targets[index]!)
  }

  return nextTargets
}

export function updateQueryEntryObservedQueries(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  queries: readonly DatabaseQueryObservation[],
  data: unknown,
): void {
  const previousQueries = entry.queries
  const observedQueries = entry.queries === queries ? entry.queries : [...queries]
  entry.queries = observedQueries
  entry.patchTargets = updateQueryPatchTargets(entry, previousQueries, observedQueries, data)
}

function selectRowPatchMode(
  value: unknown,
  query: DatabaseQueryObservation,
  aggregatePatchMode: AggregatePatchMode | undefined,
): RowPatchMode | undefined {
  if (aggregatePatchMode) {
    return undefined
  }

  if (query.pagination && (query.pagination.kind === 'cursor' || isRecord(value))) {
    return 'pagination'
  }

  if (isRecordArray(value)) {
    return isOffsetOrderedLimitedWindow(query) ? 'offset-window' : 'rows'
  }

  if (query.scalarListColumn && Array.isArray(value)) {
    return 'scalar-list'
  }

  if (query.scalarColumn) {
    return 'scalar'
  }

  if (value === null || typeof value === 'undefined' || isRecord(value)) {
    return 'record'
  }

  return 'unsupported'
}

function selectQueryPatchCapability(
  query: DatabaseQueryObservation,
  aggregatePatchMode: AggregatePatchMode | undefined,
  rowPatchMode: RowPatchMode | undefined,
  skipsPatching: boolean,
): QueryPatchCapability {
  if (skipsPatching) {
    return query.patchable && (rowPatchMode === 'rows' || rowPatchMode === 'offset-window') ? 'patchable' : 'refresh'
  }

  if (aggregatePatchMode) {
    return aggregatePatchMode === 'unpatchable' ? 'refresh' : 'patchable'
  }

  if (rowPatchMode === 'offset-window') {
    return 'patchable'
  }

  if (rowPatchMode === 'pagination') {
    return query.patchable ? 'patchable' : 'refresh'
  }

  if (!query.patchable) {
    return 'refresh'
  }

  return rowPatchMode === 'rows'
    || rowPatchMode === 'record'
    || rowPatchMode === 'scalar'
    || rowPatchMode === 'scalar-list'
    ? 'patchable'
    : 'refresh'
}

export function isPatchableQueryPatchTarget(target: QueryPatchTarget): target is PatchableQueryPatchTarget {
  return target.patchCapability === 'patchable'
}

export function isRowsPatchTarget(target: QueryPatchTarget): target is RowsQueryPatchTarget {
  return target.rowPatchMode === 'rows' || target.rowPatchMode === 'offset-window'
}

export function isRecordPatchTarget(target: QueryPatchTarget): target is RecordQueryPatchTarget {
  return target.rowPatchMode === 'record'
}

export function isScalarPatchTarget(target: QueryPatchTarget): target is ScalarQueryPatchTarget {
  return target.rowPatchMode === 'scalar'
}

export function isScalarListPatchTarget(target: QueryPatchTarget): target is ScalarListQueryPatchTarget {
  return target.rowPatchMode === 'scalar-list'
}

function shouldSkipQueryPatchTarget(
  resultPath: readonly RealtimePatchPathSegment[],
  data: unknown,
): boolean {
  if (
    resultPath.length !== 1
    || resultPath[0] !== 'data'
    || !isRecord(data)
  ) {
    return false
  }

  return isRecord(data.meta) || (
    hasRecordKey(data, 'perPage')
    && hasRecordKey(data, 'cursorName')
    && hasRecordKey(data, 'nextCursor')
    && hasRecordKey(data, 'prevCursor')
  )
}
