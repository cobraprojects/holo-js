/* v8 ignore file -- type declarations only */
import type { DatabaseCapabilities } from './capabilities'
import type { SecurityPolicy } from '../security/policy'
import type { SchemaRegistry } from '../schema/SchemaRegistry'
import type { ModelRegistry } from '../model/ModelRegistry'
import type { SchedulingMode } from './QueryScheduler'

export type DatabaseDriverName = 'sqlite' | 'postgres' | 'mysql' | string
export type TransactionScopeKind = 'root' | 'transaction' | 'savepoint'

export interface ConcurrencyOptions {
  maxConcurrentQueries?: number
  queueLimit?: number
  workerThreads?: boolean
}

export interface DatabaseOperationOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type TransactionCallback = () => void | Promise<void>

export interface UnsafeStatement {
  unsafe: true
  sql: string
  bindings?: readonly unknown[]
  source?: string
}

export type CompiledQueryKind = 'select' | 'insert' | 'update' | 'upsert' | 'delete'
export type CompiledQueryResultMode = 'rows' | 'write'
export type CompiledQueryIntent = 'read' | 'write'
export type CompiledQueryStreamingMode = 'buffered'
export type CompiledQueryTransactionAffinity = 'optional' | 'required'

export interface CompiledStatementMetadata {
  kind: CompiledQueryKind
  resultMode: CompiledQueryResultMode
  selectedShape: {
    mode: 'all' | 'projection' | 'write'
    columns: readonly string[]
    aggregates: readonly string[]
    hasRawSelections: boolean
    hasSubqueries: boolean
  }
  safety: {
    unsafe: boolean
    containsRawSql: boolean
  }
  debug: {
    tableName: string
    hasJoins: boolean
    hasUnions: boolean
    hasGrouping: boolean
    hasHaving: boolean
    complexity: number
    lockMode?: string
    intent: CompiledQueryIntent
    transactionAffinity: CompiledQueryTransactionAffinity
    streaming: CompiledQueryStreamingMode
    connectionName?: string
    scope?: TransactionScopeKind
    schedulingMode?: SchedulingMode
  }
}

export interface CompiledStatement {
  unsafe?: true
  sql: string
  bindings?: readonly unknown[]
  source?: string
  metadata?: CompiledStatementMetadata
}

export interface DriverQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  rows: TRow[]
  rowCount: number
}

export interface DriverExecutionResult {
  affectedRows?: number
  lastInsertId?: number | string
}

export interface DriverAdapter {
  initialize(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  runWithTransactionScope?<T>(callback: () => Promise<T>): Promise<T>
  introspect?<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings?: readonly unknown[],
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>>
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings?: readonly unknown[],
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>>
  execute(
    sql: string,
    bindings?: readonly unknown[],
    options?: DatabaseOperationOptions,
  ): Promise<DriverExecutionResult>
  beginTransaction(options?: DatabaseOperationOptions): Promise<void>
  commit(options?: DatabaseOperationOptions): Promise<void>
  rollback(options?: DatabaseOperationOptions): Promise<void>
  createSavepoint?(name: string, options?: DatabaseOperationOptions): Promise<void>
  rollbackToSavepoint?(name: string, options?: DatabaseOperationOptions): Promise<void>
  releaseSavepoint?(name: string, options?: DatabaseOperationOptions): Promise<void>
}

export interface Dialect {
  readonly name: string
  readonly capabilities: DatabaseCapabilities
  quoteIdentifier(identifier: string): string
  createPlaceholder(index: number): string
}

export interface QueryStartLog {
  kind: 'query' | 'execute'
  connectionName: string
  sql: string
  bindings: unknown[]
  source?: string
  scope: TransactionScopeKind
  schedulingMode?: 'concurrent' | 'serialized' | 'worker'
}

export interface QuerySuccessLog extends QueryStartLog {
  durationMs: number
  rowCount?: number
  affectedRows?: number
}

export interface QueryErrorLog extends QueryStartLog {
  durationMs: number
  error: unknown
}

export interface TransactionLog {
  scope: Exclude<TransactionScopeKind, 'root'>
  depth: number
  savepointName?: string
}

export interface MigrationStartLog {
  connectionName: string
  migrationName: string
  action: 'up' | 'down'
  batch?: number
}

export interface MigrationSuccessLog extends MigrationStartLog {
  durationMs: number
}

export interface MigrationErrorLog extends MigrationStartLog {
  durationMs: number
  error: unknown
}

export interface SeederStartLog {
  connectionName: string
  seederName: string
  quietly: boolean
  environment?: string
}

export interface SeederSuccessLog extends SeederStartLog {
  durationMs: number
}

export interface SeederErrorLog extends SeederStartLog {
  durationMs: number
  error: unknown
}

export interface DatabaseLogger {
  onQueryStart?(entry: QueryStartLog): void | Promise<void>
  onQuerySuccess?(entry: QuerySuccessLog): void | Promise<void>
  onQueryError?(entry: QueryErrorLog): void | Promise<void>
  onTransactionStart?(entry: TransactionLog): void | Promise<void>
  onTransactionCommit?(entry: TransactionLog): void | Promise<void>
  onTransactionRollback?(entry: TransactionLog & { error?: unknown }): void | Promise<void>
  onMigrationStart?(entry: MigrationStartLog): void | Promise<void>
  onMigrationSuccess?(entry: MigrationSuccessLog): void | Promise<void>
  onMigrationError?(entry: MigrationErrorLog): void | Promise<void>
  onSeederStart?(entry: SeederStartLog): void | Promise<void>
  onSeederSuccess?(entry: SeederSuccessLog): void | Promise<void>
  onSeederError?(entry: SeederErrorLog): void | Promise<void>
}

export interface DatabaseContextOptions {
  connectionName?: string
  schemaName?: string
  adapter: DriverAdapter
  dialect: Dialect
  driver?: DatabaseDriverName
  logger?: DatabaseLogger
  security?: Partial<SecurityPolicy>
  concurrency?: ConcurrencyOptions
  schemaRegistry?: SchemaRegistry
  modelRegistry?: ModelRegistry
}
