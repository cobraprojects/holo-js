import { SchemaError } from '../core/errors'
import { isColumnBuilder, type ColumnInput } from './columns'
import { assertValidIdentifierPath, assertValidIdentifierSegment } from './identifiers'
import type {
  AnyColumnDefinition,
  TableDefinition,
  TableIndexDefinition,
} from './types'

type ColumnShapeInput = Record<string, ColumnInput>

type ResolvedColumn<TColumn extends ColumnInput>
  = TColumn extends { toDefinition(options: { name: string }): infer TDefinition }
    ? TDefinition extends AnyColumnDefinition ? TDefinition : never
    : TColumn extends AnyColumnDefinition
      ? TColumn
      : never

type BoundColumns<TColumns extends ColumnShapeInput> = {
  [K in keyof TColumns]:
  ResolvedColumn<TColumns[K]>
}

export interface DefineTableOptions {
  indexes?: readonly TableIndexDefinition[]
}

export type BoundTableDefinition<
  TName extends string,
  TColumns extends ColumnShapeInput,
> = TableDefinition<TName, BoundColumns<TColumns>> & BoundColumns<TColumns>

function bindColumn(columnName: string, column: ColumnInput): AnyColumnDefinition {
  if (isColumnBuilder(column)) {
    return column.toDefinition({ name: columnName }) as AnyColumnDefinition
  }

  if (!('name' in column) || !column.name) {
    throw new SchemaError(
      `Column "${columnName}" must be created through the schema builder or include bound column metadata.`,
    )
  }

  if (column.name !== columnName) {
    throw new SchemaError(
      `Column "${columnName}" cannot be defined as "${column.name}". Declare one canonical column name only.`,
    )
  }

  return column
}

export function defineTable<
  TName extends string,
  TColumns extends ColumnShapeInput,
>(
  name: TName,
  columns: TColumns,
  options: DefineTableOptions = {},
): BoundTableDefinition<TName, TColumns> {
  assertValidIdentifierPath(name, 'Table name')

  for (const columnName of Object.keys(columns)) {
    assertValidIdentifierSegment(columnName, 'Column name')
  }

  for (const index of options.indexes ?? []) {
    if (index.name) {
      assertValidIdentifierSegment(index.name, 'Index name')
    }

    for (const columnName of index.columns) {
      assertValidIdentifierSegment(columnName, 'Index column')
    }
  }

  const boundColumns = Object.fromEntries(
    Object.entries(columns).map(([columnName, column]) => [
      columnName,
      bindColumn(columnName, column),
    ]),
  ) as BoundColumns<TColumns>

  const table = {
    kind: 'table' as const,
    tableName: name,
    columns: boundColumns,
    indexes: Object.freeze([...(options.indexes ?? [])]),
    ...boundColumns,
  } satisfies TableDefinition<TName, BoundColumns<TColumns>> & BoundColumns<TColumns>

  return Object.freeze(table) as BoundTableDefinition<TName, TColumns>
}
