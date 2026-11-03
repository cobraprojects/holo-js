import { parseSqlDefault } from './defaults'
import { readStringLength, readStringLiterals } from './sqlDefinitions'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { DatabaseEnumCheckStructure, DialectSchemaReader } from './types'

type TableNameRow = { name: string }
type TableRow = { schema: string }
type ColumnRow = { name: string, data_type: string, full_type: string, not_null: boolean, default_value: string | null, is_identity: boolean, is_computed: boolean, primary_key: boolean }
type IndexRow = { name: string, is_unique: boolean, is_primary: boolean, representable: boolean, columns: string[] }
type ForeignKeyRow = { name: string, owner_schema: string, table_schema: string, table_name: string, from_column: string, to_column: string, on_update: string, on_delete: string }
type CheckRow = { name: string, column_name: string, definition: string }

const SCHEMA_BINDING = 'COALESCE($1::text, current_schema())'

const TABLE_RELATION = `
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = ${SCHEMA_BINDING} AND t.relname = $2 AND t.relkind IN ('r', 'p')`

const COLUMNS_SQL = `SELECT a.attname AS name,
  COALESCE(ic.data_type, pg_catalog.format_type(a.atttypid, a.atttypmod)) AS data_type,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS full_type,
  a.attnotnull AS not_null,
  pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
  a.attidentity <> '' AS is_identity,
  a.attgenerated <> '' AS is_computed,
  EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = t.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS primary_key
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  LEFT JOIN information_schema.columns ic ON ic.table_schema = n.nspname AND ic.table_name = t.relname AND ic.column_name = a.attname
  WHERE n.nspname = ${SCHEMA_BINDING} AND t.relname = $2 AND t.relkind IN ('r', 'p')
  ORDER BY a.attnum`

const INDEXES_SQL = `SELECT ic.relname AS name,
  i.indisunique AS is_unique,
  i.indisprimary AS is_primary,
  (i.indexprs IS NULL AND i.indpred IS NULL) AS representable,
  ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, position) JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.position) AS columns
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = ${SCHEMA_BINDING} AND t.relname = $2
  ORDER BY ic.relname`

const FOREIGN_KEYS_SQL = `SELECT con.conname AS name,
  n.nspname AS owner_schema,
  fn.nspname AS table_schema,
  ft.relname AS table_name,
  a.attname AS from_column,
  fa.attname AS to_column,
  con.confupdtype AS on_update,
  con.confdeltype AS on_delete
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_class ft ON ft.oid = con.confrelid
  JOIN pg_catalog.pg_namespace fn ON fn.oid = ft.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(from_attnum, to_attnum, position)
  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.from_attnum
  JOIN pg_catalog.pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.to_attnum
  WHERE con.contype = 'f' AND n.nspname = ${SCHEMA_BINDING} AND t.relname = $2
  ORDER BY con.conname, k.position`

const CHECKS_SQL = `SELECT con.conname AS name,
  a.attname AS column_name,
  pg_catalog.pg_get_constraintdef(con.oid) AS definition
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE con.contype = 'c' AND cardinality(con.conkey) = 1 AND n.nspname = ${SCHEMA_BINDING} AND t.relname = $2
  ORDER BY con.conname`

const REFERENTIAL_ACTIONS: Readonly<Record<string, string>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readEnumCheck(row: CheckRow): DatabaseEnumCheckStructure | undefined {
  const column = `(?:"${escapeRegExp(row.column_name.replaceAll('"', '""'))}"|${escapeRegExp(row.column_name)})`
  const castedColumn = `\\(*${column}\\)*(?:::[\\w\\s]+)?`
  const literal = '\'(?:[^\']|\'\')*\'(?:::[\\w\\s]+)?'
  const anyArray = new RegExp(`^CHECK \\(+${castedColumn} = ANY \\(+ARRAY\\[(${literal}(?:, ${literal})*)\\]\\)*(?:::[\\w\\s]+\\[\\])?\\)+$`)
  const single = new RegExp(`^CHECK \\(+${castedColumn} = (${literal})\\)+$`)
  const match = row.definition.match(anyArray) ?? row.definition.match(single)
  return match ? { name: row.name, column: row.column_name, values: readStringLiterals(match[1]!) } : undefined
}

function splitTableName(tableName: string): { schema: string | null, table: string } {
  const separator = tableName.lastIndexOf('.')
  return separator === -1
    ? { schema: null, table: tableName }
    : { schema: tableName.slice(0, separator), table: tableName.slice(separator + 1) }
}

export function createPostgresSchemaReader(connection: DatabaseContext): DialectSchemaReader {
  const configuredSchema = connection.getSchemaName() ?? null
  const introspect = <TRow extends Record<string, unknown>>(sql: string, bindings: readonly unknown[], source: string) =>
    connection.introspectCompiled<TRow>({ sql, bindings, source })

  return {
    async listTables() {
      const result = await introspect<TableNameRow>(`SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = ${SCHEMA_BINDING} ORDER BY tablename`, [configuredSchema], 'schema:introspect:tables')
      return result.rows.map(row => row.name).sort()
    },

    async readTableStructure(tableName) {
      const { schema, table } = splitTableName(tableName)
      const bindings = [schema ?? configuredSchema, table]
      const exists = await introspect<TableRow>(`SELECT n.nspname AS schema ${TABLE_RELATION}`, bindings, `schema:introspect:table:${tableName}`)
      const resolvedSchema = exists.rows[0]?.schema
      if (resolvedSchema === undefined) return undefined

      const columns = await introspect<ColumnRow>(COLUMNS_SQL, bindings, `schema:introspect:columns:${tableName}`)
      const indexes = await introspect<IndexRow>(INDEXES_SQL, bindings, `schema:introspect:indexes:${tableName}`)
      const foreignKeys = await introspect<ForeignKeyRow>(FOREIGN_KEYS_SQL, bindings, `schema:introspect:foreignKeys:${tableName}`)
      const checks = await introspect<CheckRow>(CHECKS_SQL, bindings, `schema:introspect:checks:${tableName}`)

      return {
        dialect: 'postgres',
        tableName,
        schema: resolvedSchema,
        columns: columns.rows.map((row) => {
          const autoIncrement = row.is_identity || (row.default_value?.startsWith('nextval(') ?? false)
          return {
            name: row.name,
            dataType: row.data_type,
            fullType: row.full_type,
            length: readStringLength(row.full_type),
            notNull: row.not_null,
            defaultExpression: row.default_value,
            default: autoIncrement ? { kind: 'none' } : parseSqlDefault(row.default_value),
            primaryKey: row.primary_key,
            autoIncrement,
            computed: row.is_computed,
          }
        }),
        indexes: indexes.rows.map(row => ({
          name: row.name,
          unique: row.is_unique,
          primary: row.is_primary,
          columns: row.columns,
          representable: row.representable,
        })),
        foreignKeys: foreignKeys.rows.map(row => ({
          name: row.name,
          table: row.table_schema === row.owner_schema ? row.table_name : `${row.table_schema}.${row.table_name}`,
          from: row.from_column,
          to: row.to_column,
          onUpdate: REFERENTIAL_ACTIONS[row.on_update] ?? 'NO ACTION',
          onDelete: REFERENTIAL_ACTIONS[row.on_delete] ?? 'NO ACTION',
        })),
        enumChecks: checks.rows.flatMap((row) => {
          const check = readEnumCheck(row)
          return check ? [check] : []
        }),
      }
    },
  }
}
