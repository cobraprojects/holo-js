let generation = 0

export function currentSchemaGeneration(): number {
  return generation
}

export function advanceSchemaGeneration(): void {
  generation += 1
}

const pending = new Map<number, number>()
const uncertain = new WeakSet<object>()

export function beginSchemaChange(contextId: number): void {
  pending.set(contextId, (pending.get(contextId) ?? 0) + 1)
  advanceSchemaGeneration()
}

export function endSchemaChange(contextId: number): void {
  const remaining = (pending.get(contextId) ?? 0) - 1
  if (remaining > 0) pending.set(contextId, remaining)
  else pending.delete(contextId)
}

export function hasPendingSchemaChanges(contextId: number): boolean {
  return pending.has(contextId)
}

export function markSessionUncertain(owner: object): void {
  uncertain.add(owner)
}

export function isSessionUncertain(owner: object): boolean {
  return uncertain.has(owner)
}

export function resetSessionUncertainty(owner: object): void {
  uncertain.delete(owner)
}
