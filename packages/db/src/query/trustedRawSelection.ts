import { quoteIdentifierSegment } from '../schema/identifiers'
import type { QueryRawSelection } from './ast'

const trustedRawSelections = new WeakSet<QueryRawSelection>()

export function createFractionalCountSelection(column: string, alias: string): QueryRawSelection {
  const identifier = quoteIdentifierSegment(column, '"')
  const selection: QueryRawSelection = Object.freeze({
    kind: 'raw',
    sql: `SUM(CASE WHEN ${identifier} <> ROUND(${identifier}) THEN 1 ELSE 0 END) AS ${quoteIdentifierSegment(alias, '"')}`,
    bindings: Object.freeze([]),
  })
  trustedRawSelections.add(selection)
  return selection
}

export function isTrustedRawSelection(selection: QueryRawSelection): boolean {
  return trustedRawSelections.has(selection)
}
