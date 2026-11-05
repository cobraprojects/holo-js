import type { DatabaseContext } from '../core/DatabaseContext'

export function isSQLiteConnection(connection: DatabaseContext): boolean {
  return connection.getDialect().name.startsWith('sqlite')
}

export function isPostgresConnection(connection: DatabaseContext): boolean {
  return connection.getDialect().name.startsWith('postgres')
}

export function isMySQLConnection(connection: DatabaseContext): boolean {
  return connection.getDialect().name.startsWith('mysql')
}

export function textMatchesAnyNumber(connection: DatabaseContext): boolean {
  return !isPostgresConnection(connection) && !isSQLiteConnection(connection)
}
