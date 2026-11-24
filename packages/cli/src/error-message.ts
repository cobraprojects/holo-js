export function errorMessage(error: unknown): string {
  return formatError(error, new Set())
}

function formatError(error: unknown, ancestors: ReadonlySet<unknown>): string {
  if (ancestors.has(error)) return '[Circular]'
  if (error instanceof AggregateError) {
    const wrappedErrors: readonly unknown[] = error.errors
    const path = new Set(ancestors).add(error)
    return [error.message, ...wrappedErrors.map(wrapped => wrappedErrorLines(wrapped, path))].join('\n')
  }

  return error instanceof Error ? error.message : String(error)
}

function wrappedErrorLines(error: unknown, ancestors: ReadonlySet<unknown>): string {
  return `  - ${formatError(error, ancestors).replaceAll('\n', '\n    ')}`
}
