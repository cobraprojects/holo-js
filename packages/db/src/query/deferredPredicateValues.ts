import type { QueryJoinClause, QueryPredicateNode, QuerySelection, QueryUnionClause, SelectQueryPlan } from './ast'

type PredicateNormalization = () => Partial<QueryPredicateNode>

const normalizations = new WeakMap<QueryPredicateNode, PredicateNormalization>()

export function deferPredicateNormalization<TPredicate extends QueryPredicateNode>(predicate: TPredicate, normalize: () => Partial<TPredicate>): TPredicate {
  const deferred: TPredicate = Object.freeze({ ...predicate })
  normalizations.set(deferred, normalize as PredicateNormalization)
  return deferred
}

export function copyDeferredPredicateNormalization(from: QueryPredicateNode, to: QueryPredicateNode): void {
  const normalize = normalizations.get(from)
  if (normalize) normalizations.set(to, normalize)
}

export function remapDeferredPredicateNormalization(from: QueryPredicateNode, to: QueryPredicateNode, remap: (normalized: Partial<QueryPredicateNode>) => Partial<QueryPredicateNode>): void {
  const normalize = normalizations.get(from)
  if (normalize) normalizations.set(to, () => remap(normalize()))
}

function mapAll<T>(items: readonly T[], map: (item: T) => T): readonly T[] {
  const mapped = items.map(map)
  return mapped.every((item, index) => item === items[index]) ? items : Object.freeze(mapped)
}

function applyToPredicate(predicate: QueryPredicateNode): QueryPredicateNode {
  const normalize = normalizations.get(predicate)
  if (normalize) return Object.freeze({ ...predicate, ...normalize() }) as QueryPredicateNode
  if (predicate.kind === 'group') {
    const predicates = mapAll(predicate.predicates, applyToPredicate)
    return predicates === predicate.predicates ? predicate : Object.freeze({ ...predicate, predicates })
  }
  if (predicate.kind === 'exists' || predicate.kind === 'subquery') {
    const subquery = applyDeferredPredicateNormalizations(predicate.subquery)
    return subquery === predicate.subquery ? predicate : Object.freeze({ ...predicate, subquery })
  }
  return predicate
}

function applyToJoin(join: QueryJoinClause): QueryJoinClause {
  if (!join.subquery) return join
  const subquery = applyDeferredPredicateNormalizations(join.subquery)
  return subquery === join.subquery ? join : Object.freeze({ ...join, subquery })
}

function applyToUnion(union: QueryUnionClause): QueryUnionClause {
  const query = applyDeferredPredicateNormalizations(union.query)
  return query === union.query ? union : Object.freeze({ ...union, query })
}

function applyToSelection(selection: QuerySelection): QuerySelection {
  if (selection.kind !== 'subquery') return selection
  const query = applyDeferredPredicateNormalizations(selection.query)
  return query === selection.query ? selection : Object.freeze({ ...selection, query })
}

export function applyDeferredPredicateNormalizations(plan: SelectQueryPlan): SelectQueryPlan {
  const predicates = mapAll(plan.predicates, applyToPredicate)
  const joins = mapAll(plan.joins, applyToJoin)
  const unions = mapAll(plan.unions, applyToUnion)
  const selections = mapAll(plan.selections, applyToSelection)
  if (predicates === plan.predicates && joins === plan.joins && unions === plan.unions && selections === plan.selections) return plan
  return Object.freeze({ ...plan, predicates, joins, unions, selections })
}
