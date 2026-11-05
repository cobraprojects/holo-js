import { holoRuntimeInternals, type DatabaseContext, type SchemaService } from '@holo-js/db'

export async function dropAllTablesForFresh(
  connection: DatabaseContext,
  schema: SchemaService,
): Promise<void> {
  const tables = await schema.getTables()
  if (connection.getDialect().name === 'postgres') {
    const { quoteIdentifier } = connection.getDialect()
    const current = await connection.queryCompiled<{ schema: string }>({ sql: 'SELECT current_schema() AS schema', source: 'schema:currentSchema' })
    const schemaName = current.rows[0]?.schema
    if (!schemaName) return

    for (const tableName of tables) {
      await connection.executeCompiled({
        sql: `DROP TABLE IF EXISTS ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} CASCADE`,
        source: `schema:dropTableFresh:${schemaName}.${tableName}`,
      })
    }
    return
  }

  await schema.withoutForeignKeyConstraints(async () => {
    for (const tableName of tables) {
      await schema.dropTable(holoRuntimeInternals.listedTablePath(connection, tableName))
    }
  })
}
