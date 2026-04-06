export interface SecurityPolicy {
  allowUnsafeRawSql: boolean
  debugSqlInLogs: boolean
  maxQueryComplexity?: number
  redactBindingsInLogs: boolean
  maxLoggedBindings: number
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  allowUnsafeRawSql: false,
  debugSqlInLogs: false,
  redactBindingsInLogs: true,
  maxLoggedBindings: 25,
}

export function createSecurityPolicy(
  overrides: Partial<SecurityPolicy> = {},
): SecurityPolicy {
  return {
    ...DEFAULT_SECURITY_POLICY,
    ...overrides,
  }
}

export function redactBindings(
  bindings: readonly unknown[],
  policy: SecurityPolicy,
): unknown[] {
  const limited = bindings.slice(0, policy.maxLoggedBindings)

  if (policy.redactBindingsInLogs) {
    return limited.map(() => '[REDACTED]')
  }

  return [...limited]
}

export function redactSql(
  sql: string,
  policy: SecurityPolicy,
): string {
  if (policy.debugSqlInLogs) {
    return sql
  }

  return '[SQL REDACTED]'
}
