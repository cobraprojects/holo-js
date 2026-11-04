import type { UnsafeStatement } from './types'

const STATEMENT_REGISTRY_KEY = Symbol.for('holo-js.db.unsafeSqlStatements')

type UnsafeStatementRegistryHost = typeof globalThis & { [STATEMENT_REGISTRY_KEY]?: WeakSet<object> }

function unsafeStatementRegistry(): WeakSet<object> {
  const host = globalThis as UnsafeStatementRegistryHost
  host[STATEMENT_REGISTRY_KEY] ??= new WeakSet()
  return host[STATEMENT_REGISTRY_KEY]
}

export function unsafeSql(
  sql: string,
  bindings: readonly unknown[] = [],
  source?: string,
): UnsafeStatement {
  const statement: UnsafeStatement = {
    unsafe: true,
    sql,
    bindings,
    source,
  }
  unsafeStatementRegistry().add(statement)
  return statement
}

export function isUnsafeSqlStatement(value: unknown): value is UnsafeStatement {
  return typeof value === 'object' && value !== null && unsafeStatementRegistry().has(value)
}
