import { createSchemaReader } from './introspection'
import { clearGeneratedTables, forgetGeneratedTable, isGeneratedSchemaConnection, registerGeneratedTables } from './generated'
import type { DatabaseContext } from '../core/DatabaseContext'

export interface GeneratedSchemaRefresh {
  refreshAll(): Promise<void>
  refreshTables(...tableNames: readonly string[]): Promise<void>
}

export function createGeneratedSchemaRefresh(connection: DatabaseContext): GeneratedSchemaRefresh {
  const reader = createSchemaReader(connection)
  const isTracked = () => isGeneratedSchemaConnection(connection.getConnectionName())

  return {
    async refreshAll() {
      if (!isTracked()) return
      const tables = await reader.readGeneratedSchema()
      clearGeneratedTables()
      registerGeneratedTables(Object.fromEntries(tables.map(table => [table.tableName, table])))
    },
    async refreshTables(...tableNames) {
      if (!isTracked()) return
      for (const tableName of tableNames) {
        const table = await reader.readGeneratedTable(tableName)
        if (table) {
          registerGeneratedTables({ [tableName]: table })
        } else {
          forgetGeneratedTable(tableName)
        }
      }
    },
  }
}
