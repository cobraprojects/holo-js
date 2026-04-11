import { connectionAsyncContext } from '../concurrency/AsyncConnectionContext'
import { ConfigurationError } from '../core/errors'
import { unsafeSql } from '../core/unsafe'
import { resetMorphRegistry } from '../model/morphRegistry'
import { TableQueryBuilder } from '../query/TableQueryBuilder'
import type { ConnectionManager } from '../connection/ConnectionManager'
import type { DatabaseContext } from '../core/DatabaseContext'
import type {
  DatabaseOperationOptions,
  DriverExecutionResult,
  DriverQueryResult,
  UnsafeStatement,
} from '../core/types'
import type { TableDefinition } from '../schema/types'

function getDatabaseFacadeState(): {
  manager?: ConnectionManager
} {
  const runtime = globalThis as typeof globalThis & {
    __holoDatabaseFacade__?: {
      manager?: ConnectionManager
    }
  }

  runtime.__holoDatabaseFacade__ ??= {}
  return runtime.__holoDatabaseFacade__
}

class DatabaseFacade {
  configure(manager: ConnectionManager): void {
    getDatabaseFacadeState().manager = manager
  }

  reset(): void {
    getDatabaseFacadeState().manager = undefined
  }

  getManager(): ConnectionManager {
    const manager = getDatabaseFacadeState().manager
    if (!manager) {
      throw new ConfigurationError('DB facade is not configured with a ConnectionManager.')
    }

    return manager
  }

  connection(name?: string): DatabaseContext {
    if (!name) {
      const active = connectionAsyncContext.getActive()
      if (active) return active.connection
    }

    return this.getManager().connection(name)
  }

  table<TTable extends TableDefinition>(table: TTable, connectionName?: string): TableQueryBuilder<TTable>
  table(name: string, connectionName?: string): TableQueryBuilder<string>
  table(table: string | TableDefinition, connectionName?: string): TableQueryBuilder<string | TableDefinition> {
    return new TableQueryBuilder(table, this.connection(connectionName))
  }

  raw(sql: string, bindings: readonly unknown[] = [], source?: string): UnsafeStatement {
    return unsafeSql(sql, bindings, source)
  }

  async transaction<T>(
    callback: (connection: DatabaseContext) => Promise<T>,
    connectionName?: string,
    options?: DatabaseOperationOptions,
  ): Promise<T> {
    const target = this.connection(connectionName)

    return target.transaction(tx => connectionAsyncContext.run({
      connectionName: tx.getConnectionName(),
      connection: tx,
    }, () => callback(tx)), options)
  }

  afterCommit(callback: () => void | Promise<void>, connectionName?: string): void {
    this.connection(connectionName).afterCommit(callback)
  }

  afterRollback(callback: () => void | Promise<void>, connectionName?: string): void {
    this.connection(connectionName).afterRollback(callback)
  }

  async unsafeQuery<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: UnsafeStatement,
    connectionName?: string,
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>> {
    return this.connection(connectionName).unsafeQuery<TRow>(statement, options)
  }

  async unsafeExecute(
    statement: UnsafeStatement,
    connectionName?: string,
    options?: DatabaseOperationOptions,
  ): Promise<DriverExecutionResult> {
    return this.connection(connectionName).unsafeExecute(statement, options)
  }
}

export const DB = new DatabaseFacade()

export function configureDB(manager: ConnectionManager): void {
  DB.configure(manager)
}

export function resetDB(): void {
  DB.reset()
  resetMorphRegistry()
}
