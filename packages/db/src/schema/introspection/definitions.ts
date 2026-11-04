import { createGeneratedUniqueIndexName } from '../generatedNames'
import { splitTablePath } from '../identifiers'
import { SQLITE_AUTOINDEX_PREFIX } from './sqlite'
import { resolvePrimaryKeyColumnOrder } from '../tablePrimaryKey'
import type { AnyColumnDefinition, ForeignKeyReference, LogicalColumnKind, TableColumnsShape, TableDefinition, TableIndexDefinition } from '../types'
import type { DatabaseColumnStructure, DatabaseForeignKeyStructure, DatabaseIndexStructure, DatabaseTableStructure, SchemaReadingDialect } from './types'

const TEXT_TYPES = new Set(['text', 'tinytext', 'mediumtext', 'longtext', 'clob'])
const BLOB_TYPES = new Set(['blob', 'tinyblob', 'mediumblob', 'longblob', 'bytea'])
const REAL_TYPES = new Set(['real', 'double', 'double precision', 'float', 'float4', 'float8'])
const BIG_INTEGER_TYPES = new Set(['bigint', 'bigserial', 'int8'])
const INTEGER_TYPES = new Set(['integer', 'int', 'smallint', 'mediumint', 'tinyint', 'serial', 'smallserial', 'int2', 'int4'])
const NUMBER_KINDS: ReadonlySet<LogicalColumnKind> = new Set(['id', 'integer', 'bigInteger', 'real'])

function withoutLength(type: string): string {
  return type.replace(/\s*\([^)]*\)/, '').trim()
}

function inferSQLiteAffinity(type: string): LogicalColumnKind | null {
  if (type.includes('int')) return 'integer'
  if (type.includes('char') || type.includes('clob') || type.includes('text')) return 'text'
  if (type.includes('blob')) return 'blob'
  if (type.includes('real') || type.includes('floa') || type.includes('doub')) return 'real'
  return null
}

export function inferColumnKind(dialect: SchemaReadingDialect, physicalType: string): LogicalColumnKind | null {
  const normalized = physicalType.trim().toLowerCase().replace(/\s+(?:unsigned|zerofill)\b/g, '')
  const base = withoutLength(normalized)
  if (normalized.length === 0) return null
  if (base === 'uuid') return 'uuid'
  if (base === 'json' || base === 'jsonb') return 'json'
  if (base === 'vector') return 'vector'
  if (base === 'enum') return 'enum'
  if (base === 'boolean' || base === 'bool' || normalized === 'tinyint(1)') return 'boolean'
  if (base === 'date') return 'date'
  if (base === 'datetime') return 'datetime'
  if (base.startsWith('timestamp')) return 'timestamp'
  if (base.startsWith('time') || base === 'year') return 'string'
  if (REAL_TYPES.has(base)) return 'real'
  if (base === 'numeric' || base === 'decimal') return 'decimal'
  if (BLOB_TYPES.has(base) || base === 'binary' || base === 'varbinary') return 'blob'
  if (TEXT_TYPES.has(base)) return 'text'
  if (dialect === 'mysql' && normalized === 'char(36)') return 'uuid'
  if (dialect === 'mysql' && normalized === 'char(26)') return 'ulid'
  if (base === 'varchar' || base === 'character varying' || base === 'character' || base === 'char' || base === 'nvarchar' || base === 'nchar') return 'string'
  if (BIG_INTEGER_TYPES.has(base)) return 'bigInteger'
  if (INTEGER_TYPES.has(base)) return 'integer'
  return dialect === 'sqlite' ? inferSQLiteAffinity(base) : null
}

function readVectorDimensions(fullType: string): number | undefined {
  const match = fullType.match(/^vector\((\d+)\)$/i)
  return match ? Number(match[1]) : undefined
}

function readNumericLiteral(text: string): number | string {
  const value = Number(text)
  return text.trim() !== '' && Number.isFinite(value) ? value : text
}

function readJsonLiteral(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function coerceDefaultValue(kind: LogicalColumnKind, value: string | boolean | null): unknown {
  if (typeof value !== 'string') return value
  if (kind === 'boolean') return ['1', 't', 'true'].includes(value.toLowerCase())
  if (NUMBER_KINDS.has(kind)) return readNumericLiteral(value)
  if (kind === 'json') return readJsonLiteral(value)
  return value
}

function normalizeReferentialAction(action: string): string | undefined {
  const normalized = action.toLowerCase()
  return normalized === 'no action' ? undefined : normalized
}

function toForeignKeyReference(foreignKey: DatabaseForeignKeyStructure): ForeignKeyReference {
  const onDelete = normalizeReferentialAction(foreignKey.onDelete)
  const onUpdate = normalizeReferentialAction(foreignKey.onUpdate)
  return {
    table: foreignKey.table,
    column: foreignKey.to,
    ...(foreignKey.name ? { constraintName: foreignKey.name } : {}),
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
  }
}

function conventionalUniqueNames(structure: DatabaseTableStructure, columnName: string): string[] {
  const { table } = splitTablePath(structure.tableName)
  const tableNames = new Set([structure.tableName, table, ...(structure.schema ? [`${structure.schema}.${table}`] : [])])
  return [...tableNames].map(tableName => createGeneratedUniqueIndexName(tableName, [columnName]))
}

function isUniqueColumnIndex(structure: DatabaseTableStructure, index: DatabaseIndexStructure): boolean {
  const [columnName] = index.columns
  if (!index.unique || index.primary || !index.representable || index.columns.length !== 1 || !columnName) return false
  const { table } = splitTablePath(structure.tableName)
  return conventionalUniqueNames(structure, columnName).includes(index.name)
    || index.name === `${table}_${columnName}_key`
    || index.name === columnName
    || index.name.startsWith(SQLITE_AUTOINDEX_PREFIX)
}

function toColumnDefinition(
  structure: DatabaseTableStructure,
  column: DatabaseColumnStructure,
  uniqueColumns: ReadonlySet<string>,
): AnyColumnDefinition {
  const enumValues = structure.enumChecks.find(check => check.column === column.name)?.values
  const inferredKind = inferColumnKind(structure.dialect, column.fullType) ?? 'text'
  const kind: LogicalColumnKind = column.autoIncrement && column.primaryKey
    ? 'id'
    : enumValues ? 'enum' : inferredKind
  const foreignKey = structure.foreignKeys.find(candidate => candidate.from === column.name)
  const vectorDimensions = kind === 'vector' ? readVectorDimensions(column.fullType) : undefined
  const columnDefault = column.default

  return {
    kind,
    name: column.name,
    nullable: !column.notNull && !column.primaryKey,
    hasDefault: columnDefault.kind !== 'none',
    generated: column.autoIncrement || column.computed !== undefined,
    primaryKey: column.primaryKey,
    unique: uniqueColumns.has(column.name),
    ...(columnDefault.kind === 'now' ? { defaultKind: 'now' as const } : {}),
    ...(columnDefault.kind === 'literal' ? { defaultKind: 'value' as const, defaultValue: coerceDefaultValue(kind, columnDefault.value) } : {}),
    ...(columnDefault.kind === 'expression' ? { defaultKind: 'expression' as const, defaultValue: columnDefault.sql } : {}),
    ...(foreignKey ? { references: toForeignKeyReference(foreignKey) } : {}),
    ...(column.autoIncrement ? { idStrategy: 'autoIncrement' as const } : {}),
    ...(enumValues ? { enumValues } : {}),
    ...(vectorDimensions ? { vectorDimensions } : {}),
    ...(column.computed ? { computed: column.computed } : {}),
    ...(column.computed && column.notNull ? { explicitNotNull: true as const } : {}),
  }
}

export function toTableDefinition(structure: DatabaseTableStructure): TableDefinition {
  const uniqueIndexes = structure.indexes.filter(index => isUniqueColumnIndex(structure, index))
  const uniqueColumns = new Set(uniqueIndexes.flatMap(index => index.columns))
  const columns: TableColumnsShape = Object.fromEntries(structure.columns.map(column => [
    column.name,
    toColumnDefinition(structure, column, uniqueColumns),
  ]))
  const indexes: TableIndexDefinition[] = structure.indexes
    .filter(index => index.representable && !index.primary && !uniqueIndexes.includes(index))
    .map(index => ({ name: index.name, columns: [...index.columns], unique: index.unique }))
  const primaryKeyColumns = resolvePrimaryKeyColumnOrder(structure.tableName, columns, structure.primaryKeyColumns)

  return {
    kind: 'table',
    tableName: structure.tableName,
    columns,
    indexes,
    ...(primaryKeyColumns ? { primaryKeyColumns } : {}),
  }
}
