import {
  DatabaseContext,
  createCapabilities,
  type CompiledStatement,
  type DatabaseOperationOptions,
  type DatabaseTransactionOptions,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
} from '@holo-js/db'

export type RecordedQuery = {
  readonly sql: string
  readonly bindings: readonly unknown[]
}

export type FakeDatabase = {
  readonly connection: DatabaseContext
  readonly queries: readonly RecordedQuery[]
}

export function createFakeDatabase(
  readRows: (statement: CompiledStatement) => readonly Readonly<Record<string, unknown>>[],
): FakeDatabase {
  const queries: RecordedQuery[] = []
  const dialect: Dialect = {
    name: 'sqlite',
    capabilities: createCapabilities(),
    quoteIdentifier(identifier) {
      return `"${identifier.replaceAll('"', '""')}"`
    },
    createPlaceholder() {
      return '?'
    },
  }
  const adapter: DriverAdapter = {
    async initialize(): Promise<void> {},
    async disconnect(): Promise<void> {},
    isConnected(): boolean {
      return true
    },
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      bindings: readonly unknown[] = [],
      _options?: DatabaseOperationOptions,
    ): Promise<DriverQueryResult<TRow>> {
      const statement = { sql, bindings } satisfies CompiledStatement
      queries.push(statement)
      const rows = readRows(statement).map(row => ({ ...row })) as TRow[]
      return {
        rowCount: rows.length,
        rows,
      }
    },
    async execute(
      _sql: string,
      _bindings?: readonly unknown[],
      _options?: DatabaseOperationOptions,
    ): Promise<DriverExecutionResult> {
      return { affectedRows: 0 }
    },
    async beginTransaction(_options?: DatabaseTransactionOptions): Promise<void> {},
    async commit(_options?: DatabaseOperationOptions): Promise<void> {},
    async rollback(_options?: DatabaseOperationOptions): Promise<void> {},
  }

  return {
    connection: new DatabaseContext({
      adapter,
      connectionName: 'main',
      dialect,
      driver: 'sqlite',
    }),
    queries,
  }
}
