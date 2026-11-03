import { parseSqlDefault } from './defaults'
import { readColumnDefinitionName, readEnumChecks, readForeignKeyName, readStringLength, splitTableDefinitions } from './sqlDefinitions'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { DatabaseEnumCheckStructure, DatabaseForeignKeyStructure, DatabaseIndexStructure, DatabaseTableStructure, DialectSchemaReader } from './types'

type TableNameRow = { name: string }
type TableSqlRow = { sql: string | null }
type ColumnRow = { name: string, type: string, notnull: number, dflt_value: string | null, pk: number, hidden: number }
type IndexRow = { name: string, unique: number, origin: string, partial: number }
type IndexColumnRow = { cid: number, name: string | null }
type ForeignKeyRow = { id: number, table: string, from: string, to: string | null, on_update: string, on_delete: string }

function splitTableName(tableName: string): { schema: string, table: string } {
  const separator = tableName.lastIndexOf('.')
  return separator === -1
    ? { schema: 'main', table: tableName }
    : { schema: tableName.slice(0, separator), table: tableName.slice(separator + 1) }
}

function readDefinitionDetails(createTableSql: string) {
  const foreignKeyNames = new Map<string, string>()
  const enumChecks: DatabaseEnumCheckStructure[] = []

  for (const definition of splitTableDefinitions(createTableSql)) {
    const columnName = readColumnDefinitionName(definition)
    const foreignKey = readForeignKeyName(definition, columnName)
    if (foreignKey) foreignKeyNames.set(foreignKey.column, foreignKey.name)
    enumChecks.push(...readEnumChecks(definition))
  }

  return { foreignKeyNames, enumChecks }
}

export function createSQLiteSchemaReader(connection: DatabaseContext): DialectSchemaReader {
  const introspect = <TRow extends Record<string, unknown>>(sql: string, bindings: readonly unknown[], source: string) =>
    connection.introspectCompiled<TRow>({ sql, bindings, source })

  async function readIndexes(schema: string, table: string): Promise<DatabaseIndexStructure[]> {
    const indexes = await introspect<IndexRow>('SELECT name, "unique", origin, partial FROM pragma_index_list(?, ?) ORDER BY name', [table, schema], `schema:introspect:indexes:${table}`)
    const structures: DatabaseIndexStructure[] = []
    for (const index of indexes.rows) {
      const columns = await introspect<IndexColumnRow>('SELECT cid, name FROM pragma_index_info(?, ?) ORDER BY seqno', [index.name, schema], `schema:introspect:indexColumns:${table}:${index.name}`)
      structures.push({
        name: index.name,
        unique: index.unique === 1,
        primary: index.origin === 'pk',
        columns: columns.rows.flatMap(column => column.name === null ? [] : [column.name]),
        representable: index.partial === 0 && columns.rows.every(column => column.name !== null),
      })
    }
    return structures
  }

  async function readForeignKeys(schema: string, table: string, names: ReadonlyMap<string, string>): Promise<DatabaseForeignKeyStructure[]> {
    const result = await introspect<ForeignKeyRow>('SELECT id, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', [table, schema], `schema:introspect:foreignKeys:${table}`)
    return result.rows.map((row) => {
      const name = names.get(row.from)
      return {
        ...(name ? { name } : {}),
        table: row.table,
        from: row.from,
        to: row.to ?? 'id',
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      }
    })
  }

  return {
    async listTables() {
      const result = await introspect<TableNameRow>('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name', [], 'schema:introspect:tables')
      return result.rows.map(row => row.name).sort()
    },

    async readTableStructure(tableName) {
      const { schema, table } = splitTableName(tableName)
      const tableSql = await introspect<TableSqlRow>(`SELECT sql FROM ${connection.getDialect().quoteIdentifier(schema)}.sqlite_master WHERE type = 'table' AND name = ?`, [table], `schema:introspect:table:${tableName}`)
      const createTableSql = tableSql.rows[0]?.sql
      if (createTableSql === undefined) return undefined

      const details = readDefinitionDetails(createTableSql ?? '')
      const columns = await introspect<ColumnRow>('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid', [table, schema], `schema:introspect:columns:${tableName}`)
      const primaryKeyColumns = columns.rows.filter(row => row.pk > 0)
      const rowIdAlias = primaryKeyColumns.length === 1 && primaryKeyColumns[0]!.type.toLowerCase() === 'integer' ? primaryKeyColumns[0]!.name : undefined
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
        indexes: await readIndexes(schema, table),
        foreignKeys: await readForeignKeys(schema, table, details.foreignKeyNames),
        enumChecks: details.enumChecks,
      }
      return structure
    },
  }
}
