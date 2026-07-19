import { connectionAsyncContext, type DatabaseContext } from '@holo-js/db'

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
