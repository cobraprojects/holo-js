function getErrorCode(error: unknown): string | number | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { readonly code?: string | number }).code
    : undefined
}

function getErrorCause(error: unknown): unknown {
  return error && typeof error === 'object' && 'cause' in error
    ? (error as { readonly cause?: unknown }).cause
    : undefined
}

export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error
  while (current) {
    const code = getErrorCode(current)
    if (code === '23505'
      || code === 1062
      || code === '1062'
      || code === 'ER_DUP_ENTRY'
      || code === 'SQLITE_CONSTRAINT'
      || code === 'SQLITE_CONSTRAINT_UNIQUE'
      || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
    if (current instanceof Error && /unique constraint|duplicate entry|unique constraint failed/i.test(current.message)) return true
    current = getErrorCause(current)
  }
  return false
}
