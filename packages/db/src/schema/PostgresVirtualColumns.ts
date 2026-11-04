import { SchemaError } from '../core/errors'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { AnyColumnDefinition } from './types'

const VIRTUAL_COLUMN_SERVER_VERSION = 180000

export class PostgresVirtualColumns {
  constructor(private readonly connection: DatabaseContext) {}

  async assertSupported(columns: readonly AnyColumnDefinition[]): Promise<void> {
    const virtualColumn = columns.find(column => column.computed?.stored === false)
    if (!virtualColumn) return
    const result = await this.connection.introspectCompiled<{ version: string }>({
      sql: 'SELECT current_setting(\'server_version_num\') AS version',
      source: 'schema:postgresServerVersion',
    })
    const version = Number(result.rows[0]?.version)
    if (Number.isNaN(version)) {
      throw new SchemaError(`PostgreSQL cannot report its server version, so the virtualAs() column "${virtualColumn.name}" cannot be checked.`)
    }
    if (version < VIRTUAL_COLUMN_SERVER_VERSION) {
      throw new SchemaError(`PostgreSQL 18 or newer is required for the virtualAs() column "${virtualColumn.name}". Use storedAs() instead.`)
    }
  }
}
