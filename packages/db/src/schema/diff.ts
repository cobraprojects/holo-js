import type {
  AnyColumnDefinition,
  ForeignKeyReference,
  TableDefinition,
  TableIndexDefinition,
} from './types'
import type { IntrospectedForeignKey, SchemaService } from './SchemaService'
import { resolveDialectComparisonColumnType, type SchemaDialectName } from './typeMapping'

export interface SchemaColumnMismatch {
  readonly column: string
  readonly expected: {
    readonly type: string
    readonly notNull: boolean
    readonly primaryKey: boolean
  }
  readonly actual: {
    readonly type: string
    readonly notNull: boolean
    readonly primaryKey: boolean
  }
}

export interface SchemaIndexMismatch {
  readonly index: string
  readonly expected: {
    readonly unique: boolean
    readonly columns: readonly string[]
  }
  readonly actual: {
    readonly unique: boolean
    readonly columns: readonly string[]
  }
}

export interface SchemaForeignKeyMismatch {
  readonly foreignKey: string
  readonly expected: {
    readonly table: string
    readonly from: string
    readonly to: string
    readonly onUpdate: string
    readonly onDelete: string
  }
  readonly actual: {
    readonly table: string
    readonly from: string
    readonly to: string
    readonly onUpdate: string
    readonly onDelete: string
  }
}

export interface TableSchemaDiff {
  readonly table: string
  readonly missingColumns: readonly string[]
  readonly extraColumns: readonly string[]
  readonly mismatchedColumns: readonly SchemaColumnMismatch[]
  readonly missingIndexes: readonly string[]
  readonly extraIndexes: readonly string[]
  readonly mismatchedIndexes: readonly SchemaIndexMismatch[]
  readonly missingForeignKeys: readonly string[]
  readonly extraForeignKeys: readonly string[]
  readonly mismatchedForeignKeys: readonly SchemaForeignKeyMismatch[]
  readonly hasChanges: boolean
}

export interface SchemaDiff {
  readonly missingTables: readonly string[]
  readonly extraTables: readonly string[]
  readonly tables: readonly TableSchemaDiff[]
  readonly hasChanges: boolean
}

export async function diffSchema(
  schema: SchemaService,
  tables: readonly TableDefinition[],
): Promise<SchemaDiff> {
  const actualTables = await schema.getTables()
  const expectedByName = new Map(tables.map(table => [table.tableName, table]))
  const extraTables = actualTables.filter(name => !expectedByName.has(name))
  const missingTables = tables
    .map(table => table.tableName)
    .filter(name => !actualTables.includes(name))

  const tableDiffs: TableSchemaDiff[] = []
  for (const table of tables) {
    if (!actualTables.includes(table.tableName)) {
      continue
    }

    tableDiffs.push(await diffTable(schema, table))
  }

  return {
    missingTables,
    extraTables,
    tables: tableDiffs,
    hasChanges: missingTables.length > 0 || extraTables.length > 0 || tableDiffs.some(table => table.hasChanges),
  }
}

async function diffTable(
  schema: SchemaService,
  table: TableDefinition,
): Promise<TableSchemaDiff> {
  const [actualColumns, actualIndexes, actualForeignKeys] = await Promise.all([
    schema.getColumns(table.tableName),
    schema.getIndexes(table.tableName),
    schema.getForeignKeys(table.tableName),
  ])

  const expectedColumns = Object.values(table.columns)
  const expectedColumnByName = new Map(expectedColumns.map(column => [column.name, column]))
  const actualColumnByName = new Map(actualColumns.map(column => [column.name, column]))

  const missingColumns = expectedColumns
    .map(column => column.name)
    .filter(name => !actualColumnByName.has(name))
  const extraColumns = actualColumns
    .map(column => column.name)
    .filter(name => !expectedColumnByName.has(name))
  const mismatchedColumns = expectedColumns
    .filter(column => actualColumnByName.has(column.name))
    .flatMap((column) => {
      const actual = actualColumnByName.get(column.name)!
      const expected = {
        type: lowerLogicalColumnType(column, schema.getDialectName()),
        notNull: !column.nullable,
        primaryKey: column.primaryKey,
      }

      if (
        actual.type === expected.type
        && actual.notNull === expected.notNull
        && actual.primaryKey === expected.primaryKey
      ) {
        return []
      }

      return [{
        column: column.name,
        expected,
        actual: {
          type: actual.type,
          notNull: actual.notNull,
          primaryKey: actual.primaryKey,
        },
      }]
    })

  const expectedIndexes = table.indexes.map(index => normalizeExpectedIndex(table, index))
  const expectedIndexByName = new Map(expectedIndexes.map(index => [index.name, index]))
  const actualIndexByName = new Map(actualIndexes.map(index => [index.name, index]))
  const missingIndexes = expectedIndexes
    .map(index => index.name)
    .filter(name => !actualIndexByName.has(name))
  const extraIndexes = actualIndexes
    .map(index => index.name)
    .filter(name => !expectedIndexByName.has(name))
  const mismatchedIndexes = expectedIndexes
    .filter(index => actualIndexByName.has(index.name))
    .flatMap((index) => {
      const actual = actualIndexByName.get(index.name)!
      if (
        actual.unique === index.unique
        && actual.columns.join('|') === index.columns.join('|')
      ) {
        return []
      }

      return [{
        index: index.name,
        expected: {
          unique: index.unique,
          columns: index.columns,
        },
        actual: {
          unique: actual.unique,
          columns: actual.columns,
        },
      }]
    })

  const expectedForeignKeys = expectedColumns
    .filter((column): column is AnyColumnDefinition & { references: ForeignKeyReference & { table: string } } => Boolean(column.references?.table))
    .map(column => normalizeExpectedForeignKey(column))
  const expectedForeignKeyByName = new Map(expectedForeignKeys.map(foreignKey => [foreignKey.name, foreignKey]))
  const actualForeignKeyByName = new Map(actualForeignKeys.map(foreignKey => [normalizeActualForeignKeyName(foreignKey), foreignKey]))
  const missingForeignKeys = expectedForeignKeys
    .map(foreignKey => foreignKey.name)
    .filter(name => !actualForeignKeyByName.has(name))
  const extraForeignKeys = actualForeignKeys
    .map(foreignKey => normalizeActualForeignKeyName(foreignKey))
    .filter(name => !expectedForeignKeyByName.has(name))
  const mismatchedForeignKeys = expectedForeignKeys
    .filter(foreignKey => actualForeignKeyByName.has(foreignKey.name))
    .flatMap((foreignKey) => {
      const actual = actualForeignKeyByName.get(foreignKey.name)!
      if (
        actual.table === foreignKey.table
        && actual.from === foreignKey.from
        && actual.to === foreignKey.to
        && actual.onUpdate.toUpperCase() === foreignKey.onUpdate
        && actual.onDelete.toUpperCase() === foreignKey.onDelete
      ) {
        return []
      }

      return [{
        foreignKey: foreignKey.name,
        expected: {
          table: foreignKey.table,
          from: foreignKey.from,
          to: foreignKey.to,
          onUpdate: foreignKey.onUpdate,
          onDelete: foreignKey.onDelete,
        },
        actual: {
          table: actual.table,
          from: actual.from,
          to: actual.to,
          onUpdate: actual.onUpdate,
          onDelete: actual.onDelete,
        },
      }]
    })

  const hasChanges = (
    missingColumns.length > 0
    || extraColumns.length > 0
    || mismatchedColumns.length > 0
    || missingIndexes.length > 0
    || extraIndexes.length > 0
    || mismatchedIndexes.length > 0
    || missingForeignKeys.length > 0
    || extraForeignKeys.length > 0
    || mismatchedForeignKeys.length > 0
  )

  return {
    table: table.tableName,
    missingColumns,
    extraColumns,
    mismatchedColumns,
    missingIndexes,
    extraIndexes,
    mismatchedIndexes,
    missingForeignKeys,
    extraForeignKeys,
    mismatchedForeignKeys,
    hasChanges,
  }
}

function lowerLogicalColumnType(column: AnyColumnDefinition, dialectName: string): string {
  const normalizedDialectName = dialectName
    .replace(/^postgres.*/, 'postgres')
    .replace(/^mysql.*/, 'mysql')
    .replace(/^sqlite.*/, 'sqlite') as SchemaDialectName
  return resolveDialectComparisonColumnType(normalizedDialectName, column)
}

function normalizeExpectedIndex(
  table: TableDefinition,
  index: TableIndexDefinition,
): { name: string, unique: boolean, columns: readonly string[] } {
  return {
    name: index.name ?? `${table.tableName}_${index.columns.join('_')}_${index.unique ? 'unique' : 'index'}`,
    unique: index.unique,
    columns: index.columns,
  }
}

function normalizeExpectedForeignKey(
  column: AnyColumnDefinition & { references: ForeignKeyReference & { table: string } },
): {
  name: string
  table: string
  from: string
  to: string
  onUpdate: string
  onDelete: string
} {
  return {
    name: `${column.name}->${column.references.table}.${column.references.column}`,
    table: column.references.table,
    from: column.name,
    to: column.references.column,
    onUpdate: (column.references.onUpdate ?? 'NO ACTION').toUpperCase(),
    onDelete: (column.references.onDelete ?? 'NO ACTION').toUpperCase(),
  }
}

function normalizeActualForeignKeyName(foreignKey: IntrospectedForeignKey): string {
  return `${foreignKey.from}->${foreignKey.table}.${foreignKey.to}`
}
