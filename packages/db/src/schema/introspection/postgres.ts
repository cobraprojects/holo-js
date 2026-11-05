import { parseSqlDefault } from './defaults'
import { splitTablePath } from '../identifiers'
import { createIntrospect } from './introspect'
import { readForeignKeyColumns, readStringLength, readStringLiterals } from './sqlDefinitions'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { ComputedColumn } from '../types'
import type { DatabaseEnumCheckStructure, DialectSchemaReader } from './types'

type TableNameRow = { name: string }
type TableRow = { schema: string }
type ColumnRow = { name: string, data_type: string, full_type: string, not_null: boolean, default_value: string | null, is_identity: boolean, generated_kind: string, primary_key_position: number | null }
type IndexRow = { name: string, is_unique: boolean, is_primary: boolean, is_constraint: boolean, representable: boolean, columns: string[] }
type ForeignKeyRow = { name: string, owner_schema: string, table_schema: string, table_name: string, from_column: string, to_column: string, on_update: string, on_delete: string }
type CheckRow = { name: string, column_name: string, definition: string }

const SCHEMA_BINDING = 'COALESCE($1::text, current_schema())'

const TABLE_FILTER = `n.nspname = ${SCHEMA_BINDING} AND t.relname = $2`

const TABLE_RELATION = `FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace`

const TABLE_RELATION_FILTER = `${TABLE_FILTER} AND t.relkind IN ('r', 'p')`

const COLUMNS_SQL = `SELECT a.attname AS name,
  COALESCE(ic.data_type, pg_catalog.format_type(a.atttypid, a.atttypmod)) AS data_type,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS full_type,
  a.attnotnull AS not_null,
  pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
  a.attidentity <> '' AS is_identity,
  a.attgenerated::text AS generated_kind,
  (SELECT array_position(con.conkey, a.attnum) FROM pg_catalog.pg_constraint con WHERE con.conrelid = t.oid AND con.contype = 'p') AS primary_key_position
  ${TABLE_RELATION}
  JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  LEFT JOIN information_schema.columns ic ON ic.table_schema = n.nspname AND ic.table_name = t.relname AND ic.column_name = a.attname
  WHERE ${TABLE_RELATION_FILTER}
  ORDER BY a.attnum`

const INDEXES_SQL = `SELECT ic.relname AS name,
  i.indisunique AS is_unique,
  i.indisprimary AS is_primary,
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p', 'u', 'x')) AS is_constraint,
  (i.indexprs IS NULL AND i.indpred IS NULL) AS representable,
  ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, position) JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum WHERE k.position <= i.indnkeyatts ORDER BY k.position) AS columns
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE ${TABLE_FILTER}
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
  WHERE con.contype = 'f' AND ${TABLE_FILTER}
  ORDER BY con.conname, k.position`

const CHECKS_SQL = `SELECT con.conname AS name,
  a.attname AS column_name,
  pg_catalog.pg_get_constraintdef(con.oid) AS definition
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE con.contype = 'c' AND cardinality(con.conkey) = 1 AND ${TABLE_FILTER}
  ORDER BY con.conname`

const REFERENTIAL_ACTIONS: Readonly<Record<string, string>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
}

function readComputedColumn(row: ColumnRow): ComputedColumn | undefined {
  return row.generated_kind === '' || row.default_value === null
    ? undefined
    : { expression: row.default_value, stored: row.generated_kind === 's' }
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
  const literals = (row.definition.match(anyArray) ?? row.definition.match(single))?.[1]
  return literals === undefined ? undefined : { name: row.name, column: row.column_name, values: readStringLiterals(literals) }
}

export function createPostgresSchemaReader(connection: DatabaseContext): DialectSchemaReader {
  const introspect = createIntrospect(connection)

  return {
    async listTables() {
      const result = await introspect<TableNameRow>('SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = current_schema() ORDER BY tablename', [], 'schema:introspect:tables')
      return result.rows.map(row => row.name).sort()
    },

    async readTableStructure(tableName) {
      const { schema, table } = splitTablePath(tableName)
      const bindings = [schema ?? null, table]
      const exists = await introspect<TableRow>(`SELECT n.nspname AS schema ${TABLE_RELATION} WHERE ${TABLE_RELATION_FILTER}`, bindings, `schema:introspect:table:${tableName}`)
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
          const computed = readComputedColumn(row)
          return {
            name: row.name,
            dataType: row.data_type,
            fullType: row.full_type,
            length: readStringLength(row.full_type),
            notNull: row.not_null,
            defaultExpression: computed ? null : row.default_value,
            default: autoIncrement || computed ? { kind: 'none' } : parseSqlDefault(row.default_value),
            primaryKey: row.primary_key_position !== null,
            autoIncrement,
            computed,
          }
        }),
        primaryKeyColumns: columns.rows
          .filter(row => row.primary_key_position !== null)
          .sort((left, right) => Number(left.primary_key_position) - Number(right.primary_key_position))
          .map(row => row.name),
        indexes: indexes.rows.map(row => ({
          name: row.name,
          unique: row.is_unique,
          primary: row.is_primary,
          constraint: row.is_constraint,
          columns: row.columns,
          representable: row.representable,
        })),
        foreignKeys: foreignKeys.rows.map(row => ({
          name: row.name,
          columns: readForeignKeyColumns(foreignKeys.rows, row.name),
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

export async function readPostgresSearchPathTableSchema(connection: DatabaseContext, tableName: string): Promise<string | undefined> {
  const result = await createIntrospect(connection)<TableRow>(
    `SELECT n.nspname AS schema ${TABLE_RELATION} WHERE t.oid = pg_catalog.to_regclass(pg_catalog.quote_ident($1)) AND t.relkind IN ('r', 'p')`,
    [tableName],
    `schema:introspect:searchPath:${tableName}`,
  )
  return result.rows[0]?.schema
}
