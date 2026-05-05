import { DatabaseError } from '../core/errors'
import type { AnyModelDefinition, ModelDefinitionLike } from './types'

function resolveDefinition(reference: ModelDefinitionLike): AnyModelDefinition {
  return 'definition' in reference ? reference.definition : reference
}

const globalModels = new Map<string, ModelDefinitionLike>()

export class ModelRegistry {
  private readonly models = new Map<string, AnyModelDefinition>()

  register(reference: ModelDefinitionLike): AnyModelDefinition {
    const definition = resolveDefinition(reference)
    const existing = this.models.get(definition.name)
    if (existing && existing !== definition) {
      throw new DatabaseError(`Model "${definition.name}" is already registered.`, 'DUPLICATE_MODEL')
    }

    this.models.set(definition.name, definition)
    return definition
  }

  has(name: string): boolean {
    return this.models.has(name)
  }

  get(name: string): AnyModelDefinition | undefined {
    return this.models.get(name)
  }

  list(): readonly AnyModelDefinition[] {
    return [...this.models.values()]
  }

  clear(): void {
    this.models.clear()
  }
}

export function createModelRegistry(): ModelRegistry {
  return new ModelRegistry()
}

export function registerGlobalModel(reference: ModelDefinitionLike): ModelDefinitionLike {
  const definition = resolveDefinition(reference)
  const existing = globalModels.get(definition.name)
  if (existing) {
    const existingDefinition = resolveDefinition(existing)
    const isSameDefinition = existingDefinition === definition
      || (
        existingDefinition.table.tableName === definition.table.tableName
        && existingDefinition.primaryKey === definition.primaryKey
        && existingDefinition.morphClass === definition.morphClass
      )

    if (!isSameDefinition) {
      throw new DatabaseError(`Model "${definition.name}" is already registered globally.`, 'DUPLICATE_MODEL')
    }

    return existing
  }

  globalModels.set(definition.name, reference)
  return reference
}

export function getGlobalModel(name: string): ModelDefinitionLike | undefined {
  return globalModels.get(name)
}
