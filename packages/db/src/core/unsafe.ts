import type { UnsafeStatement } from './types'

const UNSAFE_SQL_BRAND = Symbol.for('holo-js.db.unsafeSql')

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
  Object.defineProperty(statement, UNSAFE_SQL_BRAND, { value: true })
  return statement
}

export function isUnsafeSqlStatement(value: unknown): value is UnsafeStatement {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, UNSAFE_SQL_BRAND)
}
