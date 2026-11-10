import type { SelectQueryPlan, TableDefinition } from '@holo-js/db'
import type { DatabaseQueryPredicateObservation } from './predicate-matching'
import type { RealtimePatchPathSegment } from './result-patching'

export type RealtimeRowReader = (row: Readonly<Record<string, unknown>>, written?: boolean) => Readonly<Record<string, unknown>>

export type DatabaseQueryObservation = {
  readonly aggregate?: DatabaseQueryAggregateObservation
  readonly belongsToHydrations?: readonly DatabaseQueryBelongsToHydrationObservation[]
  readonly connectionName: string
  readonly cursorRowCount?: number
  readonly cursorRowCountKnown?: boolean
  readonly cursorRows?: readonly Readonly<Record<string, unknown>>[]
  readonly dependencies: readonly string[]
  readonly emptyRecordValue?: null
  readonly groupedAggregate?: DatabaseQueryGroupedAggregateObservation
  readonly limit?: number
  readonly offset?: number
  readonly orderBy: readonly DatabaseQueryOrderObservation[]
  readonly patchable: boolean
  readonly pagination?: DatabaseQueryPaginationObservation
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly predicateTree?: SelectQueryPlan['predicates']
  readonly primaryKey?: string
  readonly readRow?: RealtimeRowReader
  readonly relation?: DatabaseQueryRelationObservation
  readonly result?: unknown
  readonly resultBound?: boolean
  readonly serializedSources?: readonly unknown[]
  readonly observedResult?: {
    readonly list: boolean
    readonly values: readonly unknown[]
    readonly fields: readonly (Readonly<Record<string, unknown>> | undefined)[]
  }
  readonly resultPath?: readonly RealtimePatchPathSegment[]
  readonly relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[]
  readonly rowWindowMode?: RowWindowMode
  readonly scalarColumn?: string
  readonly scalarListColumn?: string
  readonly scalarListRows?: readonly Readonly<Record<string, unknown>>[]
  readonly selections?: readonly DatabaseQuerySelectionObservation[]
  readonly serialized?: boolean
  readonly tableName: string
  readonly table?: TableDefinition
}

export type DatabaseQueryBelongsToHydrationObservation = {
  readonly foreignKey: string
  readonly ownerKey: string
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
  readonly readRow?: RealtimeRowReader
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
  readonly relatedTable?: TableDefinition
}

export type DatabaseQueryRelatedHydrationObservation = {
  readonly foreignKey: string
  readonly kind: 'hasMany' | 'hasOne'
  readonly localKey: string
  readonly orderBy: readonly DatabaseQueryOrderObservation[]
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
  readonly readRow?: RealtimeRowReader
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
  readonly relatedTable?: TableDefinition
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
  readonly rowCount: number | null
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
  readonly rowCountKnown?: boolean
}

export type DatabaseQueryAggregateObservation = {
  readonly absoluteSum?: number
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
  readonly integerColumn?: true
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
  readonly relatedReadRow?: RealtimeRowReader
  readonly relatedTableName: string
  readonly relatedTable?: TableDefinition
}

export type DatabaseQueryBelongsToParentKeyRelationObservation = {
  readonly foreignKey: string
  readonly kind: 'belongsToParentKey'
  readonly ownerKey: string
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly relatedReadRow?: RealtimeRowReader
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
  readonly relatedTable?: TableDefinition
}

export type QueryResultBinding = {
  readonly value: unknown
}


export type DatabaseQueryOrderObservation = {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export type DatabaseQuerySelectionObservation = {
  readonly column: string
  readonly resultKey: string
}

export type RowWindowMode = 'invalid' | 'limited' | 'single' | 'unwindowed'
