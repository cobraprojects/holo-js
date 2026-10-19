import { createSchemaService } from '../schema/SchemaService'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { TableDefinitionBuilder } from '../schema/TableDefinitionBuilder'

export async function ensureMigrationTable<TName extends string>(
  connection: DatabaseContext,
  tableName: TName,
  callback: (table: TableDefinitionBuilder<TName>) => void,
): Promise<void> {
  const schema = createSchemaService(connection)
  if (await schema.hasTable(tableName)) {
    return
  }

  try {
    await schema.createTable(tableName, callback)
  } catch (error) {
    if (await schema.hasTable(tableName)) {
      return
    }

    throw error
  }
}
