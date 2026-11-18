import type { QueryPredicateNode } from './ast'
import type { CursorOrderDefinition, ValueCursor } from './pagination'

function selectionAliasOf(order: CursorOrderDefinition): { readonly selectionAlias?: true } {
  return order.selectionAlias ? { selectionAlias: true } : {}
}

function nullsTrailCursor(order: CursorOrderDefinition, previous: boolean, nullsLow: boolean): boolean {
  const nullsFirst = order.direction === 'asc' ? nullsLow : !nullsLow
  return previous ? nullsFirst : !nullsFirst
}

export function cursorIsExhausted(cursor: ValueCursor, orders: readonly CursorOrderDefinition[], nullsLow: boolean): boolean {
  const previous = cursor.previous === true
  return orders.every((order, index) => cursor.values[index] === null && nullsTrailCursor(order, previous, nullsLow))
}

export function cursorPredicate(cursor: ValueCursor, orders: readonly CursorOrderDefinition[], nullsLow: boolean): QueryPredicateNode | undefined {
  const previous = cursor.previous === true
  const branches = orders.flatMap((order, index): QueryPredicateNode[] => {
    const value = cursor.values[index]
    const nullsTrail = nullsTrailCursor(order, previous, nullsLow)
    const nullPredicate: QueryPredicateNode = { kind: 'null', column: order.column, negated: value === null, ...selectionAliasOf(order) }
    let comparison: QueryPredicateNode
    if (value === null) {
      if (nullsTrail) return []
      comparison = nullPredicate
    } else {
      comparison = { kind: 'comparison', column: order.column, operator: (order.direction === 'asc') !== previous ? '>' : '<', value, ...selectionAliasOf(order) }
      if (nullsTrail) comparison = { kind: 'group', predicates: [comparison, { ...nullPredicate, boolean: 'or' }] }
    }
    const prefix = orders.slice(0, index).map((prefixOrder, prefixIndex): QueryPredicateNode => cursor.values[prefixIndex] === null
      ? { kind: 'null', column: prefixOrder.column, negated: false, ...selectionAliasOf(prefixOrder) }
      : { kind: 'comparison', column: prefixOrder.column, operator: '=', value: cursor.values[prefixIndex], ...selectionAliasOf(prefixOrder) })
    return [{ kind: 'group', boolean: 'or', predicates: [...prefix, comparison] }]
  })
  return branches.length === 0 ? undefined : { kind: 'group', predicates: branches }
}
