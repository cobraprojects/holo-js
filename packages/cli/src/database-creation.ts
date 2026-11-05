import {
  holoRuntimeInternals,
  type CompiledStatement,
  type DatabaseDriverFactory,
  type DatabaseOperationOptions,
  type DatabaseTransactionOptions,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
} from '@holo-js/db'

class DatabaseCreatingAdapter implements DriverAdapter {
  private created?: Promise<void>

  constructor(private readonly adapter: DriverAdapter) {}

  get supportsConcurrentTransactionScopes(): boolean | undefined {
    return this.adapter.supportsConcurrentTransactionScopes
  }

  get [holoRuntimeInternals.driverConnectionKey](): DriverAdapter {
    return holoRuntimeInternals.driverConnection(this.adapter)
  }

  private createDatabaseOnFirstUse(): Promise<void> {
    this.created ??= this.createMissingDatabase().catch((error: unknown) => {
      this.created = undefined
      throw error
    })
    return this.created
  }

  private async createMissingDatabase(): Promise<void> {
    try {
      await this.adapter.query('SELECT 1')
    } catch (error) {
      if (!this.adapter.isDatabaseMissingError?.(error) || !this.adapter.ensureDatabaseExists) throw error
      await this.adapter.disconnect()
      await this.adapter.ensureDatabaseExists()
    }
  }

  getMutationReturningPermissionQuery(tableName: string): CompiledStatement | undefined { return this.adapter.getMutationReturningPermissionQuery?.(tableName) }
  initialize(): Promise<void> { return this.adapter.initialize() }
  disconnect(): Promise<void> { return this.adapter.disconnect() }
  isConnected(): boolean { return this.adapter.isConnected() }
  isDatabaseMissingError(error: unknown): boolean { return this.adapter.isDatabaseMissingError?.(error) ?? false }
  async databaseExists(): Promise<boolean> { return await this.adapter.databaseExists?.() ?? true }
  async ensureDatabaseExists(): Promise<void> { await this.adapter.ensureDatabaseExists?.() }
  async runWithTransactionScope<T>(callback: () => Promise<T>): Promise<T> {
    await this.createDatabaseOnFirstUse()
    return this.adapter.runWithTransactionScope ? this.adapter.runWithTransactionScope(callback) : callback()
  }
  async beforeMigrationTransaction(): Promise<unknown> {
    await this.createDatabaseOnFirstUse()
    return this.adapter.beforeMigrationTransaction?.()
  }
  async validateMigrationTransaction(): Promise<void> { await this.adapter.validateMigrationTransaction?.() }
  async afterMigrationTransaction(state: unknown): Promise<void> { await this.adapter.afterMigrationTransaction?.(state) }
  async introspect<TRow extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings?: readonly unknown[], options?: DatabaseOperationOptions): Promise<DriverQueryResult<TRow>> {
    await this.createDatabaseOnFirstUse()
    return this.adapter.introspect ? this.adapter.introspect<TRow>(sql, bindings, options) : this.adapter.query<TRow>(sql, bindings, options)
  }
  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings?: readonly unknown[], options?: DatabaseOperationOptions): Promise<DriverQueryResult<TRow>> {
    await this.createDatabaseOnFirstUse()
    return this.adapter.query<TRow>(sql, bindings, options)
  }
  async execute(sql: string, bindings?: readonly unknown[], options?: DatabaseOperationOptions): Promise<DriverExecutionResult> {
    await this.createDatabaseOnFirstUse()
    return this.adapter.execute(sql, bindings, options)
  }
  async beginTransaction(options?: DatabaseTransactionOptions): Promise<void> {
    await this.createDatabaseOnFirstUse()
    await this.adapter.beginTransaction(options)
  }
  commit(options?: DatabaseOperationOptions): Promise<void> { return this.adapter.commit(options) }
  rollback(options?: DatabaseOperationOptions): Promise<void> { return this.adapter.rollback(options) }
  async createSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> { await this.savepointMethod('createSavepoint')(name, options) }
  async rollbackToSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> { await this.savepointMethod('rollbackToSavepoint')(name, options) }
  async releaseSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> { await this.savepointMethod('releaseSavepoint')(name, options) }

  private savepointMethod(name: 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint'): (savepoint: string, options?: DatabaseOperationOptions) => Promise<void> {
    const method = this.adapter[name]
    if (!method) throw new Error(`The database driver does not support ${name}().`)
    return method.bind(this.adapter)
  }
}

export function createDatabasesOnFirstUse(factory: DatabaseDriverFactory): DatabaseDriverFactory {
  return Object.freeze({
    ...factory,
    create: connection => new DatabaseCreatingAdapter(factory.create(connection)),
  })
}
