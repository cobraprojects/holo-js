import { DatabaseError } from '../core/errors'
import type { AnyModelDefinition, ModelDefinitionLike } from './types'

function resolveDefinition(reference: ModelDefinitionLike): AnyModelDefinition {
  return 'definition' in reference ? reference.definition : reference
}

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
