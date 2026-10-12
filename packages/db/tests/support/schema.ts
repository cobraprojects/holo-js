import { SQLiteSchemaCompiler, type DatabaseContext, type TableDefinition } from '../../src'

export async function createTestTable(db: DatabaseContext, table: TableDefinition): Promise<void> {
  const compiler = new SQLiteSchemaCompiler(db.getDialect().quoteIdentifier)
  for (const statement of compiler.compileCreateTable(table)) await db.executeCompiled(statement)
}
