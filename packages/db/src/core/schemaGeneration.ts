let generation = 0

export function currentSchemaGeneration(): number {
  return generation
}

export function advanceSchemaGeneration(): void {
  generation += 1
}

let pending = 0
const uncertain = new WeakSet<object>()

export function beginSchemaChange(): void {
  pending += 1
  advanceSchemaGeneration()
}

export function endSchemaChange(): void {
  pending -= 1
}

export function hasPendingSchemaChanges(): boolean {
  return pending > 0
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
