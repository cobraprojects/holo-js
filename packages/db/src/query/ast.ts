import type { TableDefinition } from '../schema/types'

export type QueryOperator
  = | '='
    | '!='
    | '>'
    | '>='
    | '<'
    | '<='
    | 'in'
    | 'not in'
    | 'between'
    | 'not between'
    | 'like'

export type QueryDirection = 'asc' | 'desc'
export type QueryLockMode = 'update' | 'share'
export type QueryJoinType = 'inner' | 'left' | 'right' | 'cross'

export interface QuerySource {
  readonly kind: 'table'
  readonly tableName: string
  readonly alias?: string
  readonly table?: TableDefinition
}

export interface QueryColumnSelection {
  readonly kind: 'column'
  readonly column: string
  readonly alias?: string
}

export interface QueryAggregateSelection {
  readonly kind: 'aggregate'
  readonly aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'
  readonly column: string | '*'
  readonly alias: string
}

export interface QueryRawSelection {
  readonly kind: 'raw'
  readonly sql: string
  readonly bindings: readonly unknown[]
}

export interface QuerySubquerySelection {
  readonly kind: 'subquery'
  readonly query: SelectQueryPlan
  readonly alias: string
}

export type QuerySelection
  = | QueryColumnSelection
    | QueryAggregateSelection
    | QueryRawSelection
    | QuerySubquerySelection

export interface QueryJoinClause {
  readonly type: QueryJoinType
  readonly table?: string
  readonly subquery?: SelectQueryPlan
  readonly alias?: string
  readonly lateral?: boolean
  readonly leftColumn?: string
  readonly operator?: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>
  readonly rightColumn?: string
}

export interface QueryUnionClause {
  readonly all: boolean
  readonly query: SelectQueryPlan
}

export interface QueryHavingClause {
  readonly expression: string
  readonly operator: Exclude<QueryOperator, 'in' | 'not in'>
  readonly value: unknown
}

export interface QueryPredicate {
  readonly kind: 'comparison'
  readonly boolean?: 'and' | 'or'
  readonly column: string
  readonly operator: QueryOperator
  readonly value: unknown
}

export interface QueryColumnPredicate {
  readonly kind: 'column'
  readonly boolean?: 'and' | 'or'
  readonly column: string
  readonly operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>
  readonly compareTo: string
}

export interface QueryNullPredicate {
  readonly kind: 'null'
  readonly boolean?: 'and' | 'or'
  readonly column: string
  readonly negated: boolean
}

export type QueryDatePart = 'date' | 'month' | 'day' | 'year' | 'time'

export interface QueryDatePredicate {
  readonly kind: 'date'
  readonly boolean?: 'and' | 'or'
  readonly column: string
  readonly part: QueryDatePart
  readonly operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>
  readonly value: unknown
}

export type QueryJsonMode = 'value' | 'contains' | 'length'
export type QueryFullTextMode = 'natural' | 'boolean'

export interface QueryJsonPredicate {
  readonly kind: 'json'
  readonly boolean?: 'and' | 'or'
  readonly column: string
  readonly path: readonly string[]
  readonly jsonMode: QueryJsonMode
  readonly operator?: Exclude<QueryOperator, 'in' | 'not in'>
  readonly value: unknown
}

export interface QueryFullTextPredicate {
  readonly kind: 'fulltext'
  readonly boolean?: 'and' | 'or'
  readonly columns: readonly string[]
  readonly mode: QueryFullTextMode
  readonly value: string
}

export interface QueryVectorPredicate {
  readonly kind: 'vector'
  readonly boolean?: 'and' | 'or'
  readonly column: string
  readonly vector: readonly number[]
  readonly minSimilarity: number
}

export interface QueryGroupPredicate {
  readonly kind: 'group'
  readonly boolean?: 'and' | 'or'
  readonly negated?: boolean
  readonly predicates: readonly QueryPredicateNode[]
}

export interface QueryExistsPredicate {
  readonly kind: 'exists'
  readonly boolean?: 'and' | 'or'
  readonly negated?: boolean
  readonly subquery: SelectQueryPlan
}

export interface QuerySubqueryPredicate {
  readonly kind: 'subquery'
  readonly boolean?: 'and' | 'or'
  readonly column: string
  readonly operator: Exclude<QueryOperator, 'between' | 'not between'>
  readonly subquery: SelectQueryPlan
}

export interface QueryRawPredicate {
  readonly kind: 'raw'
  readonly boolean?: 'and' | 'or'
  readonly sql: string
  readonly bindings: readonly unknown[]
}

export type QueryPredicateNode
  = | QueryPredicate
    | QueryColumnPredicate
    | QueryNullPredicate
    | QueryDatePredicate
    | QueryJsonPredicate
    | QueryFullTextPredicate
    | QueryVectorPredicate
    | QueryGroupPredicate
    | QueryExistsPredicate
    | QuerySubqueryPredicate
    | QueryRawPredicate

export type QueryOrderBy
  = | {
    readonly kind: 'column'
    readonly column: string
    readonly direction: QueryDirection
  }
  | {
    readonly kind: 'vector'
    readonly column: string
    readonly vector: readonly number[]
  }
  | {
    readonly kind: 'random'
  }
  | {
    readonly kind: 'raw'
    readonly sql: string
    readonly bindings: readonly unknown[]
  }

export interface SelectQueryPlan {
  readonly kind: 'select'
  readonly source: QuerySource
  readonly distinct: boolean
  readonly selections: readonly QuerySelection[]
  readonly joins: readonly QueryJoinClause[]
  readonly unions: readonly QueryUnionClause[]
  readonly predicates: readonly QueryPredicateNode[]
  readonly groupBy: readonly string[]
  readonly having: readonly QueryHavingClause[]
  readonly orderBy: readonly QueryOrderBy[]
  readonly lockMode?: QueryLockMode
  readonly limit?: number
  readonly offset?: number
}

export interface InsertQueryPlan {
  readonly kind: 'insert'
  readonly source: QuerySource
  readonly ignoreConflicts: boolean
  readonly values: readonly Record<string, unknown>[]
}

export interface UpsertQueryPlan {
  readonly kind: 'upsert'
  readonly source: QuerySource
  readonly values: readonly Record<string, unknown>[]
  readonly uniqueBy: readonly string[]
  readonly updateColumns: readonly string[]
}

export interface UpdateQueryPlan {
  readonly kind: 'update'
  readonly source: QuerySource
  readonly predicates: readonly QueryPredicateNode[]
  readonly values: Readonly<Record<string, QueryUpdateValue>>
}

export interface DeleteQueryPlan {
  readonly kind: 'delete'
  readonly source: QuerySource
  readonly predicates: readonly QueryPredicateNode[]
}

export type QueryPlan
  = | SelectQueryPlan
    | InsertQueryPlan
    | UpsertQueryPlan
    | UpdateQueryPlan
    | DeleteQueryPlan

export interface QueryJsonUpdateOperation {
  readonly kind: 'json-set'
  readonly path: readonly string[]
  readonly value: unknown
}

export type QueryUpdateValue
  = | unknown
    | QueryJsonUpdateOperation
    | readonly QueryJsonUpdateOperation[]

export function createTableSource(table: string | TableDefinition): QuerySource {
  if (typeof table === 'string') {
    const aliasMatch = table.trim().match(/^([A-Z_][\w.]*)(?:\s+as\s+([A-Z_]\w*))?$/i)
    return Object.freeze({
      kind: 'table',
      tableName: aliasMatch?.[1] ?? table,
      alias: aliasMatch?.[2],
    })
  }

  return Object.freeze({
    kind: 'table',
    tableName: table.tableName,
    table,
  })
}

export function createSelectQueryPlan(source: QuerySource): SelectQueryPlan {
  return Object.freeze({
    kind: 'select',
    source,
    distinct: false,
    selections: Object.freeze([]),
    joins: Object.freeze([]),
    unions: Object.freeze([]),
    predicates: Object.freeze([]),
    groupBy: Object.freeze([]),
    having: Object.freeze([]),
    orderBy: Object.freeze([]),
  })
}

export function withDistinct(plan: SelectQueryPlan, distinct = true): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    distinct,
  })
}

export function withSource(
  plan: SelectQueryPlan,
  source: QuerySource,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    source,
  })
}

export function withSelections(
  plan: SelectQueryPlan,
  columns: readonly string[],
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze(columns.map(column => createQuerySelection(column))),
  })
}

export function appendSelections(
  plan: SelectQueryPlan,
  columns: readonly string[],
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze([
      ...plan.selections,
      ...columns.map(column => createQuerySelection(column)),
    ]),
  })
}

export function appendSubquerySelection(
  plan: SelectQueryPlan,
  query: SelectQueryPlan,
  alias: string,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze([
      ...plan.selections,
      Object.freeze({
        kind: 'subquery' as const,
        query,
        alias,
      }),
    ]),
  })
}

export function withSubquerySelection(
  plan: SelectQueryPlan,
  query: SelectQueryPlan,
  alias: string,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze([Object.freeze({
      kind: 'subquery' as const,
      query,
      alias,
    })]),
  })
}

export function withAggregateSelection(
  plan: SelectQueryPlan,
  selection: QueryAggregateSelection,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze([Object.freeze(selection)]),
  })
}

export function appendAggregateSelection(
  plan: SelectQueryPlan,
  selection: QueryAggregateSelection,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze([
      ...plan.selections,
      Object.freeze(selection),
    ]),
  })
}

export function withRawSelection(
  plan: SelectQueryPlan,
  selection: QueryRawSelection,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze([Object.freeze(selection)]),
  })
}

export function appendRawSelection(
  plan: SelectQueryPlan,
  selection: QueryRawSelection,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    selections: Object.freeze([
      ...plan.selections,
      Object.freeze(selection),
    ]),
  })
}

function createQuerySelection(column: string): QuerySelection {
  const aliasSeparatorIndex = column.toLowerCase().lastIndexOf(' as ')
  if (aliasSeparatorIndex > 0) {
    const selectedColumn = column.slice(0, aliasSeparatorIndex).trim()
    const alias = column.slice(aliasSeparatorIndex + 4).trim()
    if (/^[A-Z_]\w*$/i.test(alias) && selectedColumn.length > 0) {
      return Object.freeze({
        kind: 'column' as const,
        column: selectedColumn,
        alias,
      })
    }
  }

  return Object.freeze({
    kind: 'column' as const,
    column,
  })
}

export function withPredicate(
  plan: SelectQueryPlan,
  predicate: QueryPredicateNode,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    predicates: Object.freeze([...plan.predicates, Object.freeze(predicate)]),
  })
}

export function withJoin(
  plan: SelectQueryPlan,
  join: QueryJoinClause,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    joins: Object.freeze([...plan.joins, Object.freeze(join)]),
  })
}

export function withUnion(
  plan: SelectQueryPlan,
  union: QueryUnionClause,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    unions: Object.freeze([...plan.unions, Object.freeze(union)]),
  })
}

export function withoutPredicates(
  plan: SelectQueryPlan,
  matcher: (predicate: QueryPredicateNode) => boolean,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    predicates: Object.freeze(plan.predicates.filter(predicate => !matcher(predicate))),
  })
}

export function withOrderBy(
  plan: SelectQueryPlan,
  orderBy: QueryOrderBy,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    orderBy: Object.freeze([...plan.orderBy, Object.freeze(orderBy)]),
  })
}

export function withGroupBy(
  plan: SelectQueryPlan,
  columns: readonly string[],
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    groupBy: Object.freeze([...plan.groupBy, ...columns]),
  })
}

export function withLockMode(
  plan: SelectQueryPlan,
  lockMode?: QueryLockMode,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    lockMode,
  })
}

export function withHaving(
  plan: SelectQueryPlan,
  clause: QueryHavingClause,
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    having: Object.freeze([...plan.having, Object.freeze(clause)]),
  })
}

export function replaceOrderBy(
  plan: SelectQueryPlan,
  orderBy: readonly QueryOrderBy[],
): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    orderBy: Object.freeze(orderBy.map(entry => Object.freeze(entry))),
  })
}

export function withLimit(plan: SelectQueryPlan, limit?: number): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    limit,
  })
}

export function withOffset(plan: SelectQueryPlan, offset?: number): SelectQueryPlan {
  return Object.freeze({
    ...plan,
    offset,
  })
}

export function createInsertQueryPlan(
  source: QuerySource,
  values: readonly Record<string, unknown>[],
  options: { ignoreConflicts?: boolean } = {},
): InsertQueryPlan {
  return Object.freeze({
    kind: 'insert',
    source,
    ignoreConflicts: options.ignoreConflicts ?? false,
    values: Object.freeze(values.map(value => Object.freeze({ ...value }))),
  })
}

export function createUpsertQueryPlan(
  source: QuerySource,
  values: readonly Record<string, unknown>[],
  uniqueBy: readonly string[],
  updateColumns: readonly string[],
): UpsertQueryPlan {
  return Object.freeze({
    kind: 'upsert',
    source,
    values: Object.freeze(values.map(value => Object.freeze({ ...value }))),
    uniqueBy: Object.freeze([...uniqueBy]),
    updateColumns: Object.freeze([...updateColumns]),
  })
}

export function createUpdateQueryPlan(
  source: QuerySource,
  predicates: readonly QueryPredicateNode[],
  values: Readonly<Record<string, unknown>>,
): UpdateQueryPlan {
  return Object.freeze({
    kind: 'update',
    source,
    predicates: Object.freeze([...predicates]),
    values: Object.freeze({ ...values }),
  })
}

export function createDeleteQueryPlan(
  source: QuerySource,
  predicates: readonly QueryPredicateNode[],
): DeleteQueryPlan {
  return Object.freeze({
    kind: 'delete',
    source,
    predicates: Object.freeze([...predicates]),
  })
}
