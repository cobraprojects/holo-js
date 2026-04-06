import type { UnsafeStatement } from './types'

export function unsafeSql(
  sql: string,
  bindings: readonly unknown[] = [],
  source?: string,
): UnsafeStatement {
  return {
    unsafe: true,
    sql,
    bindings,
    source,
  }
}
