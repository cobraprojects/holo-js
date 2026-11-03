import { CapabilityError } from '../core/errors'
import { isMySQLConnection, isPostgresConnection, isSQLiteConnection } from './connectionDialect'
import { MySQLSchemaCompiler } from './MySQLSchemaCompiler'
import { PostgresSchemaCompiler } from './PostgresSchemaCompiler'
import { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SQLSchemaCompiler } from './SQLSchemaCompiler'

function quoteIdentifierFor(connection: DatabaseContext): (identifier: string) => string {
  return identifier => connection.getDialect().quoteIdentifier(identifier)
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
