export function throwCapabilityFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Optional capability cleanup failed.')
}

export async function releaseSessionAdapters(adapters: readonly { disconnect?(): void | Promise<void>, close?(): void | Promise<void> }[]): Promise<void> {
  const failures: unknown[] = []
  for (const adapter of [...new Set(adapters)].reverse()) {
    try {
      if (adapter.close) await adapter.close()
      else await adapter.disconnect?.()
    } catch (error) {
      failures.push(error)
    }
  }
  throwCapabilityFailures(failures)
}

export async function releaseSecurityResources(
  store: { close?(): void | Promise<void> } | undefined,
  adapter: { close?(): void | Promise<void> } | undefined,
): Promise<void> {
  const failures: unknown[] = []
  try {
    await store?.close?.()
  } catch (error) {
    failures.push(error)
  }
  try {
    if (!store?.close) await adapter?.close?.()
  } catch (error) {
    failures.push(error)
  }
  throwCapabilityFailures(failures)
}
