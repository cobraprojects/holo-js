import { DatabaseError } from '../core/errors'
import type { AnyModelDefinition, ModelDefinitionLike } from './types'

function resolveDefinition(reference: ModelDefinitionLike): AnyModelDefinition {
  return 'definition' in reference ? reference.definition : reference
}

function isMissingGeneratedSchemaModelError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('is not present in the generated schema registry')
}

function tryGetDefinitionTableName(definition: AnyModelDefinition): string | undefined {
  try {
    return definition.table.tableName
  } catch (error) {
    if (isMissingGeneratedSchemaModelError(error)) {
      return undefined
    }

    throw error
  }
}

function definitionsReferToSameModel(left: AnyModelDefinition, right: AnyModelDefinition): boolean {
  if (left === right) {
    return true
  }

  const leftTableName = tryGetDefinitionTableName(left)
  const rightTableName = tryGetDefinitionTableName(right)
  if (!leftTableName || !rightTableName) {
    return left.name === right.name
      && left.primaryKey === right.primaryKey
      && left.morphClass === right.morphClass
  }

  return leftTableName === rightTableName
    && left.primaryKey === right.primaryKey
    && left.morphClass === right.morphClass
}

function getGlobalModels(): Map<string, ModelDefinitionLike> {
  const runtime = globalThis as typeof globalThis & {
    __holoDbGlobalModels__?: Map<string, ModelDefinitionLike>
  }

  runtime.__holoDbGlobalModels__ ??= new Map<string, ModelDefinitionLike>()
  return runtime.__holoDbGlobalModels__
}

export class ModelRegistry {
  private readonly models = new Map<string, AnyModelDefinition>()

  register(reference: ModelDefinitionLike): AnyModelDefinition {
    const definition = resolveDefinition(reference)
    const existing = this.models.get(definition.name)
    if (existing && !definitionsReferToSameModel(existing, definition)) {
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
  const globalModels = getGlobalModels()
  const existing = globalModels.get(definition.name)
  if (existing) {
    const existingDefinition = resolveDefinition(existing)
    if (!definitionsReferToSameModel(existingDefinition, definition)) {
      throw new DatabaseError(`Model "${definition.name}" is already registered globally.`, 'DUPLICATE_MODEL')
    }

    return existing
  }

  globalModels.set(definition.name, reference)
  return reference
}

export function getGlobalModel(name: string): ModelDefinitionLike | undefined {
  return getGlobalModels().get(name)
}

export function resetGlobalModelRegistry(): void {
  getGlobalModels().clear()
}
