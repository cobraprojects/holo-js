import { RelationError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type { AnyModelDefinition, ModelDefinitionLike, RelationDefinition } from './types'

type KeyOwner = 'parent' | 'related' | 'pivot' | 'through'

type KeyOwners = { readonly [TKind in RelationDefinition['kind']]: Readonly<Partial<Record<keyof Extract<RelationDefinition, { kind: TKind }>, KeyOwner>>> }

const hasKeys = Object.freeze({ foreignKey: 'related', localKey: 'parent' } as const)
const ofManyKeys = Object.freeze({ ...hasKeys, aggregateColumn: 'related' } as const)
const morphHasKeys = Object.freeze({ morphTypeColumn: 'related', morphIdColumn: 'related', localKey: 'parent' } as const)
const morphOfManyKeys = Object.freeze({ ...morphHasKeys, aggregateColumn: 'related' } as const)
const morphPivotKeys = Object.freeze({ morphTypeColumn: 'pivot', morphIdColumn: 'pivot', foreignPivotKey: 'pivot', parentKey: 'parent', relatedKey: 'related' } as const)
const throughKeys = Object.freeze({ firstKey: 'through', secondKey: 'related', localKey: 'parent', secondLocalKey: 'through' } as const)

const keyOwnersByKind: KeyOwners = Object.freeze({
  belongsTo: Object.freeze({ foreignKey: 'parent', ownerKey: 'related' } as const),
  hasOne: hasKeys,
  hasMany: hasKeys,
  hasOneOfMany: ofManyKeys,
  morphOne: morphHasKeys,
  morphMany: morphHasKeys,
  morphOneOfMany: morphOfManyKeys,
  morphTo: Object.freeze({ morphTypeColumn: 'parent', morphIdColumn: 'parent' } as const),
  belongsToMany: Object.freeze({ foreignPivotKey: 'pivot', relatedPivotKey: 'pivot', parentKey: 'parent', relatedKey: 'related' } as const),
  morphToMany: morphPivotKeys,
  morphedByMany: morphPivotKeys,
  hasOneThrough: throughKeys,
  hasManyThrough: throughKeys,
})

const normalizedRelations = new WeakMap<AnyModelDefinition, WeakMap<RelationDefinition, RelationDefinition>>()

function tableOf(resolve: () => ModelDefinitionLike): string {
  const reference = resolve()
  const definition = 'definition' in reference ? reference.definition : reference
  return definition.table.tableName
}

function ownerTableName(owner: KeyOwner, parent: AnyModelDefinition, relation: RelationDefinition): string {
  if (owner === 'parent') {
    return parent.table.tableName
  }

  if (owner === 'related') {
    return tableOf((relation as { related: () => ModelDefinitionLike }).related)
  }

  if (owner === 'through') {
    return tableOf((relation as { through: () => ModelDefinitionLike }).through)
  }

  const pivotTable = (relation as { pivotTable: string | TableDefinition }).pivotTable
  return typeof pivotTable === 'string' ? pivotTable : pivotTable.tableName
}

function bareName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

function qualifierMatches(qualifier: string, tableName: string): boolean {
  if (qualifier === tableName) {
    return true
  }

  return bareName(qualifier) === bareName(tableName) && (!qualifier.includes('.') || !tableName.includes('.'))
}

export function normalizeQualifiedRelationKeys(
  parent: AnyModelDefinition,
  name: string,
  relation: RelationDefinition,
): RelationDefinition {
  const owners: Readonly<Record<string, KeyOwner>> = keyOwnersByKind[relation.kind]
  const values = relation as unknown as Readonly<Record<string, unknown>>
  const qualifiedKeys = Object.keys(owners).filter((key) => {
    const value = values[key]
    return typeof value === 'string' && value.includes('.')
  })
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
