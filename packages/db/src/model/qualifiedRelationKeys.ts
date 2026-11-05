import { RelationError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type { AnyModelDefinition, ModelDefinitionLike, RelationDefinition } from './types'

type KeyOwner = 'parent' | 'related' | 'pivot'

const hasKeys = Object.freeze({ foreignKey: 'related', localKey: 'parent' } as const)

const keyOwnersByKind: Partial<Record<RelationDefinition['kind'], Readonly<Record<string, KeyOwner>>>> = Object.freeze({
  hasOne: hasKeys,
  hasMany: hasKeys,
  hasOneOfMany: hasKeys,
  belongsTo: Object.freeze({ foreignKey: 'parent', ownerKey: 'related' } as const),
  belongsToMany: Object.freeze({ foreignPivotKey: 'pivot', relatedPivotKey: 'pivot', parentKey: 'parent', relatedKey: 'related' } as const),
})

const normalizedRelations = new WeakMap<AnyModelDefinition, WeakMap<RelationDefinition, RelationDefinition>>()

function relatedTableName(relation: RelationDefinition): string {
  const reference = (relation as { related: () => ModelDefinitionLike }).related()
  const definition = 'definition' in reference ? reference.definition : reference
  return definition.table.tableName
}

function ownerTableName(owner: KeyOwner, parent: AnyModelDefinition, relation: RelationDefinition): string {
  if (owner === 'parent') {
    return parent.table.tableName
  }

  if (owner === 'related') {
    return relatedTableName(relation)
  }

  const pivotTable = (relation as { pivotTable: string | TableDefinition }).pivotTable
  return typeof pivotTable === 'string' ? pivotTable : pivotTable.tableName
}

function qualifierMatches(qualifier: string, tableName: string): boolean {
  return qualifier === tableName || qualifier === tableName.slice(tableName.lastIndexOf('.') + 1)
}

export function normalizeQualifiedRelationKeys(
  parent: AnyModelDefinition,
  name: string,
  relation: RelationDefinition,
): RelationDefinition {
  const owners = keyOwnersByKind[relation.kind]
  if (!owners) {
    return relation
  }

  const values = relation as unknown as Readonly<Record<string, unknown>>
  const qualifiedKeys = Object.keys(owners).filter(key => typeof values[key] === 'string' && (values[key] as string).includes('.'))
  if (qualifiedKeys.length === 0) {
    return relation
  }

  const cached = normalizedRelations.get(parent)?.get(relation)
  if (cached) {
    return cached
  }

  const overrides: Record<string, string> = {}
  for (const key of qualifiedKeys) {
    const value = values[key] as string
    const separator = value.lastIndexOf('.')
    const qualifier = value.slice(0, separator)
    const tableName = ownerTableName(owners[key]!, parent, relation)
    if (!qualifierMatches(qualifier, tableName)) {
      throw new RelationError(
        `Relation "${name}" on model "${parent.name}" qualifies its ${key} "${value}" with table "${qualifier}", but that key belongs to table "${tableName}".`,
      )
    }

    overrides[key] = value.slice(separator + 1)
  }

  const normalized = Object.freeze({ ...relation, ...overrides }) as RelationDefinition
  const byRelation = normalizedRelations.get(parent) ?? new WeakMap<RelationDefinition, RelationDefinition>()
  byRelation.set(relation, normalized)
  normalizedRelations.set(parent, byRelation)
  return normalized
}
