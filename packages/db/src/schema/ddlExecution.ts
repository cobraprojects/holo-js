import { advanceSchemaGeneration } from '../core/schemaGeneration'
import { isMySQLConnection } from './connectionDialect'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DDLStatement } from './ddl'

export async function executeStatements(connection: DatabaseContext, statements: readonly DDLStatement[]): Promise<void> {
  try {
    for (const statement of statements) {
      await connection.executeCompiled(statement)
    }
  } finally {
    advanceSchemaGeneration()
  }
}

export async function runAtomically(
  connection: DatabaseContext,
  callback: (connection: DatabaseContext) => Promise<void>,
): Promise<void> {
  if (isMySQLConnection(connection)) {
    await callback(connection)
    return
  }

  await connection.transaction(transaction => callback(transaction))
}
