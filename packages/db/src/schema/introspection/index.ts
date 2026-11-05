import { assertValidIdentifierPath } from '../identifiers'
import { toTableDefinition } from './definitions'
import { createMySQLSchemaReader } from './mysql'
import { createPostgresSchemaReader } from './postgres'
import { createSQLiteSchemaReader } from './sqlite'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { TableDefinition } from '../types'
import type { DatabaseTableStructure, DialectSchemaReader, TableLocation } from './types'

export type * from './types'

export interface SchemaReader {
  listTables(): Promise<string[]>
  locateTable(tableName: string): Promise<TableLocation | undefined>
  resolveReferencedTableSchema(tableName: string, ownerSchema: string): Promise<string | undefined>
  readTableStructure(tableName: string): Promise<DatabaseTableStructure | undefined>
  readTable(tableName: string): Promise<TableDefinition | undefined>
  readGeneratedSchema(): Promise<TableDefinition[]>
}

const HOLO_OWNED_TABLE_PATTERN = /^_{1,2}holo_/

function createDialectSchemaReader(connection: DatabaseContext): DialectSchemaReader {
  const dialect = connection.getDialect().name
  if (dialect === 'postgres') return createPostgresSchemaReader(connection)
  if (dialect === 'mysql') return createMySQLSchemaReader(connection)
  return createSQLiteSchemaReader(connection)
}

export function createSchemaReader(connection: DatabaseContext): SchemaReader {
  const reader = createDialectSchemaReader(connection)

  async function readTable(tableName: string): Promise<TableDefinition | undefined> {
    const structure = await reader.readTableStructure(tableName)
    return structure ? toTableDefinition(structure) : undefined
  }

  return {
    listTables: () => reader.listTables(),
    locateTable: tableName => reader.locateTable(tableName),
    resolveReferencedTableSchema: (tableName, ownerSchema) => reader.resolveReferencedTableSchema(tableName, ownerSchema),
    readTableStructure: tableName => reader.readTableStructure(tableName),
    readTable,
    async readGeneratedSchema() {
      const tables: TableDefinition[] = []
      for (const tableName of await reader.listTables()) {
        if (HOLO_OWNED_TABLE_PATTERN.test(tableName)) continue
        const table = await readTable(tableName)
        if (table) tables.push(table)
      }
      return tables
    },
  }
}

export function readTableStructure(connection: DatabaseContext, tableName: string): Promise<DatabaseTableStructure | undefined> {
  assertValidIdentifierPath(tableName, 'Table name')
  return createSchemaReader(connection).readTableStructure(tableName)
}

export function locateTable(connection: DatabaseContext, tableName: string): Promise<TableLocation | undefined> {
  assertValidIdentifierPath(tableName, 'Table name')
  return createSchemaReader(connection).locateTable(tableName)
}

export function resolveReferencedTableSchema(connection: DatabaseContext, tableName: string, ownerSchema: string): Promise<string | undefined> {
  assertValidIdentifierPath(tableName, 'Table name')
  return createSchemaReader(connection).resolveReferencedTableSchema(tableName, ownerSchema)
}
