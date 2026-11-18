import type { QueryPredicate, QueryPredicateNode } from './ast'
import type { CursorOrderDefinition, ValueCursor } from './pagination'

export function cursorPredicate(
  cursor: ValueCursor,
  orders: readonly CursorOrderDefinition[],
  nullsLow: boolean,
  valueTypes: readonly QueryPredicate['valueType'][] = [],
): QueryPredicateNode {
  const typed = (index: number) => valueTypes[index] ? { valueType: valueTypes[index] } : {}
  const previous = cursor.previous === true
  const branches = orders.flatMap((order, index): QueryPredicateNode[] => {
    const value = cursor.values[index]
    const nullsFirst = order.direction === 'asc' ? nullsLow : !nullsLow
    const nullPredicate: QueryPredicateNode = { kind: 'null', column: order.column, negated: value === null }
    let comparison: QueryPredicateNode
    if (value === null) {
      if (previous ? nullsFirst : !nullsFirst) return []
      comparison = nullPredicate
    } else {
      comparison = { kind: 'comparison', column: order.column, operator: (order.direction === 'asc') !== previous ? '>' : '<', value, ...typed(index) }
      if (previous ? nullsFirst : !nullsFirst) comparison = { kind: 'group', predicates: [comparison, { ...nullPredicate, boolean: 'or' }] }
    }
    const prefix = orders.slice(0, index).map((prefixOrder, prefixIndex): QueryPredicateNode => cursor.values[prefixIndex] === null
      ? { kind: 'null', column: prefixOrder.column, negated: false }
      : { kind: 'comparison', column: prefixOrder.column, operator: '=', value: cursor.values[prefixIndex], ...typed(prefixIndex) })
    return [{ kind: 'group', boolean: 'or', predicates: [...prefix, comparison] }]
  })
  return branches.length === 0 ? { kind: 'raw', sql: '1 = 0', bindings: [] } : { kind: 'group', predicates: branches }
}
