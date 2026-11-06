import type { QueryJoinClause, QueryOrderBy, QueryPredicateNode, QuerySelection, SelectQueryPlan } from './ast'
import { remapDeferredPredicateNormalization } from './deferredPredicateValues'

function shortName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

function schemaOf(name: string): string | undefined {
  const separator = name.lastIndexOf('.')
  return separator < 0 ? undefined : name.slice(0, separator)
}

function bindsTable(binding: string, tableName: string): boolean {
  return shortName(binding) === shortName(tableName)
}

export function sameTable(left: string, right: string): boolean {
  const leftSchema = schemaOf(left)
  const rightSchema = schemaOf(right)
  return bindsTable(left, right) && (leftSchema === undefined || rightSchema === undefined || leftSchema === rightSchema)
}

function requalifyColumn(column: string, tableName: string, alias: string): string {
  const pathIndex = column.indexOf('->')
  const root = pathIndex < 0 ? column : column.slice(0, pathIndex)
  const separator = root.lastIndexOf('.')
  if (separator < 0) return column

  return sameTable(root.slice(0, separator), tableName) ? `${alias}${column.slice(separator)}` : column
}

function joinsShadowTable(plan: SelectQueryPlan, tableName: string): boolean {
  return plan.joins.some((join) => {
    const binding = join.alias ?? join.table
    return binding !== undefined && bindsTable(binding, tableName)
  })
}

function shadowsTable(plan: SelectQueryPlan, tableName: string): boolean {
  return bindsTable(plan.source.alias ?? plan.source.tableName, tableName) || joinsShadowTable(plan, tableName)
}

function requalifyPlan(plan: SelectQueryPlan, tableName: string, alias: string): SelectQueryPlan {
  return shadowsTable(plan, tableName) ? plan : requalifyPlanBody(plan, tableName, alias)
}

export function requalifyAliasedSource(plan: SelectQueryPlan): SelectQueryPlan {
  const alias = plan.source.alias
  if (alias === undefined || joinsShadowTable(plan, plan.source.tableName)) return plan
  return requalifyPlanBody(plan, plan.source.tableName, alias)
}

function requalifyPlanBody(plan: SelectQueryPlan, tableName: string, alias: string): SelectQueryPlan {
  const column = (value: string) => requalifyColumn(value, tableName, alias)
  const selection = (item: QuerySelection): QuerySelection => {
    switch (item.kind) {
      case 'column':
        return Object.freeze({ ...item, column: column(item.column) })
      case 'aggregate':
        return item.column === '*' ? item : Object.freeze({ ...item, column: column(item.column) })
      case 'subquery':
        return Object.freeze({ ...item, query: requalifyPlan(item.query, tableName, alias) })
      case 'raw':
        return item
    }
  }
  const join = (item: QueryJoinClause): QueryJoinClause => Object.freeze({
    ...item,
    ...(item.leftColumn === undefined ? {} : { leftColumn: column(item.leftColumn) }),
    ...(item.rightColumn === undefined ? {} : { rightColumn: column(item.rightColumn) }),
    ...(item.subquery === undefined ? {} : { subquery: requalifyPlan(item.subquery, tableName, alias) }),
  })
  const orderBy = (item: QueryOrderBy): QueryOrderBy => item.kind === 'column' || item.kind === 'vector'
    ? Object.freeze({ ...item, column: column(item.column) })
    : item

  return Object.freeze({
    ...plan,
    selections: Object.freeze(plan.selections.map(selection)),
    joins: Object.freeze(plan.joins.map(join)),
    unions: Object.freeze(plan.unions.map(union => Object.freeze({ ...union, query: requalifyPlan(union.query, tableName, alias) }))),
    predicates: requalifyPredicates(plan.predicates, tableName, alias),
    groupBy: Object.freeze(plan.groupBy.map(column)),
    orderBy: Object.freeze(plan.orderBy.map(orderBy)),
  })
}

function requalifyPredicates(
  predicates: readonly QueryPredicateNode[],
  tableName: string,
  alias: string,
): readonly QueryPredicateNode[] {
  const column = (value: string) => requalifyColumn(value, tableName, alias)
  const remap = (normalized: Partial<QueryPredicateNode>): Partial<QueryPredicateNode> => ({
    ...normalized,
    ...('column' in normalized && typeof normalized.column === 'string' ? { column: column(normalized.column) } : {}),
    ...('compareTo' in normalized && typeof normalized.compareTo === 'string' ? { compareTo: column(normalized.compareTo) } : {}),
  })
  const rewrite = (predicate: QueryPredicateNode): QueryPredicateNode => {
    switch (predicate.kind) {
      case 'comparison':
      case 'null':
      case 'like':
      case 'date':
      case 'json':
      case 'vector':
      case 'integer-in':
        return Object.freeze({ ...predicate, column: column(predicate.column) })
      case 'subquery':
        return Object.freeze({ ...predicate, column: column(predicate.column), subquery: requalifyPlan(predicate.subquery, tableName, alias) })
      case 'column':
        return Object.freeze({ ...predicate, column: column(predicate.column), compareTo: column(predicate.compareTo) })
      case 'between-columns':
        return Object.freeze({
          ...predicate,
          subject: 'column' in predicate.subject ? Object.freeze({ column: column(predicate.subject.column) }) : predicate.subject,
          bounds: Object.freeze([column(predicate.bounds[0]), column(predicate.bounds[1])]) as readonly [string, string],
        })
      case 'fulltext':
        return Object.freeze({ ...predicate, columns: Object.freeze(predicate.columns.map(column)) })
      case 'group':
        return Object.freeze({ ...predicate, predicates: requalifyPredicates(predicate.predicates, tableName, alias) })
      case 'exists':
        return Object.freeze({ ...predicate, subquery: requalifyPlan(predicate.subquery, tableName, alias) })
      case 'raw':
        return predicate
    }
  }

  return Object.freeze(predicates.map((predicate) => {
    const rewritten = rewrite(predicate)
    if (rewritten !== predicate) remapDeferredPredicateNormalization(predicate, rewritten, remap)
    return rewritten
  }))
}

export function boundTableNames(plan: SelectQueryPlan, names: Set<string> = new Set()): ReadonlySet<string> {
  names.add(plan.source.alias ?? plan.source.tableName)
  for (const join of plan.joins) {
    const binding = join.alias ?? join.table
    if (binding !== undefined) names.add(binding)
    if (join.subquery) boundTableNames(join.subquery, names)
  }
  for (const selection of plan.selections) {
    if (selection.kind === 'subquery') boundTableNames(selection.query, names)
  }
  for (const union of plan.unions) boundTableNames(union.query, names)
  const visit = (predicates: readonly QueryPredicateNode[]): void => {
    for (const predicate of predicates) {
      if (predicate.kind === 'group') visit(predicate.predicates)
      if (predicate.kind === 'exists' || predicate.kind === 'subquery') boundTableNames(predicate.subquery, names)
    }
  }
  visit(plan.predicates)
  return names
}
