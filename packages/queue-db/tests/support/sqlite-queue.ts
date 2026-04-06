import {
  DB,
  configureDB,
  createAdapter,
  createConnectionManager,
  createDialect,
  createSchemaService,
  resetDB,
  type ConnectionManager,
  type DatabaseContext,
} from '@holo-js/db'
import {
  configureQueueRuntime,
  queueRuntimeInternals,
  resetQueueRuntime,
  type QueueAsyncDriver,
  type HoloQueueConfig,
} from '@holo-js/queue'
import { createQueueDbRuntimeOptions, queueDatabaseInternals } from '../../src'

type SQLiteQueueHarnessOptions = {
  readonly createFailedTable?: boolean
  readonly queueConfig?: HoloQueueConfig
  readonly tableName?: string
  readonly failedTableName?: string
}

export type SQLiteQueueHarness = {
  readonly connection: DatabaseContext
  readonly driver: QueueAsyncDriver
  readonly failedTableName: string
  readonly manager: ConnectionManager
  readonly tableName: string
  readFailedRows(): Promise<readonly Record<string, unknown>[]>
  readJobRows(): Promise<readonly Record<string, unknown>[]>
  cleanup(): Promise<void>
}

export async function createSQLiteQueueHarness(
  options: SQLiteQueueHarnessOptions = {},
): Promise<SQLiteQueueHarness> {
  const tableName = options.tableName ?? 'jobs'
  const failedTableName = options.failedTableName ?? 'failed_jobs'
  const manager = createConnectionManager({
    defaultConnection: 'default',
    connections: {
      default: {
        adapter: createAdapter('sqlite', { database: ':memory:' }),
        dialect: createDialect('sqlite'),
      },
    },
  })

  configureDB(manager)
  await manager.initializeAll()

  const connection = DB.connection('default')
  const schema = createSchemaService(connection)

  await schema.createTable(tableName, (table) => {
    table.string('id').primaryKey()
    table.string('job')
    table.string('connection')
    table.string('queue')
    table.text('payload')
    table.integer('attempts').default(0)
    table.integer('max_attempts').default(1)
    table.bigInteger('available_at')
    table.bigInteger('reserved_at').nullable()
    table.string('reservation_id').nullable()
    table.bigInteger('created_at')
  })

  if (options.createFailedTable === true) {
    await schema.createTable(failedTableName, (table) => {
      table.string('id').primaryKey()
      table.string('job_id')
      table.string('job')
      table.string('connection')
      table.string('queue')
      table.text('payload')
      table.text('exception')
      table.bigInteger('failed_at')
    })
  }

  configureQueueRuntime({
    config: options.queueConfig ?? {
      default: 'database',
      failed: options.createFailedTable === true
        ? {
            driver: 'database',
            connection: 'default',
            table: failedTableName,
          }
        : false,
      connections: {
        database: {
          driver: 'database',
          connection: 'default',
          table: tableName,
          queue: 'default',
        },
      },
    },
    ...createQueueDbRuntimeOptions(),
  })

  const driver = queueRuntimeInternals.resolveConnectionDriver('database')
  if (driver.mode !== 'async') {
    throw new Error('Expected an async database queue driver.')
  }

  const readRows = async (path: string): Promise<readonly Record<string, unknown>[]> => {
    const quotedTable = queueDatabaseInternals.quoteIdentifierPath(connection.getDialect(), path)
    const result = await connection.queryCompiled<Record<string, unknown>>({
      sql: `SELECT * FROM ${quotedTable} ORDER BY id ASC`,
      source: `test:queue:${path}:rows`,
    })
    return Object.freeze(result.rows)
  }

  return {
    connection,
    driver,
    failedTableName,
    manager,
    tableName,
    readFailedRows() {
      return readRows(failedTableName)
    },
    readJobRows() {
      return readRows(tableName)
    },
    async cleanup() {
      try {
        await manager.disconnectAll()
      } finally {
        resetDB()
        resetQueueRuntime()
      }
    },
  }
}
