import type { DatabaseContext } from '../core/DatabaseContext'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import { isMySQLConnection, isPostgresConnection, isSQLiteConnection } from './connectionDialect'
import { splitTablePath } from './identifiers'
import { readSQLiteCreateTableSql, resolveSQLiteTablePath } from './introspection/sqlite'
import { parseCreateTableSql } from './introspection/sqliteDefinitionGrammar'
import { sameIdentifier } from './introspection/sqliteTokens'

export type TextColumn = {
  readonly exact: boolean
  readonly padSpace: boolean
}

export type TextColumnCollations = {
  readonly findTextColumn: (column: string) => TextColumn | undefined
  readonly numbersMatchText: boolean
}

export type CaseInsensitiveColumns = ReadonlySet<string> | 'all' | TextColumnCollations

type MySQLColumnRow = { Field: string, Type: string, Collation: string | null }
type MySQLCreateTableRow = { 'Create Table'?: string }
type SQLiteIndexColumnRow = { name: string, coll: string | null }
type ColumnReader = (reader: DatabaseContext) => Promise<CaseInsensitiveColumns>

type CaseInsensitiveColumnsEntry = {
  readonly generation: number
  readonly columns: Promise<CaseInsensitiveColumns>
  readonly resolved?: CaseInsensitiveColumns
}

const CASE_INSENSITIVE_COLUMNS_SQL = `SELECT a.attname AS name
FROM pg_catalog.pg_attribute a
LEFT JOIN pg_catalog.pg_collation c ON c.oid = a.attcollation
WHERE a.attrelid = to_regclass($1)
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND (
    (to_jsonb(c) ->> 'collisdeterministic') = 'false'
    OR EXISTS (
      WITH RECURSIVE chain(oid) AS (
        SELECT a.atttypid
        UNION
        SELECT CASE WHEN t.typbasetype <> 0 THEN t.typbasetype ELSE t.typelem END
        FROM pg_catalog.pg_type t
        JOIN chain ON t.oid = chain.oid
        WHERE t.typbasetype <> 0 OR t.typelem <> 0
      )
      SELECT 1 FROM chain JOIN pg_catalog.pg_type ct ON ct.oid = chain.oid WHERE ct.typname = 'citext'
    )
  )`

const SQLITE_UNIQUE_INDEX_COLUMNS_SQL = `SELECT ii.name AS name, ii.coll AS coll
FROM pragma_index_list(?, ?) il, pragma_index_xinfo(il.name, ?) ii
WHERE il."unique" = 1 AND ii."key" = 1 AND ii.name IS NOT NULL`

const MYSQL_EXACT_COLLATION_PATTERN = /_bin$/i
const MYSQL_PERMANENT_TABLE_PATTERN = /^\s*CREATE\s+TABLE\b/i
const MYSQL_MEMBER_TYPE_PATTERN = /^(?:enum|set)\b/i
const LOOSE_TEXT_COLUMN: TextColumn = { exact: false, padSpace: true }

export const UNKNOWN_TEXT_COLUMNS: TextColumnCollations = {
  findTextColumn: () => LOOSE_TEXT_COLUMN,
  numbersMatchText: true,
}
const SQLITE_EXACT_COLLATION = 'BINARY'
const MAX_QUALIFIED_NAME_PARTS = 3

const entriesByConnection = new WeakMap<DatabaseContext, Map<string, CaseInsensitiveColumnsEntry>>()

function createPostgresReader(connection: DatabaseContext, tableName: string): ColumnReader | undefined {
  const parts = tableName.split('.')
  if (parts.length > MAX_QUALIFIED_NAME_PARTS) {
    return undefined
  }

  const dialect = connection.getDialect()
  return async (reader) => {
    const result = await reader.introspectCompiled<{ name: string }>({
      sql: CASE_INSENSITIVE_COLUMNS_SQL,
      bindings: [parts.map(part => dialect.quoteIdentifier(part)).join('.')],
      source: `schema:introspect:caseInsensitiveColumns:${tableName}`,
    })
    return new Set(result.rows.map(row => row.name))
  }
}

function isSQLiteExactCollation(collation: string | null | undefined): boolean {
  return collation === null || collation === undefined || sameIdentifier(collation, SQLITE_EXACT_COLLATION)
}

function createSQLiteReader(tableName: string): ColumnReader {
  return async (reader) => {
    const tablePath = await resolveSQLiteTablePath(reader, tableName)
    const createTableSql = tablePath === undefined ? undefined : await readSQLiteCreateTableSql(reader, tablePath)
    const table = createTableSql ? parseCreateTableSql(createTableSql) : undefined
    if (!tablePath || !table) {
      return 'all'
    }

    const { schema, table: storedName } = splitTablePath(tablePath)
    const indexColumns = await reader.introspectCompiled<SQLiteIndexColumnRow>({
      sql: SQLITE_UNIQUE_INDEX_COLUMNS_SQL,
      bindings: [storedName, schema, schema],
      source: `schema:introspect:uniqueIndexCollations:${tableName}`,
    })
    const looseKeyColumns = indexColumns.rows.filter(row => !isSQLiteExactCollation(row.coll)).map(row => row.name)
    const columns = table.columns.map(column => ({
      name: column.name,
      textColumn: {
        exact: column.constraints.every(constraint => constraint.kind !== 'COLLATE' || isSQLiteExactCollation(constraint.collation))
          && !looseKeyColumns.some(name => sameIdentifier(name, column.name)),
        padSpace: false,
      },
    }))
    return {
      findTextColumn: name => columns.find(column => sameIdentifier(column.name, name))?.textColumn,
      numbersMatchText: false,
    }
  }
}

function createMySQLReader(connection: DatabaseContext, tableName: string): ColumnReader {
  const { schema, table } = splitTablePath(tableName)
  const dialect = connection.getDialect()
  const configuredSchema = schema ?? connection.getSchemaName()
  const qualifiedTable = configuredSchema === undefined
    ? dialect.quoteIdentifier(table)
    : `${dialect.quoteIdentifier(configuredSchema)}.${dialect.quoteIdentifier(table)}`
  return async (reader) => {
    const created = await reader.introspectCompiled<MySQLCreateTableRow>({
      sql: `SHOW CREATE TABLE ${qualifiedTable}`,
      source: `schema:introspect:createTable:${tableName}`,
    })
    if (!MYSQL_PERMANENT_TABLE_PATTERN.test(created.rows[0]?.['Create Table'] ?? '')) {
      return 'all'
    }

    const result = await reader.introspectCompiled<MySQLColumnRow>({
      sql: `SHOW FULL COLUMNS FROM ${qualifiedTable}`,
      source: `schema:introspect:columnCollations:${tableName}`,
    })
    if (result.rows.length === 0) {
      return 'all'
    }

    const columns = new Map<string, TextColumn>()
    for (const row of result.rows) {
      if (row.Collation !== null) {
        columns.set(row.Field.toLowerCase(), {
          exact: MYSQL_EXACT_COLLATION_PATTERN.test(row.Collation) && !MYSQL_MEMBER_TYPE_PATTERN.test(row.Type),
          padSpace: true,
        })
      }
    }
    return {
      findTextColumn: name => columns.get(name.toLowerCase()),
      numbersMatchText: true,
    }
  }
}

function createColumnReader(connection: DatabaseContext, tableName: string): ColumnReader | undefined {
  if (isPostgresConnection(connection)) {
    return createPostgresReader(connection, tableName)
  }

  if (isSQLiteConnection(connection)) {
    return createSQLiteReader(tableName)
  }

  return isMySQLConnection(connection) ? createMySQLReader(connection, tableName) : undefined
}

async function readCaseInsensitiveColumns(connection: DatabaseContext, tableName: string): Promise<CaseInsensitiveColumns> {
  const read = createColumnReader(connection, tableName)
  if (!read) {
    return 'all'
  }

  try {
    return connection.getScope().kind !== 'root' || currentRootTransaction(connection)
      ? await connection.transaction(read)
      : await read(connection)
  } catch {
    return 'all'
  }
}

function storeResolved(
  entries: Map<string, CaseInsensitiveColumnsEntry>,
  tableName: string,
  generation: number,
  columns: CaseInsensitiveColumns,
): void {
  if (columns !== 'all') {
    entries.set(tableName, { generation, columns: Promise.resolve(columns), resolved: columns })
  }
}

export async function resolveCaseInsensitiveColumns(connection: DatabaseContext, tableName: string): Promise<CaseInsensitiveColumns> {
  const transaction = currentRootTransaction(connection)
  if (transaction?.schemaChanged) {
    return await readCaseInsensitiveColumns(connection, tableName)
  }

  const root = getRootDatabaseContext(connection)
  const generation = currentSchemaGeneration()
  const entries = entriesByConnection.get(root) ?? new Map<string, CaseInsensitiveColumnsEntry>()
  entriesByConnection.set(root, entries)
  const cached = entries.get(tableName)?.generation === generation ? entries.get(tableName) : undefined
  if (cached?.resolved) {
    return cached.resolved
  }

  if (transaction || connection.getScope().kind !== 'root') {
    const columns = await readCaseInsensitiveColumns(connection, tableName)
    if (currentSchemaGeneration() === generation) {
      storeResolved(entries, tableName, generation, columns)
    }
    return columns
  }

  if (cached) {
    return await cached.columns
  }

  const columns = readCaseInsensitiveColumns(connection, tableName)
  entries.set(tableName, { generation, columns })
  const resolved = await columns
  if (entries.get(tableName)?.columns === columns) {
    if (resolved === 'all') {
      entries.delete(tableName)
    } else {
      storeResolved(entries, tableName, generation, resolved)
    }
  }
  return resolved
}
