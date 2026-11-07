import { assertValidIdentifierSegment, quoteIdentifierSegment } from '../schema/identifiers'
import type { Dialect } from '../core/types'
import type { QueryRawSelection } from './ast'

const trustedRawSelections = new WeakSet<QueryRawSelection>()

export function createFractionalCountSelection(column: string, alias: string): QueryRawSelection {
  assertValidIdentifierSegment(column, 'Fractional count column')
  assertValidIdentifierSegment(alias, 'Fractional count alias')
  const identifier = quoteIdentifierSegment(column, '"')
  return trustedSelection(`SUM(CASE WHEN ${identifier} <> ROUND(${identifier}) THEN 1 ELSE 0 END) AS ${quoteIdentifierSegment(alias, '"')}`)
}

export function createDateExtremaSelection(dialect: Dialect, column: string, minAlias: string, maxAlias: string): QueryRawSelection {
  assertValidIdentifierSegment(column, 'Date extrema column')
  assertValidIdentifierSegment(minAlias, 'Date extrema alias')
  assertValidIdentifierSegment(maxAlias, 'Date extrema alias')
  const quote = dialect.name === 'mysql' ? '`' : '"'
  const identifier = quoteIdentifierSegment(column, quote)
  return trustedSelection(`MIN(${identifier}) AS ${quoteIdentifierSegment(minAlias, quote)}, MAX(${identifier}) AS ${quoteIdentifierSegment(maxAlias, quote)}`)
}

function trustedSelection(sql: string): QueryRawSelection {
  const selection: QueryRawSelection = Object.freeze({
    kind: 'raw',
    sql,
    bindings: Object.freeze([]),
  })
  trustedRawSelections.add(selection)
  return selection
}

export function isTrustedRawSelection(selection: QueryRawSelection): boolean {
  return trustedRawSelections.has(selection)
}
