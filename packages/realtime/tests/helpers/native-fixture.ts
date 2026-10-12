import { createDialect, type DriverQueryResult } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { onTestFinished } from 'vitest'

type FixtureRow = Readonly<Record<string, string | number | boolean | null>>
type FixtureColumn = 'INTEGER' | 'REAL' | 'TEXT'

export async function createNativeRelationalAdapter(
  tables: Readonly<Record<string, readonly FixtureRow[]>>,
  definitions: Readonly<Record<string, Readonly<Record<string, FixtureColumn>>>> = {},
) {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const quote = createDialect('sqlite').quoteIdentifier
  for (const [tableName, rows] of Object.entries(tables)) {
    const names = [...new Set([...Object.keys(definitions[tableName] ?? {}), ...rows.flatMap(row => Object.keys(row))])]
    if (names.length === 0) throw new Error(`Native fixture ${tableName} requires column definitions.`)
    const columns = names.map(name => {
      const values = rows.map(row => row[name]).filter(value => value !== null && value !== undefined)
      const type = definitions[tableName]?.[name] ?? (values.every(value => typeof value === 'number' || typeof value === 'boolean')
        ? values.some(value => typeof value === 'number' && !Number.isInteger(value)) ? 'REAL' : 'INTEGER'
        : 'TEXT')
      return `${quote(name)} ${type}${name === 'id' ? ' PRIMARY KEY' : ''}`
    })
    await adapter.execute(`CREATE TABLE ${quote(tableName)} (${columns.join(', ')})`)
    for (const row of rows) {
      const keys = Object.keys(row)
      await adapter.execute(`INSERT INTO ${quote(tableName)} (${keys.map(quote).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(key => typeof row[key] === 'boolean' ? Number(row[key]) : row[key]))
    }
  }
  const queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  const executions: Array<{ sql: string, bindings: readonly unknown[] }> = []
  const query = adapter.query.bind(adapter)
  const execute = adapter.execute.bind(adapter)
  adapter.query = async <TRow extends Record<string, unknown>>(sql: string, bindings: readonly unknown[] = []): Promise<DriverQueryResult<TRow>> => {
    queries.push({ sql, bindings })
    return query<TRow>(sql, bindings)
  }
  adapter.execute = async (sql, bindings = []) => {
    executions.push({ sql, bindings })
    return execute(sql, bindings)
  }
  return Object.assign(adapter, { queries, executions })
}
