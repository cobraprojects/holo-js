let generation = 0

export function currentSchemaGeneration(): number {
  return generation
}

export function advanceSchemaGeneration(): void {
  generation += 1
}
