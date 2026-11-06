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

function spelledAlike(left: string, right: string): boolean {
  return bindsTable(left, right) && schemaOf(left) === schemaOf(right)
}

export function sameTable(left: string, right: string): boolean {
  const leftSchema = schemaOf(left)
  const rightSchema = schemaOf(right)
  return bindsTable(left, right) && (leftSchema === undefined || rightSchema === undefined || leftSchema === rightSchema)
}

interface Target {
  readonly names: (qualifier: string) => boolean
  readonly alias: string
}

interface Binding {
  readonly name: string
  readonly aliased: boolean
}

function bindingsOf(plan: SelectQueryPlan, includeSource = true): readonly Binding[] {
  const source = plan.source.alias === undefined ? { name: plan.source.tableName, aliased: false } : { name: plan.source.alias, aliased: true }
  const joins = plan.joins.flatMap((join): Binding[] => join.alias !== undefined
    ? [{ name: join.alias, aliased: true }]
    : join.table === undefined ? [] : [{ name: join.table, aliased: false }])
  return includeSource ? [source, ...joins] : joins
}

function captures(binding: Binding, qualifier: string): boolean {
  if (!bindsTable(binding.name, qualifier)) return false
  const qualifierSchema = schemaOf(qualifier)
  if (qualifierSchema === undefined) return true
  if (binding.aliased) return false
  const bindingSchema = schemaOf(binding.name)
  return bindingSchema === undefined || bindingSchema === qualifierSchema
}

function requalifyColumn(column: string, target: Target, scope: readonly Binding[]): string {
  const pathIndex = column.indexOf('->')
  const root = pathIndex < 0 ? column : column.slice(0, pathIndex)
  const separator = root.lastIndexOf('.')
  if (separator < 0) return column

  const qualifier = root.slice(0, separator)
  if (!target.names(qualifier) || scope.some(binding => captures(binding, qualifier))) return column
  return `${target.alias}${column.slice(separator)}`
}

function requalifyPlan(plan: SelectQueryPlan, target: Target, enclosing: readonly Binding[]): SelectQueryPlan {
  return requalifyPlanBody(plan, target, enclosing, bindingsOf(plan))
}

export function requalifyAliasedSource(plan: SelectQueryPlan, parentTableName: string, previousAlias?: string): SelectQueryPlan {
  const alias = plan.source.alias
  if (alias === undefined) return plan
  const tableName = plan.source.tableName
  const names = parentTableName === tableName ? sameTable : spelledAlike
  return requalifyPlanBody(plan, { names: qualifier => qualifier === previousAlias || names(qualifier, tableName), alias }, [], bindingsOf(plan, false))
}

function requalifyPlanBody(plan: SelectQueryPlan, target: Target, enclosing: readonly Binding[], own: readonly Binding[]): SelectQueryPlan {
  const scope = [...enclosing, ...own]
  const column = (value: string) => requalifyColumn(value, target, scope)
  const selection = (item: QuerySelection): QuerySelection => {
    switch (item.kind) {
      case 'column':
        return Object.freeze({ ...item, column: column(item.column) })
      case 'aggregate':
        return item.column === '*' ? item : Object.freeze({ ...item, column: column(item.column) })
      case 'subquery':
        return Object.freeze({ ...item, query: requalifyPlan(item.query, target, scope) })
      case 'raw':
        return item
    }
  }
  const join = (item: QueryJoinClause): QueryJoinClause => Object.freeze({
    ...item,
    ...(item.leftColumn === undefined ? {} : { leftColumn: column(item.leftColumn) }),
    ...(item.rightColumn === undefined ? {} : { rightColumn: column(item.rightColumn) }),
    ...(item.subquery === undefined ? {} : { subquery: requalifyPlan(item.subquery, target, scope) }),
  })
  const orderBy = (item: QueryOrderBy): QueryOrderBy => item.kind === 'column' || item.kind === 'vector'
    ? Object.freeze({ ...item, column: column(item.column) })
    : item

  return Object.freeze({
    ...plan,
    selections: Object.freeze(plan.selections.map(selection)),
    joins: Object.freeze(plan.joins.map(join)),
    unions: Object.freeze(plan.unions.map(union => Object.freeze({ ...union, query: requalifyPlan(union.query, target, enclosing) }))),
    predicates: requalifyPredicates(plan.predicates, target, scope),
    groupBy: Object.freeze(plan.groupBy.map(column)),
    orderBy: Object.freeze(plan.orderBy.map(orderBy)),
  })
}

function requalifyPredicates(
  predicates: readonly QueryPredicateNode[],
  target: Target,
  scope: readonly Binding[],
): readonly QueryPredicateNode[] {
  const column = (value: string) => requalifyColumn(value, target, scope)
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
        return Object.freeze({ ...predicate, column: column(predicate.column), subquery: requalifyPlan(predicate.subquery, target, scope) })
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
        return Object.freeze({ ...predicate, predicates: requalifyPredicates(predicate.predicates, target, scope) })
      case 'exists':
        return Object.freeze({ ...predicate, subquery: requalifyPlan(predicate.subquery, target, scope) })
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

export function nestedTableNames(plan: SelectQueryPlan): ReadonlySet<string> {
  return boundTableNames(plan, new Set(), false)
}

function boundTableNames(plan: SelectQueryPlan, names: Set<string>, includeSource = true): Set<string> {
  if (includeSource) names.add(plan.source.alias ?? plan.source.tableName)
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
