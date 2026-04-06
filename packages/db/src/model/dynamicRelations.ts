import type { AnyModelDefinition, DynamicRelationResolver, RelationDefinition } from './types'

const relationRegistry = new WeakMap<AnyModelDefinition, Map<string, DynamicRelationResolver>>()

function getOrCreateRegistry(definition: AnyModelDefinition): Map<string, DynamicRelationResolver> {
  const existing = relationRegistry.get(definition)
  if (existing) {
    return existing
  }

  const created = new Map<string, DynamicRelationResolver>()
  relationRegistry.set(definition, created)
  return created
}

export function registerDynamicRelation(
  definition: AnyModelDefinition,
  name: string,
  resolver: DynamicRelationResolver,
): void {
  getOrCreateRegistry(definition).set(name, resolver)
}

export function resolveDynamicRelation(
  definition: AnyModelDefinition,
  name: string,
): RelationDefinition | undefined {
  return relationRegistry.get(definition)?.get(name)?.()
}

export function listDynamicRelationNames(
  definition: AnyModelDefinition,
): readonly string[] {
  return [...(relationRegistry.get(definition)?.keys() ?? [])]
}
