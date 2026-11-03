import { splitTablePath } from '../identifiers'
import { parseSqlDefault } from './defaults'
import { createIntrospect } from './introspect'
import { readEnumChecks, readForeignKeys, readStringLength, splitTableDefinitions, type ForeignKeyDefinition } from './sqlDefinitions'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { DatabaseEnumCheckStructure, DatabaseForeignKeyStructure, DatabaseIndexStructure, DatabaseTableStructure, DialectSchemaReader } from './types'

type TableNameRow = { name: string }
type TableSqlRow = { sql: string | null }
type ColumnRow = { name: string, type: string, notnull: number, dflt_value: string | null, pk: number, hidden: number }
type IndexRow = { name: string, unique: number, origin: string, partial: number }
type IndexColumnRow = { cid: number, name: string | null }
type ForeignKeyRow = { id: number, seq: number, table: string, from: string, to: string | null, on_update: string, on_delete: string }
type PrimaryKeyColumnRow = { name: string }

export const SQLITE_AUTOINDEX_PREFIX = 'sqlite_autoindex_'

export type SQLiteTableObject = { type: 'index' | 'trigger', name: string, sql: string }

const MAIN_SCHEMA = 'main'

function splitTableName(tableName: string): { schema: string, table: string } {
  const { schema = MAIN_SCHEMA, table } = splitTablePath(tableName)
  return { schema, table }
}

export async function readSQLiteCreateTableSql(connection: DatabaseContext, tableName: string): Promise<string | null | undefined> {
  const { schema, table } = splitTableName(tableName)
  const result = await connection.introspectCompiled<TableSqlRow>({
    sql: `SELECT sql FROM ${connection.getDialect().quoteIdentifier(schema)}.sqlite_master WHERE type = 'table' AND name = ?`,
    bindings: [table],
    source: `schema:introspect:table:${tableName}`,
  })
  return result.rows[0]?.sql
}

export async function readSQLiteTableObjects(connection: DatabaseContext, tableName: string): Promise<SQLiteTableObject[]> {
  const { schema, table } = splitTableName(tableName)
  const result = await connection.introspectCompiled<SQLiteTableObject>({
    sql: `SELECT type, name, sql FROM ${connection.getDialect().quoteIdentifier(schema)}.sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`,
    bindings: [table],
    source: `schema:introspect:objects:${tableName}`,
  })
  return result.rows
}

export async function listSQLiteReferencingTables(connection: DatabaseContext, tableName: string): Promise<string[]> {
  const result = await connection.introspectCompiled<TableNameRow>({
    sql: 'SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = \'table\' AND f."table" = ? ORDER BY m.name',
    bindings: [tableName],
    source: `schema:introspect:referencingTables:${tableName}`,
  })
  return result.rows.map(row => row.name)
}

function readDefinitionDetails(createTableSql: string) {
  const declaredForeignKeys: ForeignKeyDefinition[] = []
  const enumChecks: DatabaseEnumCheckStructure[] = []

  for (const definition of splitTableDefinitions(createTableSql)) {
    declaredForeignKeys.push(...readForeignKeys(definition))
    enumChecks.push(...readEnumChecks(definition))
  }

  return { declaredForeignKeys, enumChecks }
}

function sameIdentifier(left: string, right: string | undefined): boolean {
  return left.toLowerCase() === right?.toLowerCase()
}

function sameIdentifiers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => sameIdentifier(name, right[index]))
}

function claimForeignKeyName(declared: ForeignKeyDefinition[], rows: readonly ForeignKeyRow[]): string | undefined {
  const columns = rows.map(row => row.from)
  const index = declared.findIndex(foreignKey => sameIdentifier(foreignKey.table, rows[0]?.table) && sameIdentifiers(foreignKey.columns, columns))
  const [claimed] = index === -1 ? [] : declared.splice(index, 1)
  return claimed?.name
}

function readRowIdAlias(columns: readonly ColumnRow[], indexes: readonly DatabaseIndexStructure[]): string | undefined {
  const [onlyPrimaryKey, ...otherPrimaryKeys] = columns.filter(row => row.pk > 0)
  const primaryKeyHasOwnIndex = indexes.some(index => index.primary)
  if (!onlyPrimaryKey || otherPrimaryKeys.length > 0 || primaryKeyHasOwnIndex) return undefined
  return onlyPrimaryKey.type.toLowerCase() === 'integer' ? onlyPrimaryKey.name : undefined
}

export function createSQLiteSchemaReader(connection: DatabaseContext): DialectSchemaReader {
  const introspect = createIntrospect(connection)

  async function readIndexes(schema: string, table: string): Promise<DatabaseIndexStructure[]> {
    const indexes = await introspect<IndexRow>('SELECT name, "unique", origin, partial FROM pragma_index_list(?, ?) ORDER BY name', [table, schema], `schema:introspect:indexes:${table}`)
    const structures: DatabaseIndexStructure[] = []
    for (const index of indexes.rows) {
      const columns = await introspect<IndexColumnRow>('SELECT cid, name FROM pragma_index_info(?, ?) ORDER BY seqno', [index.name, schema], `schema:introspect:indexColumns:${table}:${index.name}`)
      structures.push({
        name: index.name,
        unique: index.unique === 1,
        primary: index.origin === 'pk',
        constraint: index.origin !== 'c',
        columns: columns.rows.flatMap(column => column.name === null ? [] : [column.name]),
        representable: index.partial === 0 && columns.rows.every(column => column.name !== null),
      })
    }
    return structures
  }

  async function readPrimaryKeyColumns(schema: string, table: string): Promise<string[]> {
    const result = await introspect<PrimaryKeyColumnRow>('SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', [table, schema], `schema:introspect:primaryKey:${table}`)
    return result.rows.map(row => row.name)
  }

  async function readForeignKeyStructures(schema: string, table: string, declared: readonly ForeignKeyDefinition[]): Promise<DatabaseForeignKeyStructure[]> {
    const result = await introspect<ForeignKeyRow>('SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', [table, schema], `schema:introspect:foreignKeys:${table}`)
    const parentPrimaryKeys = new Map<string, string[]>()
    const readParentPrimaryKey = async (parent: string): Promise<string[]> => {
      const primaryKey = parentPrimaryKeys.get(parent) ?? await readPrimaryKeyColumns(schema, parent)
      parentPrimaryKeys.set(parent, primaryKey)
      return primaryKey
    }
    const unclaimed = [...declared]
    const names = new Map<number, string | undefined>()
    for (const id of new Set(result.rows.map(row => row.id))) {
      names.set(id, claimForeignKeyName(unclaimed, result.rows.filter(row => row.id === id)))
    }
    const foreignKeys: DatabaseForeignKeyStructure[] = []
    for (const row of result.rows) {
      const to = row.to ?? (await readParentPrimaryKey(row.table))[row.seq]
      if (to === undefined) continue
      const name = names.get(row.id)
      foreignKeys.push({
        ...(name ? { name } : {}),
        table: row.table,
        from: row.from,
        to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      })
    }
    return foreignKeys
  }

  return {
    async listTables() {
      const result = await introspect<TableNameRow>('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name', [], 'schema:introspect:tables')
      return result.rows.map(row => row.name).sort()
    },

    async readTableStructure(tableName) {
      const { schema, table } = splitTableName(tableName)
      const createTableSql = await readSQLiteCreateTableSql(connection, tableName)
      if (createTableSql === undefined) return undefined

      const details = readDefinitionDetails(createTableSql ?? '')
      const columns = await introspect<ColumnRow>('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid', [table, schema], `schema:introspect:columns:${tableName}`)
      const indexes = await readIndexes(schema, table)
      const rowIdAlias = readRowIdAlias(columns.rows, indexes)
      const structure: DatabaseTableStructure = {
        dialect: 'sqlite',
        tableName,
        columns: columns.rows.filter(row => row.hidden !== 1).map(row => ({
          name: row.name,
          dataType: row.type,
          fullType: row.type,
          length: readStringLength(row.type),
          notNull: row.notnull === 1,
          defaultExpression: row.dflt_value,
          default: parseSqlDefault(row.dflt_value),
          primaryKey: row.pk > 0,
          autoIncrement: row.name === rowIdAlias,
          computed: row.hidden === 2 || row.hidden === 3,
        })),
        indexes,
        foreignKeys: await readForeignKeyStructures(schema, table, details.declaredForeignKeys),
        enumChecks: details.enumChecks,
      }
      return structure
    },
  }
}
