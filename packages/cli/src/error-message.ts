export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const failures: readonly unknown[] = error.errors
    return [error.message, ...failures.map(failure => `  - ${errorMessage(failure).replaceAll('\n', '\n    ')}`)].join('\n')
  }

  return error instanceof Error ? error.message : String(error)
}
