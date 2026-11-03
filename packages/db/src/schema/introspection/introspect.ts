import type { DatabaseContext } from '../../core/DatabaseContext'
import type { DriverQueryResult } from '../../core/types'

export type Introspect = <TRow extends Record<string, unknown>>(
  sql: string,
  bindings: readonly unknown[],
  source: string,
) => Promise<DriverQueryResult<TRow>>

export function createIntrospect(connection: DatabaseContext): Introspect {
  return (sql, bindings, source) => connection.introspectCompiled({ sql, bindings, source })
}
