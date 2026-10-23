const genuineContexts = new WeakSet<object>()

export function markGenuineDatabaseContext(context: object): void {
  genuineContexts.add(context)
}

export function isGenuineDatabaseContext(value: unknown): boolean {
  return typeof value === 'object' && value !== null && genuineContexts.has(value)
}
