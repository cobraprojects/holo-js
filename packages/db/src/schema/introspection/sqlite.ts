import { splitTablePath } from '../identifiers'
import { parseSqlDefault } from './defaults'
import { createIntrospect } from './introspect'
import { findStoredColumn, readEnumChecks, readForeignKeys, readGeneratedExpression, readStringLength, type IndexKeyColumn } from './sqlDefinitions'
import { parseCreateTableSql, type ForeignKeyConstraint, type StoredTable } from './sqliteDefinitionGrammar'
import { readNamesInSql, sameIdentifier, sameIdentifiers } from './sqliteTokens'
import type { DatabaseContext } from '../../core/DatabaseContext'
import type { ComputedColumn } from '../types'
import type { DatabaseColumnDefault, DatabaseForeignKeyStructure, DatabaseIndexStructure, DatabaseTableStructure, DialectSchemaReader } from './types'

type TableNameRow = { name: string }
type TableSqlRow = { name: string, sql: string | null }
type ReferencingTableRow = { name: string, parent: string }
type ColumnRow = { name: string, type: string, notnull: number, dflt_value: string | null, pk: number, hidden: number }
type IndexRow = { name: string, unique: number, origin: string, partial: number }
type IndexColumnRow = { cid: number, name: string | null }
type IndexKeyRow = { name: string, coll: string }
type ForeignKeyRow = { id: number, seq: number, table: string, from: string, to: string | null, on_update: string, on_delete: string }
type PrimaryKeyColumnRow = { name: string }

export const SQLITE_AUTOINDEX_PREFIX = 'sqlite_autoindex_'

export type SQLiteTableObject = { schema: string, type: 'index' | 'trigger', name: string, sql: string }

export type SQLiteDependentObject = { schema: string, type: 'view' | 'trigger', name: string, sql: string }

type SchemaObjectRow = SQLiteDependentObject & { tbl_name: string }

const MAIN_SCHEMA = 'main'
const BARE_IDENTIFIER_PATTERN = /^[A-Za-z_][\w$]*$/
const TEMP_SCHEMA = 'temp'

function readComputedColumn(row: ColumnRow, table: StoredTable | undefined): ComputedColumn | undefined {
  const expression = row.hidden === 2 || row.hidden === 3 ? readGeneratedExpression(table && findStoredColumn(table, row.name)) : undefined
  return expression === undefined ? undefined : { expression, stored: row.hidden === 3 }
}

function readColumnDefault(storedDefault: string | null): DatabaseColumnDefault {
  const columnDefault = parseSqlDefault(storedDefault)
  return columnDefault.kind === 'expression' && BARE_IDENTIFIER_PATTERN.test(columnDefault.sql)
    ? { kind: 'literal', value: columnDefault.sql }
    : columnDefault
}

function splitTableName(tableName: string): { schema: string, table: string } {
  const { schema = MAIN_SCHEMA, table } = splitTablePath(tableName)
  return { schema, table }
}

async function readSQLiteStoredTable(connection: DatabaseContext, tableName: string): Promise<TableSqlRow | undefined> {
  const { schema, table } = splitTableName(tableName)
  const result = await connection.introspectCompiled<TableSqlRow>({
    sql: `SELECT name, sql FROM ${connection.getDialect().quoteIdentifier(schema)}.sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE`,
    bindings: [table],
    source: `schema:introspect:table:${tableName}`,
  })
  return result.rows[0]
}

export async function readSQLiteCreateTableSql(connection: DatabaseContext, tableName: string): Promise<string | null | undefined> {
  return (await readSQLiteStoredTable(connection, tableName))?.sql
}

export async function readSQLiteStoredTableName(connection: DatabaseContext, tableName: string): Promise<string | undefined> {
  const storedName = (await readSQLiteStoredTable(connection, tableName))?.name
  const { schema } = splitTablePath(tableName)
  return storedName === undefined || schema === undefined ? storedName : `${schema}.${storedName}`
}

export async function readSQLiteTableObjects(connection: DatabaseContext, tableName: string): Promise<SQLiteTableObject[]> {
  const { schema, table } = splitTableName(tableName)
  const result = await connection.introspectCompiled<Omit<SQLiteTableObject, 'schema'>>({
    sql: `SELECT type, name, sql FROM ${connection.getDialect().quoteIdentifier(schema)}.sqlite_master WHERE tbl_name = ? COLLATE NOCASE AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`,
    bindings: [table],
    source: `schema:introspect:objects:${tableName}`,
  })
  return result.rows.map(row => ({ ...row, schema }))
}

function referencesAny(object: SchemaObjectRow, names: readonly string[]): boolean {
  return readNamesInSql(object.sql).some(referenced => names.some(name => sameIdentifier(name, referenced)))
}

function collectDependentViews(views: readonly SchemaObjectRow[], dependencies: readonly string[]): SchemaObjectRow[] {
  const dependents = views.filter(view => referencesAny(view, dependencies))
  if (dependents.length === 0) return []
  const remaining = views.filter(view => !dependents.includes(view))
  return [...dependents, ...collectDependentViews(remaining, dependents.map(view => view.name))]
}

async function readViewsAndTriggers(connection: DatabaseContext, schema: string): Promise<SchemaObjectRow[]> {
  const result = await connection.introspectCompiled<Omit<SchemaObjectRow, 'schema'>>({
    sql: `SELECT type, name, tbl_name, sql FROM ${connection.getDialect().quoteIdentifier(schema)}.sqlite_master WHERE type IN ('view', 'trigger') AND sql IS NOT NULL ORDER BY rowid`,
    source: `schema:introspect:viewsAndTriggers:${schema}`,
  })
  return result.rows.map(row => ({ ...row, schema }))
}

export async function readSQLiteDependentObjects(connection: DatabaseContext, tableName: string): Promise<SQLiteDependentObject[]> {
  const { schema, table } = splitTableName(tableName)
  const schemas = sameIdentifier(schema, TEMP_SCHEMA) ? [schema] : [schema, TEMP_SCHEMA]
  const rows: SchemaObjectRow[] = []
  for (const candidateSchema of schemas) rows.push(...await readViewsAndTriggers(connection, candidateSchema))
  const views = collectDependentViews(rows.filter(row => row.type === 'view'), [table])
  const dependencies = [table, ...views.map(view => view.name)]
  const isOwnTrigger = (row: SchemaObjectRow): boolean => sameIdentifier(row.schema, schema) && sameIdentifier(row.tbl_name, table)
  const triggers = rows.filter(row => row.type === 'trigger'
    && !isOwnTrigger(row)
    && (dependencies.some(name => sameIdentifier(name, row.tbl_name)) || referencesAny(row, dependencies)))
  return [...views, ...triggers].map(({ schema: objectSchema, type, name, sql }) => ({ schema: objectSchema, type, name, sql }))
}

export async function readSQLiteIndexKey(connection: DatabaseContext, tableName: string, indexName: string): Promise<IndexKeyColumn[]> {
  const { schema } = splitTableName(tableName)
  const result = await connection.introspectCompiled<IndexKeyRow>({
    sql: 'SELECT name, coll FROM pragma_index_xinfo(?, ?) WHERE "key" = 1 ORDER BY seqno',
    bindings: [indexName, schema],
    source: `schema:introspect:indexKey:${tableName}:${indexName}`,
  })
  return result.rows.map(row => ({ name: row.name, collation: row.coll }))
}

export async function listSQLiteReferencingTables(connection: DatabaseContext, tableName: string): Promise<string[]> {
  const { schema, table } = splitTableName(tableName)
  const result = await connection.introspectCompiled<ReferencingTableRow>({
    sql: `SELECT m.name, f."table" AS parent FROM ${connection.getDialect().quoteIdentifier(schema)}.sqlite_master m, pragma_foreign_key_list(m.name, ?) f WHERE m.type = 'table' ORDER BY m.name`,
    bindings: [schema],
    source: `schema:introspect:referencingTables:${tableName}`,
  })
  return [...new Set(result.rows.filter(row => sameIdentifier(row.parent, table)).map(row => row.name))]
}

interface ForeignKeySignature {
  readonly table: string
  readonly from: readonly string[]
  readonly to: readonly string[]
  readonly onUpdate: string
  readonly onDelete: string
}

interface DeclaredForeignKey {
  readonly name?: string
  readonly signature: ForeignKeySignature
}

function sameForeignKeySignature(left: ForeignKeySignature, right: ForeignKeySignature): boolean {
  return sameIdentifier(left.table, right.table)
    && sameIdentifiers(left.from, right.from)
    && sameIdentifiers(left.to, right.to)
    && left.onUpdate === right.onUpdate
    && left.onDelete === right.onDelete
}

function claimForeignKeyName(unclaimed: DeclaredForeignKey[], signature: ForeignKeySignature): string | undefined {
  const index = unclaimed.findIndex(declared => sameForeignKeySignature(declared.signature, signature))
  const [claimed] = index === -1 ? [] : unclaimed.splice(index, 1)
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

  async function readForeignKeyStructures(schema: string, table: string, declared: readonly ForeignKeyConstraint[]): Promise<DatabaseForeignKeyStructure[]> {
    const result = await introspect<ForeignKeyRow>('SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', [table, schema], `schema:introspect:foreignKeys:${table}`)
    const parentPrimaryKeys = new Map<string, string[]>()
    const readParentPrimaryKey = async (parent: string): Promise<string[]> => {
      const primaryKey = parentPrimaryKeys.get(parent) ?? await readPrimaryKeyColumns(schema, parent)
      parentPrimaryKeys.set(parent, primaryKey)
      return primaryKey
    }
    const declaredForeignKey = async (foreignKey: ForeignKeyConstraint): Promise<DeclaredForeignKey> => ({
      ...(foreignKey.name === undefined ? {} : { name: foreignKey.name }),
      signature: {
        table: foreignKey.references.table,
        from: foreignKey.columns,
        to: foreignKey.references.columns.length > 0 ? foreignKey.references.columns : await readParentPrimaryKey(foreignKey.references.table),
        onUpdate: foreignKey.references.onUpdate,
        onDelete: foreignKey.references.onDelete,
      },
    })
    const unclaimed: DeclaredForeignKey[] = []
    for (const foreignKey of [...declared].reverse()) unclaimed.push(await declaredForeignKey(foreignKey))

    const foreignKeys: DatabaseForeignKeyStructure[] = []
    for (const id of new Set(result.rows.map(row => row.id))) {
      const rows = result.rows.filter(row => row.id === id)
      const resolved: (ForeignKeyRow & { to: string })[] = []
      for (const row of rows) {
        const to = row.to ?? (await readParentPrimaryKey(row.table))[row.seq]
        if (to !== undefined) resolved.push({ ...row, to })
      }
      const name = rows[0] && claimForeignKeyName(unclaimed, {
        table: rows[0].table,
        from: rows.map(row => row.from),
        to: resolved.map(row => row.to),
        onUpdate: rows[0].on_update,
        onDelete: rows[0].on_delete,
      })
      const columns = rows.map(row => row.from)
      foreignKeys.push(...resolved.map(row => ({
        ...(name ? { name } : {}),
        columns,
        table: row.table,
        from: row.from,
        to: row.to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      })))
    }
    return foreignKeys
  }

  return {
    async listTables() {
      const result = await introspect<TableNameRow>('SELECT name FROM pragma_table_list WHERE schema = ? AND type IN (\'table\', \'virtual\') AND name NOT LIKE \'sqlite_%\' ORDER BY name', [MAIN_SCHEMA], 'schema:introspect:tables')
      return result.rows.map(row => row.name).sort()
    },

    async readTableStructure(tableName) {
      const { schema, table } = splitTableName(tableName)
      const createTableSql = await readSQLiteCreateTableSql(connection, tableName)
      if (createTableSql === undefined) return undefined

      const storedTable = parseCreateTableSql(createTableSql ?? '')
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
          default: readColumnDefault(row.dflt_value),
          primaryKey: row.pk > 0,
          autoIncrement: row.name === rowIdAlias,
          computed: readComputedColumn(row, storedTable),
        })),
        primaryKeyColumns: columns.rows.filter(row => row.pk > 0).sort((left, right) => left.pk - right.pk).map(row => row.name),
        indexes,
        foreignKeys: await readForeignKeyStructures(schema, table, storedTable ? readForeignKeys(storedTable) : []),
        enumChecks: storedTable ? readEnumChecks(storedTable) : [],
      }
      return structure
    },
  }
}
