import { readStringLiterals } from './sqlDefinitions'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { DatabaseColumnDefault, DatabaseEnumCheckStructure, DatabaseIndexStructure, DialectSchemaReader } from './types'

type TableNameRow = { name: string }
type ColumnRow = { name: string, data_type: string, column_type: string, is_nullable: 'YES' | 'NO', column_default: string | null, column_key: string, extra: string }
type IndexRow = { name: string, non_unique: number | string, column_name: string | null, sub_part: number | null, expression: string | null }
type ForeignKeyRow = { name: string, table_schema: string, referenced_schema: string, table_name: string, from_column: string, to_column: string, on_update: string, on_delete: string }

const SCHEMA_BINDING = 'COALESCE(?, DATABASE())'
const CURRENT_TIME_PATTERN = /^(?:CURRENT_TIMESTAMP|now|LOCALTIMESTAMP|LOCALTIME)(?:\(\d*\))?$/i
const NUMERIC_TYPE_PATTERN = /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)\b/i

function readColumnDefault(row: ColumnRow): DatabaseColumnDefault {
  if (row.column_default === null) return { kind: 'none' }
  if (CURRENT_TIME_PATTERN.test(row.column_default)) return { kind: 'now' }
  if (/\bDEFAULT_GENERATED\b/i.test(row.extra)) return { kind: 'expression', sql: row.column_default }
  if (NUMERIC_TYPE_PATTERN.test(row.column_type) && row.column_default.trim() !== '' && Number.isFinite(Number(row.column_default))) {
    return { kind: 'literal', value: Number(row.column_default) }
  }
  return { kind: 'literal', value: row.column_default }
}

function splitTableName(tableName: string): { schema: string | null, table: string } {
  const separator = tableName.lastIndexOf('.')
  return separator === -1
    ? { schema: null, table: tableName }
    : { schema: tableName.slice(0, separator), table: tableName.slice(separator + 1) }
}

function readEnumColumns(columns: readonly ColumnRow[]): DatabaseEnumCheckStructure[] {
  return columns.flatMap(column => /^enum\(/i.test(column.column_type)
    ? [{ column: column.name, values: readStringLiterals(column.column_type.slice(5, -1)) }]
    : [])
}

function groupIndexes(rows: readonly IndexRow[]): DatabaseIndexStructure[] {
  const grouped = new Map<string, { unique: boolean, columns: string[], representable: boolean }>()
  for (const row of rows) {
    const entry = grouped.get(row.name) ?? { unique: Number(row.non_unique) === 0, columns: [], representable: true }
    if (row.column_name === null || row.expression !== null || row.sub_part !== null) entry.representable = false
    if (row.column_name !== null) entry.columns.push(row.column_name)
    grouped.set(row.name, entry)
  }

  return [...grouped].map(([name, entry]) => ({
    name,
    unique: entry.unique,
    primary: name === 'PRIMARY',
    columns: entry.columns,
    representable: entry.representable,
  }))
}

export function createMySQLSchemaReader(connection: DatabaseContext): DialectSchemaReader {
  const configuredSchema = connection.getSchemaName() ?? null
  const introspect = <TRow extends Record<string, unknown>>(sql: string, bindings: readonly unknown[], source: string) =>
    connection.introspectCompiled<TRow>({ sql, bindings, source })

  return {
    async listTables() {
      const result = await introspect<TableNameRow>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${SCHEMA_BINDING} AND table_type IN ('BASE TABLE', 'SYSTEM VERSIONED') ORDER BY table_name`, [configuredSchema], 'schema:introspect:tables')
      return result.rows.map(row => row.name).sort()
    },

    async readTableStructure(tableName) {
      const { schema, table } = splitTableName(tableName)
      const bindings = [schema ?? configuredSchema, table]
      const columns = await introspect<ColumnRow>(`SELECT column_name AS name, data_type AS data_type, column_type AS column_type, is_nullable AS is_nullable, column_default AS column_default, column_key AS column_key, extra AS extra FROM information_schema.columns WHERE table_schema = ${SCHEMA_BINDING} AND table_name = ? ORDER BY ordinal_position`, bindings, `schema:introspect:columns:${tableName}`)
      if (columns.rows.length === 0) return undefined

      const indexes = await introspect<IndexRow>(`SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name, sub_part AS sub_part, expression AS expression FROM information_schema.statistics WHERE table_schema = ${SCHEMA_BINDING} AND table_name = ? ORDER BY index_name, seq_in_index`, bindings, `schema:introspect:indexes:${tableName}`)
      const foreignKeys = await introspect<ForeignKeyRow>(`SELECT kcu.constraint_name AS name, kcu.table_schema AS table_schema, kcu.referenced_table_schema AS referenced_schema, kcu.referenced_table_name AS table_name, kcu.column_name AS from_column, kcu.referenced_column_name AS to_column, rc.update_rule AS on_update, rc.delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = ${SCHEMA_BINDING} AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.constraint_name, kcu.ordinal_position`, bindings, `schema:introspect:foreignKeys:${tableName}`)

      return {
        dialect: 'mysql',
        tableName,
        columns: columns.rows.map(row => ({
          name: row.name,
          dataType: row.data_type,
          fullType: row.column_type,
          notNull: row.is_nullable === 'NO',
          defaultExpression: row.column_default,
          default: readColumnDefault(row),
          primaryKey: row.column_key === 'PRI',
          autoIncrement: /\bauto_increment\b/i.test(row.extra),
          computed: /\b(?:VIRTUAL|STORED) GENERATED\b/i.test(row.extra),
        })),
        indexes: groupIndexes(indexes.rows),
        foreignKeys: foreignKeys.rows.map(row => ({
          name: row.name,
          table: row.referenced_schema === row.table_schema ? row.table_name : `${row.referenced_schema}.${row.table_name}`,
          from: row.from_column,
          to: row.to_column,
          onUpdate: row.on_update,
          onDelete: row.on_delete,
        })),
        enumChecks: readEnumColumns(columns.rows),
      }
    },
  }
}
