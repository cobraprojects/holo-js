import type {
  AnyColumnDefinition,
  ForeignKeyReference,
  TableDefinition,
  TableIndexDefinition,
} from './types'
import { readSchemaServiceTableStructure, type IntrospectedForeignKey, type IntrospectedIndex, type SchemaService } from './SchemaService'
import { resolveDialectComparisonColumnType, type SchemaDialectName } from './typeMapping'
import { SQLITE_AUTOINDEX_PREFIX } from './introspection/sqlite'
import { createConventionalIndexName, createGeneratedUniqueIndexName } from './generatedNames'
import { splitTablePath } from './identifiers'
import { listTablePrimaryKeyColumns } from './tablePrimaryKey'

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
  const resolveTableSchema = createTableSchemaResolver(schema)
  const unqualifiedNames = new Set(tables.map(table => table.tableName).filter(name => splitTablePath(name).schema === undefined))
  const qualifiedLocations: { readonly table: string, readonly schema: string }[] = []
  const existingTables: TableDefinition[] = []
  const missingTables: string[] = []
  for (const table of tables) {
    const { schema: schemaName, table: tableName } = splitTablePath(table.tableName)
    if (schemaName === undefined) {
      if (actualTables.includes(table.tableName)) existingTables.push(table)
      else missingTables.push(table.tableName)
      continue
    }

    const resolvedSchema = await resolveTableSchema(table.tableName)
    if (resolvedSchema === undefined) {
      missingTables.push(table.tableName)
      continue
    }

    qualifiedLocations.push({ table: tableName, schema: resolvedSchema })
    existingTables.push(table)
  }

  const extraTables: string[] = []
  for (const name of actualTables) {
    if (unqualifiedNames.has(name)) continue
    const candidates = qualifiedLocations.filter(location => location.table === name)
    const resolvedSchema = candidates.length > 0 ? await resolveTableSchema(name) : undefined
    if (!candidates.some(location => location.schema === resolvedSchema)) extraTables.push(name)
  }

  const tableDiffs: TableSchemaDiff[] = []
  for (const table of existingTables) {
    tableDiffs.push(await diffTable(schema, table, resolveTableSchema))
  }

  return {
    missingTables,
    extraTables,
    tables: tableDiffs,
    hasChanges: missingTables.length > 0 || extraTables.length > 0 || tableDiffs.some(table => table.hasChanges),
  }
}

type TableSchemaResolver = (tableName: string) => Promise<string | undefined>

function createTableSchemaResolver(schema: SchemaService): TableSchemaResolver {
  const resolved = new Map<string, Promise<string | undefined>>()
  return (tableName) => {
    const cached = resolved.get(tableName)
    if (cached) return cached
    const pending = readSchemaServiceTableStructure(schema, tableName).then(structure => structure?.schema)
    resolved.set(tableName, pending)
    return pending
  }
}

async function resolveReferencedTable(
  schema: SchemaService,
  resolveTableSchema: TableSchemaResolver,
  ownerTableName: string,
  referencedTableName: string,
): Promise<string> {
  const owner = splitTablePath(ownerTableName)
  const referenced = splitTablePath(referencedTableName)
  if (owner.schema === undefined && referenced.schema === undefined) return referencedTableName
  const ownerSchema = await resolveTableSchema(ownerTableName)
  const referencedSchema = referenced.schema
    ?? (/^postgres/.test(schema.getDialectName()) ? await resolveTableSchema(referencedTableName) : ownerSchema)
  if (referencedSchema === undefined) return referencedTableName
  return referencedSchema === ownerSchema ? referenced.table : `${referencedSchema}.${referenced.table}`
}

async function diffTable(
  schema: SchemaService,
  table: TableDefinition,
  resolveTableSchema: TableSchemaResolver,
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
        actual.type.toLowerCase() === expected.type.toLowerCase()
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
  const comparableIndexes = actualIndexes.filter(index => !isConstraintIndex(table, index))
  const actualIndexByName = new Map(comparableIndexes.map(index => [index.name, index]))
  const missingIndexes = expectedIndexes
    .map(index => index.name)
    .filter(name => !actualIndexByName.has(name))
  for (const column of expectedColumns.filter(column => column.unique && !column.primaryKey)) {
    if (!actualIndexes.some(index => index.unique && index.columns.length === 1 && index.columns[0] === column.name)) {
      const name = createGeneratedUniqueIndexName(table.tableName, [column.name])
      if (!missingIndexes.includes(name)) missingIndexes.push(name)
    }
  }
  const extraIndexes = comparableIndexes
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

  const expectedForeignKeys = await Promise.all(expectedColumns
    .filter((column): column is AnyColumnDefinition & { references: ForeignKeyReference & { table: string } } => Boolean(column.references?.table))
    .map(async column => normalizeExpectedForeignKey(column, await resolveReferencedTable(schema, resolveTableSchema, table.tableName, column.references.table))))
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

function isConstraintIndex(table: TableDefinition, index: IntrospectedIndex): boolean {
  if (!index.unique || table.indexes.some(expected => normalizeExpectedIndex(table, expected).name === index.name)) return false
  const { table: tableName } = splitTablePath(table.tableName)
  const sqliteAutoindexPrefix = `${SQLITE_AUTOINDEX_PREFIX}${tableName}_`
  const primaryKeys = listTablePrimaryKeyColumns(table)
  const matchesPrimaryKey = index.columns.length === primaryKeys.length && index.columns.every((column, position) => column === primaryKeys[position])
  if (matchesPrimaryKey && (index.name === 'PRIMARY' || index.name === `${tableName}_pkey` || index.name.startsWith(sqliteAutoindexPrefix))) return true
  const [columnName] = index.columns
  const column = index.columns.length === 1 && columnName ? table.columns[columnName] : undefined
  return Boolean(column?.unique && (index.name === column.name
    || index.name === `${tableName}_${column.name}_key`
    || index.name === createGeneratedUniqueIndexName(table.tableName, [column.name])
    || index.name.startsWith(sqliteAutoindexPrefix)))
}

function normalizeExpectedIndex(
  table: TableDefinition,
  index: TableIndexDefinition,
): { name: string, unique: boolean, columns: readonly string[] } {
  return {
    name: index.name ?? createConventionalIndexName(table.tableName, index.columns, index.unique ? 'unique' : 'index'),
    unique: Boolean(index.unique),
    columns: index.columns,
  }
}

function normalizeExpectedForeignKey(
  column: AnyColumnDefinition & { references: ForeignKeyReference & { table: string } },
  referencedTable: string,
): {
  name: string
  table: string
  from: string
  to: string
  onUpdate: string
  onDelete: string
} {
  return {
    name: `${column.name}->${referencedTable}.${column.references.column}`,
    table: referencedTable,
    from: column.name,
    to: column.references.column,
    onUpdate: (column.references.onUpdate ?? 'NO ACTION').toUpperCase(),
    onDelete: (column.references.onDelete ?? 'NO ACTION').toUpperCase(),
  }
}

function normalizeActualForeignKeyName(foreignKey: IntrospectedForeignKey): string {
  return `${foreignKey.from}->${foreignKey.table}.${foreignKey.to}`
}
