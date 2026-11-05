import type { DatabaseContext } from '../core/DatabaseContext'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentSchemaGeneration } from '../core/schemaGeneration'

export type CaseInsensitiveColumns = ReadonlySet<string> | 'all'

type CaseInsensitiveColumnsEntry = {
  readonly generation: number
  readonly columns: Promise<CaseInsensitiveColumns>
}

const CASE_INSENSITIVE_COLUMNS_SQL = `SELECT a.attname AS name
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_catalog.pg_type b ON b.oid = t.typbasetype
LEFT JOIN pg_catalog.pg_collation c ON c.oid = a.attcollation
WHERE a.attrelid = to_regclass($1)
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND (t.typname = 'citext' OR b.typname = 'citext' OR c.collisdeterministic = false)`

const entriesByConnection = new WeakMap<DatabaseContext, Map<string, CaseInsensitiveColumnsEntry>>()

function quoteTableName(connection: DatabaseContext, tableName: string): string {
  const dialect = connection.getDialect()
  return tableName.split('.').map(part => dialect.quoteIdentifier(part)).join('.')
}

async function readCaseInsensitiveColumns(connection: DatabaseContext, tableName: string): Promise<CaseInsensitiveColumns> {
  try {
    const result = await connection.introspectCompiled<{ name: string }>({
      sql: CASE_INSENSITIVE_COLUMNS_SQL,
      bindings: [quoteTableName(connection, tableName)],
      source: `schema:introspect:caseInsensitiveColumns:${tableName}`,
    })
    return new Set(result.rows.map(row => row.name))
  } catch {
    return 'all'
  }
}

export async function resolveCaseInsensitiveColumns(connection: DatabaseContext, tableName: string): Promise<CaseInsensitiveColumns> {
  const root = getRootDatabaseContext(connection)
  const generation = currentSchemaGeneration()
  const entries = entriesByConnection.get(root) ?? new Map<string, CaseInsensitiveColumnsEntry>()
  entriesByConnection.set(root, entries)
  const cached = entries.get(tableName)
  if (cached && cached.generation === generation) {
    return cached.columns
  }

  const columns = readCaseInsensitiveColumns(connection, tableName)
  entries.set(tableName, { generation, columns })
  const resolved = await columns
  if (resolved === 'all' && entries.get(tableName)?.columns === columns) {
    entries.delete(tableName)
  }
  return resolved
}
