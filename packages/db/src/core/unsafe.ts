import type { UnsafeStatement } from './types'

const createdStatements = new WeakSet<UnsafeStatement>()

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
  createdStatements.add(statement)
  return statement
}

export function isUnsafeSqlStatement(value: unknown): value is UnsafeStatement {
  return typeof value === 'object' && value !== null && createdStatements.has(value as UnsafeStatement)
}
