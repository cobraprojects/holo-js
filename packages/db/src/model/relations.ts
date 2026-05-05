import type {
  BelongsToManyRelationDefinition,
  BelongsToRelationDefinition,
  HasManyRelationDefinition,
  HasManyThroughRelationDefinition,
  HasOneOfManyRelationDefinition,
  HasOneRelationDefinition,
  HasOneThroughRelationDefinition,
  ModelDefinitionLike,
  MorphManyRelationDefinition,
  MorphOneOfManyRelationDefinition,
  MorphOneRelationDefinition,
  MorphToRelationDefinition,
  MorphedByManyRelationDefinition,
  MorphToManyRelationDefinition,
  PivotTableColumnName,
  PivotRelationMethods,
  RegisteredModelName,
  RegisteredModelReference,
  RelationConstraintDefinition,
  RelationDefinition,
} from './types'
import { getGlobalModel } from './ModelRegistry'
import { RelationError } from '../core/errors'
import type { TableDefinition } from '../schema/types'

type PivotMethodKeys = 'withPivot' | 'wherePivot' | 'orderByPivot' | 'as' | 'using'
type BareBelongsToManyRelation = Omit<BelongsToManyRelationDefinition, PivotMethodKeys>
type BareMorphToManyRelation = Omit<MorphToManyRelationDefinition, PivotMethodKeys>
type BareMorphedByManyRelation = Omit<MorphedByManyRelationDefinition, PivotMethodKeys>
type RelatedInput<TRelated extends ModelDefinitionLike<TableDefinition>> = RegisteredModelName | (() => TRelated)

function defaultMorphTypeColumn(name: string): string {
  return `${name}_type`
}

function defaultMorphIdColumn(name: string): string {
  return `${name}_id`
}

function resolveRegisteredModel(name: string): ModelDefinitionLike {
  const model = getGlobalModel(name)
  if (!model) {
    throw new RelationError(
      `Relation target "${name}" is not registered. Import the related model once during boot or use your framework's model discovery.`,
    )
  }

  return model
}

function normalizeRelatedResolver(related: RegisteredModelName | (() => ModelDefinitionLike<TableDefinition>)): () => ModelDefinitionLike<TableDefinition> {
  if (typeof related === 'string') {
    return () => resolveRegisteredModel(related)
  }

  return related
}

function decoratePivotRelation<TBase extends {
  pivotColumns: readonly string[]
  pivotWheres: readonly { column: string, operator: string, value: unknown }[]
  pivotOrderBy: readonly { column: string, direction: 'asc' | 'desc' }[]
  pivotAccessor: string
  pivotModel?: () => ModelDefinitionLike
}, TResult extends TBase & PivotRelationMethods<TResult, TPivotTable>, TPivotTable extends string | TableDefinition = string | TableDefinition>(
  relation: TBase,
): TResult {
  const clone = (
    overrides: Partial<TBase>,
  ): TResult => {
    return decoratePivotRelation(Object.freeze({
      ...relation,
      ...overrides,
    }) as TBase)
  }

  return Object.freeze({
    ...relation,
    withPivot(...columns: readonly PivotTableColumnName<TPivotTable>[]) {
      return clone({
        pivotColumns: Object.freeze([...new Set([...relation.pivotColumns, ...columns])]),
      } as Partial<TBase>)
    },
    wherePivot(column: PivotTableColumnName<TPivotTable>, operator: unknown, value?: unknown) {
      const normalizedOperator = typeof value === 'undefined' ? '=' : String(operator)
      const normalizedValue = typeof value === 'undefined' ? operator : value
      return clone({
        pivotWheres: Object.freeze([
          ...relation.pivotWheres,
          Object.freeze({
            column,
            operator: normalizedOperator,
            value: normalizedValue,
          }),
        ]),
      } as Partial<TBase>)
    },
    orderByPivot(column: PivotTableColumnName<TPivotTable>, direction: 'asc' | 'desc' = 'asc') {
      return clone({
        pivotOrderBy: Object.freeze([
          ...relation.pivotOrderBy,
          Object.freeze({
            column,
            direction,
          }),
        ]),
      } as Partial<TBase>)
    },
    as(accessor: string) {
      return clone({
        pivotAccessor: accessor,
      } as Partial<TBase>)
    },
    using(model: () => ModelDefinitionLike) {
      return clone({
        pivotModel: model,
      } as Partial<TBase>)
    },
  }) as unknown as TResult
}

export function belongsTo<const TName extends RegisteredModelName>(
  related: TName,
  foreignKeyOrOptions: string | { foreignKey: string, ownerKey?: string },
  ownerKey?: string,
): BelongsToRelationDefinition<RegisteredModelReference<TName>>
export function belongsTo<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  foreignKeyOrOptions: string | { foreignKey: string, ownerKey?: string },
  ownerKey?: string,
): BelongsToRelationDefinition<TRelated>
export function belongsTo(
  related: RelatedInput<ModelDefinitionLike<TableDefinition>>,
  foreignKeyOrOptions: string | { foreignKey: string, ownerKey?: string },
  ownerKey = 'id',
): BelongsToRelationDefinition<ModelDefinitionLike<TableDefinition>> {
  const foreignKey = typeof foreignKeyOrOptions === 'string'
    ? foreignKeyOrOptions
    : foreignKeyOrOptions.foreignKey
  const resolvedOwnerKey = typeof foreignKeyOrOptions === 'string'
    ? ownerKey
    : (foreignKeyOrOptions.ownerKey ?? 'id')

  return Object.freeze({
    kind: 'belongsTo',
    related: normalizeRelatedResolver(related),
    foreignKey,
    ownerKey: resolvedOwnerKey,
  })
}

export function hasMany<const TName extends RegisteredModelName>(
  related: TName,
  foreignKeyOrOptions: string | { foreignKey: string, localKey?: string },
  localKey?: string,
): HasManyRelationDefinition<RegisteredModelReference<TName>>
export function hasMany<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  foreignKeyOrOptions: string | { foreignKey: string, localKey?: string },
  localKey?: string,
): HasManyRelationDefinition<TRelated>
export function hasMany(
  related: RelatedInput<ModelDefinitionLike<TableDefinition>>,
  foreignKeyOrOptions: string | { foreignKey: string, localKey?: string },
  localKey = 'id',
): HasManyRelationDefinition<ModelDefinitionLike<TableDefinition>> {
  const foreignKey = typeof foreignKeyOrOptions === 'string'
    ? foreignKeyOrOptions
    : foreignKeyOrOptions.foreignKey
  const resolvedLocalKey = typeof foreignKeyOrOptions === 'string'
    ? localKey
    : (foreignKeyOrOptions.localKey ?? 'id')

  return Object.freeze({
    kind: 'hasMany',
    related: normalizeRelatedResolver(related),
    foreignKey,
    localKey: resolvedLocalKey,
  })
}

export function hasOne<const TName extends RegisteredModelName>(
  related: TName,
  foreignKeyOrOptions: string | { foreignKey: string, localKey?: string },
  localKey?: string,
): HasOneRelationDefinition<RegisteredModelReference<TName>>
export function hasOne<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  foreignKeyOrOptions: string | { foreignKey: string, localKey?: string },
  localKey?: string,
): HasOneRelationDefinition<TRelated>
export function hasOne(
  related: RelatedInput<ModelDefinitionLike<TableDefinition>>,
  foreignKeyOrOptions: string | { foreignKey: string, localKey?: string },
  localKey = 'id',
): HasOneRelationDefinition<ModelDefinitionLike<TableDefinition>> {
  const foreignKey = typeof foreignKeyOrOptions === 'string'
    ? foreignKeyOrOptions
    : foreignKeyOrOptions.foreignKey
  const resolvedLocalKey = typeof foreignKeyOrOptions === 'string'
    ? localKey
    : (foreignKeyOrOptions.localKey ?? 'id')

  return Object.freeze({
    kind: 'hasOne',
    related: normalizeRelatedResolver(related),
    foreignKey,
    localKey: resolvedLocalKey,
  })
}

export function morphOne<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  name: string,
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
  localKey = 'id',
): MorphOneRelationDefinition<TRelated> {
  return Object.freeze({
    kind: 'morphOne',
    related,
    morphName: name,
    morphTypeColumn: type,
    morphIdColumn: id,
    localKey,
  })
}

export function morphMany<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  name: string,
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
  localKey = 'id',
): MorphManyRelationDefinition<TRelated> {
  return Object.freeze({
    kind: 'morphMany',
    related,
    morphName: name,
    morphTypeColumn: type,
    morphIdColumn: id,
    localKey,
  })
}

export function morphOfMany<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  name: string,
  aggregateColumn: string,
  aggregate: 'min' | 'max' = 'max',
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
  localKey = 'id',
): MorphOneOfManyRelationDefinition<TRelated> {
  return Object.freeze({
    kind: 'morphOneOfMany',
    related,
    morphName: name,
    morphTypeColumn: type,
    morphIdColumn: id,
    localKey,
    aggregateColumn,
    aggregate,
  })
}

export function latestMorphOne<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  name: string,
  column = 'id',
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
  localKey = 'id',
): MorphOneOfManyRelationDefinition<TRelated> {
  return morphOfMany(related, name, column, 'max', type, id, localKey)
}

export function oldestMorphOne<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  name: string,
  column = 'id',
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
  localKey = 'id',
): MorphOneOfManyRelationDefinition<TRelated> {
  return morphOfMany(related, name, column, 'min', type, id, localKey)
}

export function morphTo(
  name: string,
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
): MorphToRelationDefinition {
  return Object.freeze({
    kind: 'morphTo',
    morphName: name,
    morphTypeColumn: type,
    morphIdColumn: id,
  })
}

export function ofMany<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  foreignKey: string,
  aggregateColumn: string,
  aggregate: 'min' | 'max' = 'max',
  localKey = 'id',
): HasOneOfManyRelationDefinition<TRelated> {
  return Object.freeze({
    kind: 'hasOneOfMany',
    related,
    foreignKey,
    localKey,
    aggregateColumn,
    aggregate,
  })
}

export function latestOfMany<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  foreignKey: string,
  localKey = 'id',
  column = 'id',
): HasOneOfManyRelationDefinition<TRelated> {
  return ofMany(related, foreignKey, column, 'max', localKey)
}

export function oldestOfMany<TRelated extends ModelDefinitionLike<TableDefinition>>(
  related: () => TRelated,
  foreignKey: string,
  localKey = 'id',
  column = 'id',
): HasOneOfManyRelationDefinition<TRelated> {
  return ofMany(related, foreignKey, column, 'min', localKey)
}

export function belongsToMany<
  const TName extends RegisteredModelName,
  TPivotTable extends string | TableDefinition,
>(
  related: TName,
  pivotTableOrOptions: TPivotTable | {
    pivotTable: TPivotTable
    foreignPivotKey: string
    relatedPivotKey: string
    parentKey?: string
    relatedKey?: string
  },
  foreignPivotKey?: string,
  relatedPivotKey?: string,
  parentKey?: string,
  relatedKey?: string,
): BelongsToManyRelationDefinition<RegisteredModelReference<TName>, TPivotTable> & PivotRelationMethods<BelongsToManyRelationDefinition<RegisteredModelReference<TName>, TPivotTable>, TPivotTable>
export function belongsToMany<
  TRelated extends ModelDefinitionLike<TableDefinition>,
  TPivotTable extends string | TableDefinition,
>(
  related: () => TRelated,
  pivotTableOrOptions: TPivotTable | {
    pivotTable: TPivotTable
    foreignPivotKey: string
    relatedPivotKey: string
    parentKey?: string
    relatedKey?: string
  },
  foreignPivotKey?: string,
  relatedPivotKey?: string,
  parentKey?: string,
  relatedKey?: string,
): BelongsToManyRelationDefinition<TRelated, TPivotTable> & PivotRelationMethods<BelongsToManyRelationDefinition<TRelated, TPivotTable>, TPivotTable>
export function belongsToMany<TPivotTable extends string | TableDefinition>(
  related: RelatedInput<ModelDefinitionLike<TableDefinition>>,
  pivotTableOrOptions: TPivotTable | {
    pivotTable: TPivotTable
    foreignPivotKey: string
    relatedPivotKey: string
    parentKey?: string
    relatedKey?: string
  },
  foreignPivotKey?: string,
  relatedPivotKey?: string,
  parentKey = 'id',
  relatedKey = 'id',
): BelongsToManyRelationDefinition<ModelDefinitionLike<TableDefinition>, TPivotTable> & PivotRelationMethods<BelongsToManyRelationDefinition<ModelDefinitionLike<TableDefinition>, TPivotTable>, TPivotTable> {
  const pivotTable = typeof pivotTableOrOptions === 'object' && 'pivotTable' in pivotTableOrOptions
    ? pivotTableOrOptions.pivotTable
    : pivotTableOrOptions
  const resolvedForeignPivotKey = typeof pivotTableOrOptions === 'object' && 'pivotTable' in pivotTableOrOptions
    ? pivotTableOrOptions.foreignPivotKey
    : foreignPivotKey!
  const resolvedRelatedPivotKey = typeof pivotTableOrOptions === 'object' && 'pivotTable' in pivotTableOrOptions
    ? pivotTableOrOptions.relatedPivotKey
    : relatedPivotKey!
  const resolvedParentKey = typeof pivotTableOrOptions === 'object' && 'pivotTable' in pivotTableOrOptions
    ? (pivotTableOrOptions.parentKey ?? 'id')
    : parentKey
  const resolvedRelatedKey = typeof pivotTableOrOptions === 'object' && 'pivotTable' in pivotTableOrOptions
    ? (pivotTableOrOptions.relatedKey ?? 'id')
    : relatedKey

  return decoratePivotRelation<
    BareBelongsToManyRelation,
    BelongsToManyRelationDefinition<ModelDefinitionLike<TableDefinition>, TPivotTable>,
    TPivotTable
  >(Object.freeze({
    kind: 'belongsToMany',
    related: normalizeRelatedResolver(related),
    pivotTable,
    foreignPivotKey: resolvedForeignPivotKey,
    relatedPivotKey: resolvedRelatedPivotKey,
    parentKey: resolvedParentKey,
    relatedKey: resolvedRelatedKey,
    pivotColumns: Object.freeze([]),
    pivotWheres: Object.freeze([]),
    pivotOrderBy: Object.freeze([]),
    pivotAccessor: 'pivot',
    pivotModel: undefined,
  }))
}

export function morphToMany<
  TRelated extends ModelDefinitionLike<TableDefinition>,
  TPivotTable extends string | TableDefinition,
>(
  related: () => TRelated,
  name: string,
  pivotTable: TPivotTable,
  foreignPivotKey: string,
  parentKey = 'id',
  relatedKey = 'id',
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
): MorphToManyRelationDefinition<TRelated, TPivotTable> & PivotRelationMethods<MorphToManyRelationDefinition<TRelated, TPivotTable>, TPivotTable> {
  return decoratePivotRelation<
    BareMorphToManyRelation,
    MorphToManyRelationDefinition<TRelated, TPivotTable>,
    TPivotTable
  >(Object.freeze({
    kind: 'morphToMany',
    related,
    pivotTable,
    morphName: name,
    morphTypeColumn: type,
    morphIdColumn: id,
    foreignPivotKey,
    parentKey,
    relatedKey,
    pivotColumns: Object.freeze([]),
    pivotWheres: Object.freeze([]),
    pivotOrderBy: Object.freeze([]),
    pivotAccessor: 'pivot',
    pivotModel: undefined,
  }))
}

export function morphedByMany<
  TRelated extends ModelDefinitionLike<TableDefinition>,
  TPivotTable extends string | TableDefinition,
>(
  related: () => TRelated,
  name: string,
  pivotTable: TPivotTable,
  foreignPivotKey: string,
  parentKey = 'id',
  relatedKey = 'id',
  type = defaultMorphTypeColumn(name),
  id = defaultMorphIdColumn(name),
): MorphedByManyRelationDefinition<TRelated, TPivotTable> & PivotRelationMethods<MorphedByManyRelationDefinition<TRelated, TPivotTable>, TPivotTable> {
  return decoratePivotRelation<
    BareMorphedByManyRelation,
    MorphedByManyRelationDefinition<TRelated, TPivotTable>,
    TPivotTable
  >(Object.freeze({
    kind: 'morphedByMany',
    related,
    pivotTable,
    morphName: name,
    morphTypeColumn: type,
    morphIdColumn: id,
    foreignPivotKey,
    parentKey,
    relatedKey,
    pivotColumns: Object.freeze([]),
    pivotWheres: Object.freeze([]),
    pivotOrderBy: Object.freeze([]),
    pivotAccessor: 'pivot',
    pivotModel: undefined,
  }))
}

export function scopeRelation<TRelation extends RelationDefinition>(
  relation: TRelation,
  constraint: RelationConstraintDefinition,
): TRelation {
  const existingConstraint = relation.constraint
  const mergedConstraint: RelationConstraintDefinition = (query) => {
    const constrained = (existingConstraint ? (existingConstraint(query) ?? query) : query) as Parameters<RelationConstraintDefinition>[0]
    return constraint(constrained) ?? constrained
  }

  return Object.freeze({
    ...relation,
    constraint: mergedConstraint,
  }) as unknown as TRelation
}

export function hasOneThrough<
  TRelated extends ModelDefinitionLike<TableDefinition>,
  TThrough extends ModelDefinitionLike<TableDefinition>,
>(
  related: () => TRelated,
  through: () => TThrough,
  firstKey: string,
  secondKey: string,
  localKey = 'id',
  secondLocalKey = 'id',
): HasOneThroughRelationDefinition<TRelated, TThrough> {
  return Object.freeze({
    kind: 'hasOneThrough',
    related,
    through,
    firstKey,
    secondKey,
    localKey,
    secondLocalKey,
  })
}

export function hasManyThrough<
  TRelated extends ModelDefinitionLike<TableDefinition>,
  TThrough extends ModelDefinitionLike<TableDefinition>,
>(
  related: () => TRelated,
  through: () => TThrough,
  firstKey: string,
  secondKey: string,
  localKey = 'id',
  secondLocalKey = 'id',
): HasManyThroughRelationDefinition<TRelated, TThrough> {
  return Object.freeze({
    kind: 'hasManyThrough',
    related,
    through,
    firstKey,
    secondKey,
    localKey,
    secondLocalKey,
  })
}
