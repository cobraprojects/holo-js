import { CapabilityError } from '../core/errors'
import { assertValidIdentifierPath } from './identifiers'
import { createSchemaReader } from './introspection'
import { MySQLSchemaCompiler } from './MySQLSchemaCompiler'
import { PostgresSchemaCompiler } from './PostgresSchemaCompiler'
import { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DDLStatement } from './ddl'
import type { DatabaseTableStructure } from './introspection'
import type { SQLSchemaCompiler } from './SQLSchemaCompiler'

function quoteIdentifierFor(connection: DatabaseContext): (identifier: string) => string {
  return identifier => connection.getDialect().quoteIdentifier(identifier)
}

export function isSQLiteConnection(connection: DatabaseContext): boolean {
  return connection.getDialect().name.startsWith('sqlite')
}

export function isPostgresConnection(connection: DatabaseContext): boolean {
  return connection.getDialect().name.startsWith('postgres')
}

export function isMySQLConnection(connection: DatabaseContext): boolean {
  return connection.getDialect().name.startsWith('mysql')
}

export function createSQLiteSchemaCompiler(connection: DatabaseContext): SQLiteSchemaCompiler {
  return new SQLiteSchemaCompiler(quoteIdentifierFor(connection))
}

export function createPostgresSchemaCompiler(connection: DatabaseContext): PostgresSchemaCompiler {
  return new PostgresSchemaCompiler(quoteIdentifierFor(connection))
}

export function createSchemaCompiler(connection: DatabaseContext): SQLSchemaCompiler {
  if (isSQLiteConnection(connection)) {
    return createSQLiteSchemaCompiler(connection)
  }

  if (isPostgresConnection(connection)) {
    return createPostgresSchemaCompiler(connection)
  }

  if (isMySQLConnection(connection)) {
    return new MySQLSchemaCompiler(quoteIdentifierFor(connection))
  }

  throw new CapabilityError(
    `SchemaService does not support dialect "${connection.getDialect().name}".`,
  )
}

export async function executeStatements(connection: DatabaseContext, statements: readonly DDLStatement[]): Promise<void> {
  for (const statement of statements) {
    await connection.executeCompiled(statement)
  }
}

export function readTableStructure(connection: DatabaseContext, tableName: string): Promise<DatabaseTableStructure | undefined> {
  assertValidIdentifierPath(tableName, 'Table name')
  return createSchemaReader(connection).readTableStructure(tableName)
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
