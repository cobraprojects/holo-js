import type { DatabaseContext } from '../core/DatabaseContext'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'

export type CaseInsensitiveColumns = ReadonlySet<string> | 'all'

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

const MAX_QUALIFIED_NAME_PARTS = 3

const entriesByConnection = new WeakMap<DatabaseContext, Map<string, CaseInsensitiveColumnsEntry>>()

async function readCaseInsensitiveColumns(connection: DatabaseContext, tableName: string): Promise<CaseInsensitiveColumns> {
  const parts = tableName.split('.')
  if (parts.length > MAX_QUALIFIED_NAME_PARTS) {
    return 'all'
  }

  const dialect = connection.getDialect()
  const read = (reader: DatabaseContext) => reader.introspectCompiled<{ name: string }>({
    sql: CASE_INSENSITIVE_COLUMNS_SQL,
    bindings: [parts.map(part => dialect.quoteIdentifier(part)).join('.')],
    source: `schema:introspect:caseInsensitiveColumns:${tableName}`,
  })
  try {
    const result = connection.getScope().kind !== 'root' || currentRootTransaction(connection)
      ? await connection.transaction(read)
      : await read(connection)
    return new Set(result.rows.map(row => row.name))
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
