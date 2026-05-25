import {
  createCapabilities,
  DatabaseContext,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
} from '@holo-js/db'

type QueueDatabaseContextMockOptions = {
  readonly connectionName?: string
  readonly dialect?: Dialect
  readonly execute?: (sql: string, bindings: readonly unknown[]) => Promise<DriverExecutionResult>
  readonly query?: <TRow extends Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[],
  ) => Promise<DriverQueryResult<TRow>>
}

export function createQueueTestDialect(
  name: string,
  placeholderPrefix: '$' | '?' = '?',
): Dialect {
  return {
    name,
    capabilities: createCapabilities({
      savepoints: true,
      jsonValueQuery: true,
      jsonContains: true,
      jsonLength: true,
      schemaQualifiedIdentifiers: true,
    }),
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return placeholderPrefix === '$' ? `$${index}` : '?'
    },
  }
}

export function createQueueDatabaseContextMock(
  options: QueueDatabaseContextMockOptions = {},
): DatabaseContext {
  let connected = true
  const adapter: DriverAdapter = {
    async initialize() {
      connected = true
    },
    async disconnect() {
      connected = false
    },
    isConnected() {
      return connected
    },
    async query<TRow extends Record<string, unknown>>(
      sql: string,
      bindings: readonly unknown[] = [],
    ): Promise<DriverQueryResult<TRow>> {
      return options.query
        ? options.query(sql, bindings)
        : { rows: [], rowCount: 0 }
    },
    async execute(
      sql: string,
      bindings: readonly unknown[] = [],
    ): Promise<DriverExecutionResult> {
      return options.execute ? options.execute(sql, bindings) : {}
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  }

  return new DatabaseContext({
    connectionName: options.connectionName ?? 'default',
    dialect: options.dialect ?? createQueueTestDialect('sqlite'),
    adapter,
  })
}
