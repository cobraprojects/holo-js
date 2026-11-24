export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const wrappedErrors: readonly unknown[] = error.errors
    return [error.message, ...wrappedErrors.map(wrappedErrorLines)].join('\n')
  }

  return error instanceof Error ? error.message : String(error)
}

function wrappedErrorLines(error: unknown): string {
  return `  - ${errorMessage(error).replaceAll('\n', '\n    ')}`
}
