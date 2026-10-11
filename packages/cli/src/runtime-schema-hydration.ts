import { connectionAsyncContext, createDatabase, SchemaRegistry, type DatabaseContext, type TableDefinition } from '@holo-js/db'

export type SchemaHydrationMigration = {
  readonly name: string
  up(context: unknown): unknown
}

export async function replayRanMigrationsInDryRunScope(
  connection: DatabaseContext,
  migrations: readonly SchemaHydrationMigration[],
  ranNames: ReadonlySet<string>,
  context: unknown,
): Promise<void> {
  for (const migration of [...migrations].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!ranNames.has(migration.name)) {
      continue
    }

    await connectionAsyncContext.run({
      connectionName: connection.getConnectionName(),
      connection,
    }, () => migration.up(context))
  }
}

class SchemaHydrationRegistry extends SchemaRegistry {
  override register<TTable extends TableDefinition>(table: TTable): TTable {
    return this.replace(table)
  }

  override has(): boolean {
    return false
  }
}

export function createSchemaHydrationConnection(connection: DatabaseContext): DatabaseContext {
  const registry = new SchemaHydrationRegistry()
  for (const table of connection.getSchemaRegistry().list()) registry.replace(table)
  const adapter = connection.getAdapter()
  return createDatabase({
    connectionName: connection.getConnectionName(),
    driver: connection.getDriver(),
    dialect: connection.getDialect(),
    schemaName: connection.getSchemaName(),
    schemaRegistry: registry,
    security: connection.getSecurityPolicy(),
    adapter: {
      initialize: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      query: adapter.query.bind(adapter),
      introspect: async () => ({ rows: [], rowCount: 0 }),
      execute: async () => ({ affectedRows: 0 }),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      createSavepoint: async () => {},
      releaseSavepoint: async () => {},
      rollbackToSavepoint: async () => {},
    },
  })
}
