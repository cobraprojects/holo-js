import type { QueryPredicateNode } from './ast'
import { SecurityError } from '../core/errors'
import type { CursorOrderDefinition, ValueCursor } from './pagination'

function selectionAliasOf(order: CursorOrderDefinition): { readonly selectionAlias?: true } {
  return order.selectionAlias ? { selectionAlias: true } : {}
}

function noRowsAfter(orders: readonly CursorOrderDefinition[]): QueryPredicateNode {
  const [first] = orders
  if (!first) throw new SecurityError('Cursor pagination needs an order.')
  const isNull: QueryPredicateNode = { kind: 'null', column: first.column, negated: false, ...selectionAliasOf(first) }
  return { kind: 'group', predicates: [isNull, { ...isNull, negated: true }] }
}

export function cursorPredicate(cursor: ValueCursor, orders: readonly CursorOrderDefinition[], nullsLow: boolean): QueryPredicateNode {
  const previous = cursor.previous === true
  const branches = orders.flatMap((order, index): QueryPredicateNode[] => {
    const value = cursor.values[index]
    const nullsFirst = order.direction === 'asc' ? nullsLow : !nullsLow
    const nullPredicate: QueryPredicateNode = { kind: 'null', column: order.column, negated: value === null, ...selectionAliasOf(order) }
    let comparison: QueryPredicateNode
    if (value === null) {
      if (previous ? nullsFirst : !nullsFirst) return []
      comparison = nullPredicate
    } else {
      comparison = { kind: 'comparison', column: order.column, operator: (order.direction === 'asc') !== previous ? '>' : '<', value, ...selectionAliasOf(order) }
      if (previous ? nullsFirst : !nullsFirst) comparison = { kind: 'group', predicates: [comparison, { ...nullPredicate, boolean: 'or' }] }
    }
    const prefix = orders.slice(0, index).map((prefixOrder, prefixIndex): QueryPredicateNode => cursor.values[prefixIndex] === null
      ? { kind: 'null', column: prefixOrder.column, negated: false, ...selectionAliasOf(prefixOrder) }
      : { kind: 'comparison', column: prefixOrder.column, operator: '=', value: cursor.values[prefixIndex], ...selectionAliasOf(prefixOrder) })
    return [{ kind: 'group', boolean: 'or', predicates: [...prefix, comparison] }]
  })
  return branches.length === 0 ? noRowsAfter(orders) : { kind: 'group', predicates: branches }
}
