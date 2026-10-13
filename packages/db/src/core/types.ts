import type { ConcurrencyOptions, DatabaseLogger, TransactionScopeKind } from '@holo-js/kernel'
export type { TransactionScopeKind, ConcurrencyOptions, QueryStartLog, QuerySuccessLog, QueryErrorLog, TransactionLog, MigrationStartLog, MigrationSuccessLog, MigrationErrorLog, SeederStartLog, SeederSuccessLog, SeederErrorLog, DatabaseLogger } from '@holo-js/kernel'
/* v8 ignore file -- type declarations only */
import type { DatabaseCapabilities } from './capabilities'
import type { SecurityPolicy } from '../security/policy'
import type { SchemaRegistry } from '../schema/SchemaRegistry'
import type { ModelRegistry } from '../model/ModelRegistry'
import type { SchedulingMode } from './QueryScheduler'

export type DatabaseDriverName = 'sqlite' | 'postgres' | 'mysql' | string
export interface DatabaseOperationOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type TransactionMode = 'deferred' | 'immediate' | 'exclusive'

export interface DatabaseTransactionOptions extends DatabaseOperationOptions {
  mode?: TransactionMode
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
  readonly supportsConcurrentTransactionScopes?: boolean
  getMutationReturningPermissionQuery?(tableName: string): CompiledStatement | undefined
  initialize(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  isDatabaseMissingError?(error: unknown): boolean
  ensureDatabaseExists?(): Promise<void>
  runWithTransactionScope?<T>(callback: () => Promise<T>): Promise<T>
  beforeMigrationTransaction?(): Promise<unknown>
  validateMigrationTransaction?(): Promise<void>
  afterMigrationTransaction?(state: unknown): Promise<void>
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
  beginTransaction(options?: DatabaseTransactionOptions): Promise<void>
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
