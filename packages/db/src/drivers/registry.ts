import type { DatabaseOperationOptions, DatabaseTransactionOptions, DriverAdapter, DriverExecutionResult, DriverQueryResult } from '../core/types'

export type DatabaseDriverConnection = {
  readonly url?: string
  readonly host?: string
  readonly port?: number
  readonly username?: string
  readonly password?: string
  readonly database?: string
  readonly ssl?: boolean | Record<string, unknown>
}

export type DatabaseDriverFactory = {
  readonly driver: string
  readonly supportsConcurrentTransactionScopes?: boolean
  create(connection: DatabaseDriverConnection): DriverAdapter
}

const factories = new Map<string, DatabaseDriverFactory>()

export function registerDatabaseDriverFactory(factory: DatabaseDriverFactory): void {
  const driver = factory.driver.trim()
  if (!driver || typeof factory.create !== 'function') throw new TypeError('Database driver factories require a driver name and create function.')
  const current = factories.get(driver)
  if (current && current !== factory) throw new Error(`Database driver factory "${driver}" is already registered.`)
  factories.set(driver, factory)
}

export function getDatabaseDriverFactory(driver: string): DatabaseDriverFactory | undefined {
  return factories.get(driver)
}

export function unregisterDatabaseDriverFactory(factory: DatabaseDriverFactory): void {
  if (factories.get(factory.driver.trim()) === factory) {
    factories.delete(factory.driver.trim())
  }
}

export class DeferredDatabaseDriverAdapter implements DriverAdapter {
  private adapter?: DriverAdapter
  private pending?: Promise<DriverAdapter>

  constructor(
    private readonly driver: string,
    private readonly connection: DatabaseDriverConnection,
  ) {}

  get supportsConcurrentTransactionScopes(): boolean {
    return getDatabaseDriverFactory(this.driver)?.supportsConcurrentTransactionScopes === true
  }

  private async resolve(): Promise<DriverAdapter> {
    if (this.adapter) return this.adapter
    this.pending ??= Promise.resolve().then(() => {
      const factory = getDatabaseDriverFactory(this.driver)
      if (!factory) throw new Error(`[@holo-js/db] Driver "${this.driver}" is not registered. Import its concrete driver package before initializing the database runtime.`)
      this.adapter = factory.create(this.connection)
      return this.adapter
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  async initialize(): Promise<void> { await (await this.resolve()).initialize() }
  async disconnect(): Promise<void> { if (this.adapter || this.pending) await (await this.resolve()).disconnect() }
  isConnected(): boolean { return this.adapter?.isConnected() ?? false }
  async ensureDatabaseExists(): Promise<void> { await (await this.resolve()).ensureDatabaseExists?.() }
  isDatabaseMissingError(error: unknown): boolean { return this.adapter?.isDatabaseMissingError?.(error) ?? false }
  async runWithTransactionScope<T>(callback: () => Promise<T>): Promise<T> { return (await this.resolve()).runWithTransactionScope?.(callback) ?? callback() }
  async beforeMigrationTransaction(): Promise<unknown> { return await (await this.resolve()).beforeMigrationTransaction?.() }
  async validateMigrationTransaction(): Promise<void> { await (await this.resolve()).validateMigrationTransaction?.() }
  async afterMigrationTransaction(state: unknown): Promise<void> { await (await this.resolve()).afterMigrationTransaction?.(state) }
  async introspect<TRow extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings?: readonly unknown[], options?: DatabaseOperationOptions): Promise<DriverQueryResult<TRow>> {
    const adapter = await this.resolve()
    return adapter.introspect ? adapter.introspect<TRow>(sql, bindings, options) : adapter.query<TRow>(sql, bindings, options)
  }
  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings?: readonly unknown[], options?: DatabaseOperationOptions): Promise<DriverQueryResult<TRow>> { return (await this.resolve()).query<TRow>(sql, bindings, options) }
  async execute(sql: string, bindings?: readonly unknown[], options?: DatabaseOperationOptions): Promise<DriverExecutionResult> { return (await this.resolve()).execute(sql, bindings, options) }
  async beginTransaction(options?: DatabaseTransactionOptions): Promise<void> { await (await this.resolve()).beginTransaction(options) }
  async commit(options?: DatabaseOperationOptions): Promise<void> { await (await this.resolve()).commit(options) }
  async rollback(options?: DatabaseOperationOptions): Promise<void> { await (await this.resolve()).rollback(options) }
  async createSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    const adapter = await this.resolve()
    if (!adapter.createSavepoint) throw new Error(`Database driver "${this.driver}" does not support createSavepoint().`)
    await adapter.createSavepoint(name, options)
  }
  async rollbackToSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    const adapter = await this.resolve()
    if (!adapter.rollbackToSavepoint) throw new Error(`Database driver "${this.driver}" does not support rollbackToSavepoint().`)
    await adapter.rollbackToSavepoint(name, options)
  }
  async releaseSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    const adapter = await this.resolve()
    if (!adapter.releaseSavepoint) throw new Error(`Database driver "${this.driver}" does not support releaseSavepoint().`)
    await adapter.releaseSavepoint(name, options)
  }
}

export function createDeferredDatabaseDriverAdapter(driver: string, connection: DatabaseDriverConnection): DriverAdapter {
  return new DeferredDatabaseDriverAdapter(driver, connection)
}
