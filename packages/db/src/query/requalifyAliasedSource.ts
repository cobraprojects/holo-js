import type { QueryJoinClause, QueryOrderBy, QueryPredicateNode, QuerySelection, SelectQueryPlan } from './ast'
import { CompilerError } from '../core/errors'
import { remapDeferredPredicateNormalization } from './deferredPredicateValues'

export type NameFolding = (name: string) => string

const ignoreCase: NameFolding = name => name.toLowerCase()

function shortName(name: string, fold: NameFolding): string {
  return fold(name.slice(name.lastIndexOf('.') + 1))
}

function schemaOf(name: string, fold: NameFolding): string | undefined {
  const separator = name.lastIndexOf('.')
  return separator < 0 ? undefined : fold(name.slice(0, separator))
}

function bindsTable(binding: string, tableName: string, fold: NameFolding = ignoreCase): boolean {
  return shortName(binding, fold) === shortName(tableName, fold)
}

export function sameTable(left: string, right: string, fold: NameFolding = ignoreCase): boolean {
  const leftSchema = schemaOf(left, fold)
  const rightSchema = schemaOf(right, fold)
  return bindsTable(left, right, fold) && (leftSchema === undefined || rightSchema === undefined || leftSchema === rightSchema)
}

interface Target {
  readonly concerns: (qualifier: string) => boolean
  readonly names: (qualifier: string) => boolean
  readonly captures: (binding: Binding, qualifier: string) => boolean
  readonly alias: string
}

const keepCase: NameFolding = name => name

function decided(fold: NameFolding | undefined, qualifier: string, check: (fold: NameFolding) => boolean): boolean {
  if (fold !== undefined) return check(fold)
  const exact = check(keepCase)
  if (exact !== check(ignoreCase)) {
    throw new CompilerError(`Cannot tell which table "${qualifier}" names in a relation filter before Holo has read how this connection folds table names. Spell the table the way the model does.`)
  }
  return exact
}

interface Binding {
  readonly name: string
  readonly aliased: boolean
}

function joinBindings(joins: readonly QueryJoinClause[]): readonly Binding[] {
  return joins.flatMap((join): Binding[] => join.alias !== undefined
    ? [{ name: join.alias, aliased: true }]
    : join.table === undefined ? [] : [{ name: join.table, aliased: false }])
}

function bindingsOf(plan: SelectQueryPlan, includeSource = true): readonly Binding[] {
  const source = plan.source.alias === undefined ? { name: plan.source.tableName, aliased: false } : { name: plan.source.alias, aliased: true }
  const joins = joinBindings(plan.joins)
  return includeSource ? [source, ...joins] : joins
}

function captures(binding: Binding, qualifier: string, fold: NameFolding): boolean {
  if (!bindsTable(binding.name, qualifier, fold)) return false
  const qualifierSchema = schemaOf(qualifier, fold)
  if (qualifierSchema === undefined) return true
  if (binding.aliased) return false
  const bindingSchema = schemaOf(binding.name, fold)
  if (bindingSchema !== undefined) return bindingSchema === qualifierSchema
  throw new CompilerError(`Cannot tell whether "${qualifier}" names the table "${binding.name}" in a relation filter, because the database decides which schema "${binding.name}" is in. Spell the table the same way in both places.`)
}

function requalifyColumn(column: string, target: Target, scope: readonly Binding[]): string {
  const pathIndex = column.indexOf('->')
  const root = pathIndex < 0 ? column : column.slice(0, pathIndex)
  const separator = root.lastIndexOf('.')
  if (separator < 0) return column

  const qualifier = root.slice(0, separator)
  if (!target.concerns(qualifier)) return column
  for (let index = scope.length - 1; index >= 0; index -= 1) {
    if (target.captures(scope[index]!, qualifier)) return column
  }
  return target.names(qualifier) ? `${target.alias}${column.slice(separator)}` : column
}

function requalifyPlan(plan: SelectQueryPlan, target: Target, enclosing: readonly Binding[]): SelectQueryPlan {
  return requalifyPlanBody(plan, target, enclosing, bindingsOf(plan))
}

export function requalifyAliasedSource(plan: SelectQueryPlan, fold: NameFolding | undefined, previousAlias?: string): SelectQueryPlan {
  const alias = plan.source.alias
  if (alias === undefined) return plan
  const tableName = plan.source.tableName
  const source: Binding = { name: tableName, aliased: false }
  const names = (qualifier: string, folding: NameFolding) => (previousAlias !== undefined && folding(qualifier) === folding(previousAlias))
    || captures(source, qualifier, folding)
  return requalifyPlanBody(plan, {
    concerns: qualifier => bindsTable(qualifier, tableName) || (previousAlias !== undefined && bindsTable(qualifier, previousAlias)),
    names: qualifier => decided(fold, qualifier, folding => names(qualifier, folding)),
    captures: (binding, qualifier) => decided(fold, qualifier, folding => captures(binding, qualifier, folding)),
    alias,
  }, [], bindingsOf(plan, false))
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
  const ownSource = own.slice(0, own.length - joinBindings(plan.joins).length)
  const onColumn = (index: number) => {
    const visible = [...enclosing, ...ownSource, ...joinBindings(plan.joins.slice(0, index + 1))]
    return (value: string) => requalifyColumn(value, target, visible)
  }
  const join = (item: QueryJoinClause, index: number): QueryJoinClause => Object.freeze({
    ...item,
    ...(item.leftColumn === undefined ? {} : { leftColumn: onColumn(index)(item.leftColumn) }),
    ...(item.rightColumn === undefined ? {} : { rightColumn: onColumn(index)(item.rightColumn) }),
    ...(item.subquery === undefined ? {} : {
      subquery: requalifyPlan(item.subquery, target, item.lateral ? [...enclosing, ...ownSource, ...joinBindings(plan.joins.slice(0, index))] : enclosing),
    }),
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
