import type { DatabaseContext } from '../core/DatabaseContext'
import { CompilerError } from '../core/errors'
import { MySQLQueryCompiler } from './MySQLQueryCompiler'
import { PostgresQueryCompiler } from './PostgresQueryCompiler'
import type { SQLQueryCompiler } from './SQLQueryCompiler'
import { SQLiteQueryCompiler } from './SQLiteQueryCompiler.impl'

export function createQueryCompiler(connection: DatabaseContext): SQLQueryCompiler {
  const dialect = connection.getDialect()
  const createCompiler = <TCompiler extends SQLQueryCompiler>(
    Compiler: new (
      quoteIdentifier: (value: string) => string,
      createPlaceholder: (index: number) => string,
    ) => TCompiler,
  ): TCompiler => new Compiler(
    identifier => dialect.quoteIdentifier(identifier),
    index => dialect.createPlaceholder(index),
  )

  if (dialect.name.startsWith('sqlite')) return createCompiler(SQLiteQueryCompiler)
  if (dialect.name.startsWith('postgres')) return createCompiler(PostgresQueryCompiler)
  if (dialect.name.startsWith('mysql')) return createCompiler(MySQLQueryCompiler)

  throw new CompilerError(`The active query compiler does not support dialect "${dialect.name}".`)
}
