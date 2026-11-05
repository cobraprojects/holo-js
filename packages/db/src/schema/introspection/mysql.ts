import { splitTablePath } from '../identifiers'
import { createIntrospect } from './introspect'
import { readForeignKeyColumns, readStringLength } from './sqlDefinitions'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { ComputedColumn } from '../types'
import type { DatabaseColumnDefault, DatabaseEnumCheckStructure, DatabaseIndexStructure, DialectSchemaReader } from './types'

type TableNameRow = { name: string }
type TableSchemaRow = { table_schema: string }
type ColumnRow = { table_schema: string, name: string, data_type: string, column_type: string, is_nullable: 'YES' | 'NO', column_default: string | null, extra: string, generation_expression: string | null }
type IndexRow = { name: string, non_unique: number | string, column_name: string | null, sub_part: number | null, expression: string | null }
type ForeignKeyRow = { name: string, table_schema: string, referenced_schema: string, table_name: string, from_column: string, to_column: string, on_update: string, on_delete: string }

const SCHEMA_BINDING = 'COALESCE(?, DATABASE())'
const BASE_TABLE_FILTER = 'table_type IN (\'BASE TABLE\', \'SYSTEM VERSIONED\')'
const CURRENT_TIME_PATTERN = /^(?:CURRENT_TIMESTAMP|LOCALTIMESTAMP|LOCALTIME)(?:\(\d*\))?$|^now\(\)$/i
const TEMPORAL_TYPE_PATTERN = /^(?:timestamp|datetime)\b/i
const DEFAULT_GENERATED_PATTERN = /\bDEFAULT_GENERATED\b/i
const COMPUTED_KIND_PATTERN = /\b(VIRTUAL|STORED) GENERATED\b/i
const INFORMATION_SCHEMA_ESCAPE_PATTERN = /\\(.)/gs
const SINGLE_STRING_LITERAL_PATTERN = /^(?:_\w+\s*)?'((?:[^'\\]|\\.|'')*)'$/s
const MYSQL_STRING_LITERAL_PATTERN = /'((?:[^'\\]|\\.|'')*)'/gs
const MYSQL_ESCAPE_SEQUENCE_PATTERN = /\\(.)|''/gs
const MYSQL_ESCAPED_CHARACTERS: Readonly<Record<string, string>> = { '0': '\0', 'b': '\b', 'n': '\n', 'r': '\r', 't': '\t', 'Z': '\x1a', '%': '\\%', '_': '\\_' }

function isCurrentTimeDefault(row: ColumnRow, columnDefault: string): boolean {
  return CURRENT_TIME_PATTERN.test(columnDefault)
    && (DEFAULT_GENERATED_PATTERN.test(row.extra) || TEMPORAL_TYPE_PATTERN.test(row.column_type))
}

function readExpressionDefault(storedExpression: string): DatabaseColumnDefault {
  const expression = storedExpression.replace(INFORMATION_SCHEMA_ESCAPE_PATTERN, '$1')
  const literal = SINGLE_STRING_LITERAL_PATTERN.exec(expression)?.[1]
  return literal === undefined
    ? { kind: 'expression', sql: expression }
    : { kind: 'literal', value: decodeMySQLStringLiteral(literal) }
}

function readComputedColumn(row: ColumnRow): ComputedColumn | undefined {
  const kind = COMPUTED_KIND_PATTERN.exec(row.extra)?.[1]
  return kind === undefined || !row.generation_expression
    ? undefined
    : { expression: row.generation_expression.replace(INFORMATION_SCHEMA_ESCAPE_PATTERN, '$1'), stored: kind.toUpperCase() === 'STORED' }
}

function readColumnDefault(row: ColumnRow): DatabaseColumnDefault {
  const columnDefault = row.column_default
  if (columnDefault === null) return { kind: 'none' }
  if (isCurrentTimeDefault(row, columnDefault)) return { kind: 'now' }
  if (DEFAULT_GENERATED_PATTERN.test(row.extra)) return readExpressionDefault(columnDefault)
  return { kind: 'literal', value: columnDefault }
}

function decodeMySQLStringLiteral(body: string): string {
  return body.replace(MYSQL_ESCAPE_SEQUENCE_PATTERN, (_sequence, escaped: string | undefined) => escaped === undefined
    ? '\''
    : MYSQL_ESCAPED_CHARACTERS[escaped] ?? escaped)
}

function readMySQLStringLiterals(text: string): string[] {
  return [...text.matchAll(MYSQL_STRING_LITERAL_PATTERN)].map(([, body = '']) => decodeMySQLStringLiteral(body))
}

function readEnumColumns(columns: readonly ColumnRow[]): DatabaseEnumCheckStructure[] {
  return columns.flatMap(column => /^enum\(/i.test(column.column_type)
    ? [{ column: column.name, values: readMySQLStringLiterals(column.column_type.slice(5, -1)) }]
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
    constraint: entry.unique,
    columns: entry.columns,
    representable: entry.representable,
  }))
}

export function createMySQLSchemaReader(connection: DatabaseContext): DialectSchemaReader {
  const configuredSchema = connection.getSchemaName() ?? null
  const introspect = createIntrospect(connection)

  return {
    async listTables() {
      const result = await introspect<TableNameRow>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${SCHEMA_BINDING} AND ${BASE_TABLE_FILTER} ORDER BY table_name`, [configuredSchema], 'schema:introspect:tables')
      return result.rows.map(row => row.name).sort()
    },

    async resolveTableSchema(tableName) {
      const { schema, table } = splitTablePath(tableName)
      const result = await introspect<TableSchemaRow>(`SELECT table_schema AS table_schema FROM information_schema.tables WHERE table_schema = ${SCHEMA_BINDING} AND table_name = ? AND ${BASE_TABLE_FILTER}`, [schema ?? configuredSchema, table], `schema:introspect:table:${tableName}`)
      return result.rows[0]?.table_schema
    },

    async readTableStructure(tableName) {
      const { schema, table } = splitTablePath(tableName)
      const bindings = [schema ?? configuredSchema, table]
      const columns = await introspect<ColumnRow>(`SELECT table_schema AS table_schema, column_name AS name, data_type AS data_type, column_type AS column_type, is_nullable AS is_nullable, column_default AS column_default, extra AS extra, generation_expression AS generation_expression FROM information_schema.columns WHERE table_schema = ${SCHEMA_BINDING} AND table_name = ? ORDER BY ordinal_position`, bindings, `schema:introspect:columns:${tableName}`)
      const resolvedSchema = columns.rows[0]?.table_schema
      if (resolvedSchema === undefined) return undefined

      const indexes = await introspect<IndexRow>(`SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name, sub_part AS sub_part, expression AS expression FROM information_schema.statistics WHERE table_schema = ${SCHEMA_BINDING} AND table_name = ? ORDER BY index_name, seq_in_index`, bindings, `schema:introspect:indexes:${tableName}`)
      const foreignKeys = await introspect<ForeignKeyRow>(`SELECT kcu.constraint_name AS name, kcu.table_schema AS table_schema, kcu.referenced_table_schema AS referenced_schema, kcu.referenced_table_name AS table_name, kcu.column_name AS from_column, kcu.referenced_column_name AS to_column, rc.update_rule AS on_update, rc.delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = ${SCHEMA_BINDING} AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.constraint_name, kcu.ordinal_position`, bindings, `schema:introspect:foreignKeys:${tableName}`)

      const groupedIndexes = groupIndexes(indexes.rows)
      const primaryKeyColumns = groupedIndexes.find(index => index.primary)?.columns ?? []

      return {
        dialect: 'mysql',
        tableName,
        schema: resolvedSchema,
        columns: columns.rows.map(row => ({
          name: row.name,
          dataType: row.data_type,
          fullType: row.column_type,
          length: readStringLength(row.column_type),
          notNull: row.is_nullable === 'NO',
          defaultExpression: row.column_default,
          default: readColumnDefault(row),
          primaryKey: primaryKeyColumns.includes(row.name),
          autoIncrement: /\bauto_increment\b/i.test(row.extra),
          computed: readComputedColumn(row),
        })),
        primaryKeyColumns,
        indexes: groupedIndexes,
        foreignKeys: foreignKeys.rows.map(row => ({
          name: row.name,
          columns: readForeignKeyColumns(foreignKeys.rows, row.name),
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
