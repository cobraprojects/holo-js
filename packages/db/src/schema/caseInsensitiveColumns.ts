import type { DatabaseContext } from '../core/DatabaseContext'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import { isMySQLConnection, isPostgresConnection, isSQLiteConnection } from './connectionDialect'
import { splitTablePath } from './identifiers'
import { readSQLiteCreateTableSql } from './introspection/sqlite'
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

type MySQLColumnRow = { name: string, data_type: string, collation_name: string | null, pad_attribute: string | null }
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

const MYSQL_COLUMN_COLLATIONS_SQL = `SELECT c.column_name AS name, c.data_type AS data_type, c.collation_name AS collation_name, l.pad_attribute AS pad_attribute
FROM information_schema.columns c
LEFT JOIN information_schema.collations l ON l.collation_name = c.collation_name
WHERE c.table_schema = COALESCE(?, DATABASE()) AND c.table_name = ?`

const MYSQL_EXACT_COLLATION_PATTERN = /_bin$/i
const MYSQL_NO_PAD = 'NO PAD'
const MYSQL_PADDED_DATA_TYPE = 'char'
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

function createSQLiteReader(tableName: string): ColumnReader {
  return async (reader) => {
    const createTableSql = await readSQLiteCreateTableSql(reader, tableName)
    const table = createTableSql ? parseCreateTableSql(createTableSql) : undefined
    if (!table) {
      return 'all'
    }

    const columns = table.columns.map(column => ({
      name: column.name,
      textColumn: {
        exact: column.constraints.every(constraint => constraint.kind !== 'COLLATE' || sameIdentifier(constraint.collation, SQLITE_EXACT_COLLATION)),
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
  return async (reader) => {
    const result = await reader.introspectCompiled<MySQLColumnRow>({
      sql: MYSQL_COLUMN_COLLATIONS_SQL,
      bindings: [schema ?? connection.getSchemaName() ?? null, table],
      source: `schema:introspect:columnCollations:${tableName}`,
    })
    if (result.rows.length === 0) {
      return 'all'
    }

    const columns = new Map<string, TextColumn>()
    for (const row of result.rows) {
      if (row.collation_name !== null) {
        columns.set(row.name.toLowerCase(), {
          exact: MYSQL_EXACT_COLLATION_PATTERN.test(row.collation_name),
          padSpace: row.data_type.toLowerCase() === MYSQL_PADDED_DATA_TYPE || row.pad_attribute?.toUpperCase() !== MYSQL_NO_PAD,
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
