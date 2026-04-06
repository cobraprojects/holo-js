import type { ModelDefinitionLike } from './types'

const morphRegistry = new Map<string, ModelDefinitionLike>()

export function registerMorphModel(type: string, reference: ModelDefinitionLike): void {
  morphRegistry.set(type, reference)
}

export function resolveMorphModel(type: string): ModelDefinitionLike | undefined {
  return morphRegistry.get(type)
}

export function resolveMorphSelector(label: string): ModelDefinitionLike | undefined {
  const exact = morphRegistry.get(label)
  if (exact) {
    return exact
  }

  const normalized = label.trim().toLowerCase()
  for (const reference of morphRegistry.values()) {
    const definition = 'definition' in reference ? reference.definition : reference
    const candidates = [
      definition.morphClass,
      definition.name,
      definition.table.tableName,
    ]

    if (candidates.some(candidate => candidate.trim().toLowerCase() === normalized)) {
      return reference
    }
  }

  return undefined
}

export function listMorphModels(): readonly ModelDefinitionLike[] {
  return [...morphRegistry.values()]
}

export function resetMorphRegistry(): void {
  morphRegistry.clear()
}
