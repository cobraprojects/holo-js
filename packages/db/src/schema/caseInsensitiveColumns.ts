import type { DatabaseContext } from '../core/DatabaseContext'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'

export type CaseInsensitiveColumns = ReadonlySet<string> | 'all'

type CaseInsensitiveColumnsEntry = {
  readonly generation: number
  readonly columns: Promise<CaseInsensitiveColumns>
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

  try {
    const dialect = connection.getDialect()
    const result = await connection.introspectCompiled<{ name: string }>({
      sql: CASE_INSENSITIVE_COLUMNS_SQL,
      bindings: [parts.map(part => dialect.quoteIdentifier(part)).join('.')],
      source: `schema:introspect:caseInsensitiveColumns:${tableName}`,
    })
    return new Set(result.rows.map(row => row.name))
  } catch {
    return 'all'
  }
}

export async function resolveCaseInsensitiveColumns(connection: DatabaseContext, tableName: string): Promise<CaseInsensitiveColumns> {
  if (currentRootTransaction(connection)?.schemaChanged) {
    return await readCaseInsensitiveColumns(connection, tableName)
  }

  const root = getRootDatabaseContext(connection)
  const generation = currentSchemaGeneration()
  const entries = entriesByConnection.get(root) ?? new Map<string, CaseInsensitiveColumnsEntry>()
  entriesByConnection.set(root, entries)
  const cached = entries.get(tableName)
  if (cached && cached.generation === generation) {
    return await cached.columns
  }

  const columns = readCaseInsensitiveColumns(connection, tableName)
  entries.set(tableName, { generation, columns })
  const resolved = await columns
  if (resolved === 'all' && entries.get(tableName)?.columns === columns) {
    entries.delete(tableName)
  }
  return resolved
}
