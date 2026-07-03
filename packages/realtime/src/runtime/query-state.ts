import type {
  NO_EXACT_ID_PREDICATE,
  DatabaseQueryPredicateObservation,
  PredicateMatchContext,
} from './predicate-matching'
import type { RealtimePatchPathSegment } from './result-patching'
import type { DatabaseMutationEvent, MutationIndex, PredicateDependencyIndex } from './dependencies'

export type DatabaseQueryObservation = {
  readonly aggregate?: DatabaseQueryAggregateObservation
  readonly aggregateBackfillKey?: string
  readonly aggregateScopeKey?: string
  readonly belongsToHydrations?: readonly DatabaseQueryBelongsToHydrationObservation[]
  readonly connectionName: string
  readonly cursorRowCount?: number
  readonly cursorRows?: readonly Readonly<Record<string, unknown>>[]
  readonly dependencies: readonly string[]
  readonly emptyRecordValue?: null
  readonly exactId?: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly groupedAggregate?: DatabaseQueryGroupedAggregateObservation
  readonly hasOrderBy?: boolean
  readonly hasProjectedSelections?: boolean
  readonly isOffsetOrderedLimited?: boolean
  readonly isSingleId?: boolean
  readonly limit?: number
  readonly mutationIndexKey?: string
  readonly offset?: number
  readonly orderBy: readonly DatabaseQueryOrderObservation[]
  readonly orderColumns?: readonly string[]
  readonly orderMultipliers?: readonly number[]
  readonly patchable: boolean
  readonly pagination?: DatabaseQueryPaginationObservation
  readonly predicateColumns?: readonly string[]
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly relation?: DatabaseQueryRelationObservation
  readonly projectedIdentityColumn?: string | typeof NO_PROJECTED_IDENTITY_COLUMN
  readonly result?: unknown
  readonly resultBound?: boolean
  readonly resultPath?: readonly RealtimePatchPathSegment[]
  readonly resultPathKey?: string
  readonly relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[]
  readonly rowIdentityIndex?: ReadonlyMap<unknown, number>
  readonly rowWindowMode?: RowWindowMode
  readonly patchPlan?: QueryPatchPlan
  readonly rowBackfillKeyPrefix?: string
  readonly scalarColumn?: string
  readonly scalarListColumn?: string
  readonly scalarListRows?: readonly Readonly<Record<string, unknown>>[]
  readonly selectionColumns?: readonly string[]
  readonly selectionResultKeys?: readonly string[]
  readonly selections?: readonly DatabaseQuerySelectionObservation[]
  readonly tableName: string
}

export type DatabaseQueryBelongsToHydrationObservation = {
  readonly foreignKey: string
  readonly ownerKey: string
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
}

export type DatabaseQueryRelatedHydrationObservation = {
  readonly foreignKey: string
  readonly kind: 'hasMany' | 'hasOne'
  readonly localKey: string
  readonly orderBy: readonly DatabaseQueryOrderObservation[]
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
}

export type DatabaseQueryPaginationObservation =
  | DatabaseQueryStandardPaginationObservation
  | DatabaseQuerySimplePaginationObservation
  | DatabaseQueryCursorPaginationObservation

export type DatabaseQueryStandardPaginationObservation = {
  readonly currentPage: number
  readonly kind: 'standard'
  readonly pageName: string
  readonly perPage: number
  readonly total: number
}

export type DatabaseQuerySimplePaginationObservation = {
  readonly currentPage: number
  readonly hasMorePages: boolean
  readonly kind: 'simple'
  readonly pageName: string
  readonly perPage: number
  readonly rowCount: number
}

export type DatabaseQueryCursorPaginationObservation = {
  readonly cursorName: string
  readonly hasMorePages: boolean
  readonly kind: 'cursor'
  readonly nextCursor: string | null
  readonly perPage: number
  readonly prevCursor: string | null
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly rowCount: number
}

export type DatabaseQueryAggregateObservation = {
  readonly column?: string
  readonly count?: number
  readonly currentValueCount?: number
  readonly kind: 'avg' | 'count' | 'max' | 'min' | 'sum'
  readonly output?: 'boolean' | 'inverseBoolean'
  readonly sum?: number
  readonly valueCounts?: readonly DatabaseQueryAggregateValueCountObservation[]
  readonly valueCountsComplete?: boolean
}

export type DatabaseQueryAggregateValueCountObservation = {
  readonly count: number
  readonly value: number
}

export type DatabaseQueryGroupedAggregateObservation = {
  readonly aggregateColumn?: string
  readonly aggregateResultKey: string
  readonly aggregateStates?: readonly DatabaseQueryGroupedAggregateStateObservation[]
  readonly averageStates?: readonly DatabaseQueryGroupedAverageStateObservation[]
  readonly groupColumn: string
  readonly groupResultKey: string
  readonly having?: DatabaseQueryGroupedAggregateHavingObservation
  readonly kind: 'avg' | 'count' | 'max' | 'min' | 'sum'
}

export type DatabaseQueryGroupedAggregateStateObservation = {
  readonly aggregateValue: number
  readonly groupValue: unknown
  readonly rowCount: number
  readonly valueCounts?: readonly DatabaseQueryGroupedAggregateValueCountObservation[]
}

export type DatabaseQueryGroupedAggregateValueCountObservation = {
  readonly count: number
  readonly value: number
}

export type DatabaseQueryGroupedAverageStateObservation = {
  readonly count: number
  readonly groupValue: unknown
  readonly rowCount: number
  readonly sum: number
}

export type DatabaseQueryGroupedAggregateHavingObservation = {
  readonly operator: '<' | '<=' | '=' | '>' | '>='
  readonly value: number
}

export type DatabaseQueryRelationObservation =
  | DatabaseQueryBelongsToManyRelationObservation
  | DatabaseQueryBelongsToParentKeyRelationObservation

export type DatabaseQueryBelongsToManyRelationObservation = {
  readonly foreignPivotKey: string
  readonly kind: 'belongsToMany'
  readonly pivotAccessor: string
  readonly pivotColumns: readonly string[]
  readonly pivotOrderBy: readonly DatabaseQueryOrderObservation[]
  readonly relatedConnectionName: string
  readonly relatedKey: string
  readonly relatedPivotKey: string
  readonly relatedTableName: string
}

export type DatabaseQueryBelongsToParentKeyRelationObservation = {
  readonly foreignKey: string
  readonly kind: 'belongsToParentKey'
  readonly ownerKey: string
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
}

export type QueryResultBinding = {
  readonly path: readonly RealtimePatchPathSegment[]
  readonly pathKey: string
  readonly value: unknown
}

export type QueryPatchTarget = {
  readonly aggregatePatchMode?: AggregatePatchMode
  readonly currentValue: unknown
  readonly index: number
  readonly mutationIndexKey: string
  readonly patchCapability: QueryPatchCapability
  readonly query: DatabaseQueryObservation
  readonly rowMutationApplier?: RowMutationApplier
  readonly rowContext?: QueryRowPatchContext
  readonly rowPatchMode?: RowPatchMode
  readonly skipsPatching: boolean
  readonly resultPath: readonly RealtimePatchPathSegment[]
  readonly resultPathKey: string
}

export type QueryPatchPlan = {
  readonly aggregatePatchMode?: AggregatePatchMode
  readonly mutationIndexKey: string
  readonly resultPath: readonly RealtimePatchPathSegment[]
  readonly resultPathKey: string
  readonly rowContext?: QueryRowPatchContext
  readonly rowMutationApplier?: RowMutationApplier
}

export type AggregatePatchMode = 'average' | 'extreme' | 'simple' | 'unpatchable'
export type QueryPatchCapability = 'patchable' | 'refresh'
export type RowPatchMode = 'offset-window' | 'pagination' | 'record' | 'rows' | 'scalar' | 'scalar-list' | 'unsupported'

export type PatchableQueryPatchTarget = QueryPatchTarget & {
  readonly patchCapability: 'patchable'
}

export type RowsQueryPatchTarget = QueryPatchTarget & {
  readonly currentValue: readonly Readonly<Record<string, unknown>>[]
  readonly rowContext: QueryRowPatchContext
  readonly rowMutationApplier: RowMutationApplier
  readonly rowPatchMode: 'offset-window' | 'rows'
}

export type RecordQueryPatchTarget = QueryPatchTarget & {
  readonly currentValue: Readonly<Record<string, unknown>> | null | undefined
  readonly rowContext: QueryRowPatchContext
  readonly rowMutationApplier: RowMutationApplier
  readonly rowPatchMode: 'record'
}

export type ScalarQueryPatchTarget = QueryPatchTarget & {
  readonly rowPatchMode: 'scalar'
}

export type ScalarListQueryPatchTarget = QueryPatchTarget & {
  readonly currentValue: readonly unknown[]
  readonly rowContext: QueryRowPatchContext
  readonly rowMutationApplier: RowMutationApplier
  readonly rowPatchMode: 'scalar-list'
}

export const EMPTY_ORDER_COLUMNS: readonly string[] = Object.freeze([])
export const EMPTY_ORDER_MULTIPLIERS: readonly number[] = Object.freeze([])
export const EMPTY_PREDICATE_COLUMNS: readonly string[] = Object.freeze([])
export const EMPTY_RECORD_ROWS: readonly Readonly<Record<string, unknown>>[] = Object.freeze([])
export const EMPTY_SELECTION_COLUMNS: readonly string[] = Object.freeze([])
export const EMPTY_SELECTION_RESULT_KEYS: readonly string[] = Object.freeze([])
export const MISSING_PROJECTED_IDENTITY = Symbol('missing projected identity')
export const PROJECTED_IDENTITY_UNDEFINED = Symbol('projected identity undefined')
export const DUPLICATE_ROW_IDENTITY = Symbol('duplicate row identity')
export const NO_PROJECTED_IDENTITY_COLUMN = Symbol('no projected identity column')
export const ROW_IDENTITY_INDEXES_BY_ROWS = new WeakMap<
  readonly Readonly<Record<string, unknown>>[],
  ReadonlyMap<unknown, number>
>()
export const ROWS_WITHOUT_UNIQUE_IDENTITY_INDEX = new WeakSet<readonly Readonly<Record<string, unknown>>[]>()

export type DatabaseQueryOrderObservation = {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export type DatabaseQuerySelectionObservation = {
  readonly column: string
  readonly resultKey: string
}

export type PatchRowsResult =
  | {
    readonly patched: false
  }
  | {
    readonly patched: true
    readonly unchanged: true
  }
  | {
    readonly patched: true
    readonly backfill?: true
    readonly rows: readonly Readonly<Record<string, unknown>>[]
  }

export type LazyRowsMutationResult = Readonly<Record<string, unknown>>[] | undefined
export type ProjectedLazyRowsMutationResult = LazyRowsMutationResult | typeof MISSING_PROJECTED_IDENTITY

export type RowsOrderState = {
  preserved: boolean
}

export type RowMutationApplier = (
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
) => PatchRowsResult

export type PatchQueryResult =
  | {
    readonly patched: false
  }
  | {
    readonly nextQuery?: DatabaseQueryObservation
    readonly patched: true
    readonly unchanged: true
  }
  | {
    readonly nextQuery?: DatabaseQueryObservation
    readonly patched: true
    readonly query: DatabaseQueryObservation
    readonly value: unknown
  }

export type PatchedQueryResult = Extract<PatchQueryResult, { readonly value: unknown }>

export type PatchedQueryDelivery = {
  readonly index: number
  readonly nextQuery?: DatabaseQueryObservation
  readonly query: DatabaseQueryObservation
  readonly value: unknown
}

export type BackfillRows = readonly Readonly<Record<string, unknown>>[]
export type BackfillQueryCache = Map<string, Promise<BackfillRows | undefined>>

export type AggregateBackfillResult = {
  readonly nextAggregate?: DatabaseQueryAggregateObservation
  readonly value: boolean | number | null
}

export type AggregateBackfillCache = Map<string, Promise<AggregateBackfillResult | undefined>>
export type AggregateSqlBackfillCache = Map<string, Promise<AggregateSqlBackfillResult | undefined>>
export type AggregateGroupedSqlBackfillCache = Map<string, Promise<ReadonlyMap<unknown, AggregateSqlBackfillResult> | undefined>>
export type GroupedAggregateValueBackfillResult = {
  readonly rowCount?: number
  readonly value: number | null
}
export type GroupedAggregateValueCountBackfillResult = {
  readonly count: number
  readonly value: number
}
export type GroupedAggregateValueBackfillCache = Map<string, Promise<ReadonlyMap<unknown, GroupedAggregateValueBackfillResult> | undefined>>
export type GroupedAggregateValueCountBackfillCache = Map<string, Promise<ReadonlyMap<unknown, readonly GroupedAggregateValueCountBackfillResult[]> | undefined>>
export type PaginationCountBackfillCache = Map<string, Promise<number | undefined>>
export type PaginationGroupedCountBackfillCache = Map<string, Promise<ReadonlyMap<unknown, number> | undefined>>
export type RowGroupedBackfillCache = Map<string, Promise<ReadonlyMap<unknown, BackfillRows> | undefined>>

export type BackfillCache<TEntry = unknown> = {
  aggregateColumnsByScope?: Map<string, readonly string[]>
  aggregateExtremeKindsByScope?: Map<string, ReadonlyMap<string, AggregateExtremeBackfillKinds>>
  readonly aggregates: AggregateBackfillCache
  readonly aggregateGroupedSql?: AggregateGroupedSqlBackfillCache
  readonly aggregateSql: AggregateSqlBackfillCache
  readonly entries: readonly TEntry[]
  readonly exactPredicates?: PredicateDependencyIndex
  readonly groupedAggregateValues?: GroupedAggregateValueBackfillCache
  readonly groupedAggregateValueCounts?: GroupedAggregateValueCountBackfillCache
  readonly mutationExactPredicates?: WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>
  readonly mutationMetadata: WeakMap<DatabaseMutationEvent, MutationPatchMetadata>
  readonly mutations: MutationIndex
  readonly paginationGroupedCounts?: PaginationGroupedCountBackfillCache
  readonly paginationCounts: PaginationCountBackfillCache
  readonly rows: BackfillQueryCache
  readonly rowGroups?: RowGroupedBackfillCache
}

export type RelevantMutationLookupCache = {
  first?: {
    readonly key: string
    readonly mutations: readonly DatabaseMutationEvent[]
  }
  mutationsByKey?: Map<string, readonly DatabaseMutationEvent[]>
}

export type RelevantMutationTarget = {
  readonly mutations: readonly DatabaseMutationEvent[]
  readonly target: QueryPatchTarget
}

export const EMPTY_RELEVANT_MUTATION_TARGETS: readonly RelevantMutationTarget[] = Object.freeze([])

export type MutationPatchMetadata = {
  readonly exactMutationId: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly hasValues: boolean
  readonly mutationPredicates: PredicateMatchContext
  readonly valueKeys: readonly string[]
}

export type AggregateRowsState = {
  candidate: number | undefined
  candidateCount: number
  count: number
  currentValueCount: number
  sum: number
  valueCounts: Map<number, number>
}

export type ScannedRowsState = {
  copiedUntil: number
  rows: Readonly<Record<string, unknown>>[]
}

export type RowOrderingAnalysis = 'invalid' | 'sorted' | 'unsorted'
export type RowWindowMode = 'invalid' | 'limited' | 'single' | 'unwindowed'

export type AggregateCountState = {
  count: number
  sum: number
}

export type AggregateSqlColumnBackfillResult = {
  readonly avg: number | null
  readonly max: number | null
  readonly maxValueCount?: number
  readonly min: number | null
  readonly minValueCount?: number
  readonly sum: number
  readonly valueCounts?: readonly DatabaseQueryAggregateValueCountObservation[]
}

export type AggregateSqlBackfillResult = {
  readonly columns: ReadonlyMap<string, AggregateSqlColumnBackfillResult>
  readonly count: number
}

export type AggregateExtremeBackfillKinds = {
  readonly max: boolean
  readonly min: boolean
}

export type RowPatchContext = {
  readonly exactMutationId: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly exactQueryId: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly hasProjectedSelections: boolean
  readonly mutationPredicates: PredicateMatchContext
  readonly orderColumns: readonly string[]
  readonly orderMultipliers: readonly number[]
  previousRowsContainExactQueryId?: boolean
  previousRowsContainExactQueryIdCached?: boolean
  readonly projectedIdentityColumn: string | typeof NO_PROJECTED_IDENTITY_COLUMN
  readonly projectedSelectionChanged: boolean
  projectedIdentityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>
  readonly queryOrderChanged: boolean
  readonly queryPredicates: PredicateMatchContext
  rowsContainExactQueryId?: boolean
  rowsContainExactQueryIdCached?: boolean
  readonly selectionColumns: readonly string[]
  readonly selectionResultKeys: readonly string[]
  readonly usesExactQueryIdAsProjectedIdentity: boolean
  readonly valueKeys: readonly string[]
}

export type QueryRowPatchContext = {
  readonly exactQueryId: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly hasProjectedSelections: boolean
  readonly orderColumns: readonly string[]
  readonly orderMultipliers: readonly number[]
  readonly projectedIdentityColumn: string | typeof NO_PROJECTED_IDENTITY_COLUMN
  readonly queryPredicates: PredicateMatchContext
  readonly selectionColumns: readonly string[]
  readonly selectionResultKeys: readonly string[]
  readonly usesExactQueryIdAsProjectedIdentity: boolean
}

export type UpdateRowPatchContext = RowPatchContext

export const EMPTY_AGGREGATE_COLUMNS_BY_SCOPE: Map<string, readonly string[]> = new Map()
export const EMPTY_AGGREGATE_COLUMNS: readonly string[] = Object.freeze([])
