import { SchemaService } from '../schema/SchemaService'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { GeneratedSchemaRefresh } from '../schema/generatedSchemaRefresh'
import type { TableDefinitionBuilder } from '../schema/TableDefinitionBuilder'
import type { TableMutationBuilder } from '../schema/TableMutationBuilder'

export class MigrationSchemaService extends SchemaService {
  constructor(
    connection: DatabaseContext,
    private readonly generatedSchema: GeneratedSchemaRefresh,
  ) {
    super(connection)
  }

  override async createTable<TName extends string>(
    tableName: TName,
    callback: (table: TableDefinitionBuilder<TName>) => void | Promise<void>,
  ): Promise<void> {
    await super.createTable(tableName, callback)
    await this.generatedSchema.refreshTables(tableName)
  }

  override async dropTable(tableName: string): Promise<void> {
    await super.dropTable(tableName)
    await this.generatedSchema.refreshTables(tableName)
  }

  override async renameTable(fromTableName: string, toTableName: string): Promise<void> {
    await super.renameTable(fromTableName, toTableName)
    await this.generatedSchema.refreshTables(fromTableName, toTableName)
  }

  override async table(
    tableName: string,
    callback: (table: TableMutationBuilder) => void | Promise<void>,
  ): Promise<void> {
    await super.table(tableName, callback)
    await this.generatedSchema.refreshTables(tableName)
  }
}
