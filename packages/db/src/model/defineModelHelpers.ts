import { SchemaError } from '../core/errors'
import { TableDefinitionBuilder } from '../schema/TableDefinitionBuilder'
import { getGeneratedTableDefinition } from '../schema/generated'
import type { ColumnInput } from '../schema/columns'
import type { BoundTableDefinition } from '../schema/defineTable'
import type { TableDefinition } from '../schema/types'
import type {
  DefineModelOptions,
  ModelLifecycleEventHandler,
  ModelLifecycleEventName,
  RelationMap,
} from './types'

type ColumnShapeInput = Record<string, ColumnInput>
type EmptyColumnShape = Record<never, never>
type ModelTableBuilderResult<
  TName extends string,
  TColumns extends ColumnShapeInput,
> = {
  build(): BoundTableDefinition<TName, TColumns>
}

export function buildModelTable<
  TName extends string,
  TColumns extends ColumnShapeInput,
>(
  tableName: TName,
  builder: (table: TableDefinitionBuilder<TName, EmptyColumnShape>) => ModelTableBuilderResult<TName, TColumns>,
): BoundTableDefinition<TName, TColumns> {
  return builder(new TableDefinitionBuilder(tableName)).build()
}

export function inferModelName(tableName: string): string {
  const singular = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName
  return singular
    .split(/[_-]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

export function inferPrimaryKey<TTable extends TableDefinition>(table: TTable): Extract<keyof TTable['columns'], string> {
  const primaryKey = Object.values(table.columns).find(column => column.primaryKey)
  if (!primaryKey) {
    throw new SchemaError(`Table "${table.tableName}" does not define a primary key column.`)
  }

  return primaryKey.name as Extract<keyof TTable['columns'], string>
}

export function resolveGeneratedModelTable(tableName: string): TableDefinition {
  const table = getGeneratedTableDefinition(tableName)
  if (!table) {
    throw new SchemaError(
      `Model "${tableName}" is not present in the generated schema registry. Import your generated schema module and run "holo migrate" to refresh it.`,
    )
  }

  return table
}

export function resolveDeletedAtColumn<TTable extends TableDefinition>(
  table: TTable,
  options: DefineModelOptions<TTable>,
): Extract<keyof TTable['columns'], string> | undefined {
  if (!options.softDeletes) {
    return undefined
  }

  const deletedAtColumn = (options.deletedAtColumn ?? 'deleted_at') as Extract<keyof TTable['columns'], string>
  if (!(deletedAtColumn in table.columns)) {
    throw new SchemaError(`Soft-deleting model "${options.name ?? inferModelName(table.tableName)}" requires a "${String(deletedAtColumn)}" column.`)
  }

  return deletedAtColumn
}

export function resolveTimestampColumn<TTable extends TableDefinition>(
  table: TTable,
  explicit: string | undefined,
  fallback: string,
): Extract<keyof TTable['columns'], string> | undefined {
  const candidate = (explicit ?? fallback) as Extract<keyof TTable['columns'], string>
  return candidate in table.columns ? candidate : undefined
}

export function normalizeEventHandlers(
  events: DefineModelOptions['events'],
): Partial<Record<ModelLifecycleEventName, readonly ModelLifecycleEventHandler[]>> {
  if (!events) return {}

  return Object.fromEntries(
    Object.entries(events).map(([name, handlers]) => [
      name,
      Object.freeze(Array.isArray(handlers) ? [...handlers] : [handlers]),
    ]),
  ) as Partial<Record<ModelLifecycleEventName, readonly ModelLifecycleEventHandler[]>>
}

export function validateTouches(
  modelName: string,
  relations: RelationMap,
  touches: readonly string[],
): readonly string[] {
  for (const relationName of touches) {
    const relation = relations[relationName]
    if (!relation) {
      throw new SchemaError(`Touched relation "${relationName}" is not defined on model "${modelName}".`)
    }

    if (relation.kind !== 'belongsTo' && relation.kind !== 'morphTo') {
      throw new SchemaError(`Touched relation "${relationName}" on model "${modelName}" must be a belongs-to or morph-to relation.`)
    }
  }

  return Object.freeze([...touches])
}
