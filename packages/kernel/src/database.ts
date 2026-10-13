export type TransactionScopeKind = 'root' | 'transaction' | 'savepoint'

export interface ConcurrencyOptions {
  maxConcurrentQueries?: number
  queueLimit?: number
  workerThreads?: boolean
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

