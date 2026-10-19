import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import {
  configureQueueRuntime,
  queueRuntimeInternals,
  resetQueueRuntime,
  type QueueAsyncDriver,
  type QueueReservedJob,
} from '@holo-js/queue'
import { createQueueDbRuntimeOptions } from '../src'

type ServerDriver = 'mysql' | 'postgres'

type ContentionHarness = {
  readonly control: DatabaseContext
  readonly driver: QueueAsyncDriver
  readonly table: string
  createDriver(): QueueAsyncDriver
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function connect(driver: ServerDriver): DatabaseContext {
  if (driver === 'mysql') {
    return new DatabaseContext({
      driver,
      dialect: createDialect(driver),
      adapter: createMySQLAdapter({
        config: {
          host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
          port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
          user: process.env.HOLO_MYSQL_USER ?? 'root',
          password: process.env.HOLO_MYSQL_PASSWORD,
          database: process.env.HOLO_MYSQL_DATABASE ?? 'holo_test',
        },
      }),
    })
  }

  return new DatabaseContext({
    driver,
    dialect: createDialect(driver),
    adapter: createPostgresAdapter({
      config: {
        host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
        database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
        user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
        password: process.env.HOLO_POSTGRES_PASSWORD,
      },
    }),
  })
}

async function createContentionHarness(driver: ServerDriver): Promise<ContentionHarness> {
  const table = `jobs_${randomUUID().replaceAll('-', '')}`
  const connection = connect(driver)
  const control = connect(driver)
  await connection.initialize()
  await control.initialize()
  cleanups.push(async () => {
    try {
      await control.executeCompiled({ sql: `DROP TABLE IF EXISTS ${table}`, source: 'test:queue:contention' })
    } finally {
      resetDB()
      resetQueueRuntime()
      await connection.disconnect()
      await control.disconnect()
    }
  })

  await createSchemaService(control).createTable(table, (builder) => {
    builder.string('id').primaryKey()
    builder.string('job')
    builder.string('connection')
    builder.string('queue')
    builder.text('payload')
    builder.integer('attempts').default(0)
    builder.integer('max_attempts').default(1)
    builder.bigInteger('available_at')
    builder.bigInteger('reserved_at').nullable()
    builder.string('reservation_id').nullable()
    builder.bigInteger('created_at')
  })

  configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
  configureQueueRuntime({
    config: {
      default: 'database',
      failed: false,
      connections: {
        database: { driver: 'database', connection: 'main', table, queue: 'default' },
      },
    },
    ...createQueueDbRuntimeOptions(),
  })

  const createDriver = (): QueueAsyncDriver => {
    const resolved = queueRuntimeInternals.resolveConnectionDriver('database')
    if (resolved.mode !== 'async') {
      throw new Error('Expected an async database queue driver.')
    }

    return resolved
  }

  return { control, driver: createDriver(), table, createDriver }
}

async function dispatchJobs(driver: QueueAsyncDriver, count: number): Promise<readonly string[]> {
  const createdAt = Date.now() - 1_000
  const ids = Array.from({ length: count }, (_, index) => `job-${String(index).padStart(3, '0')}`)
  for (const [index, id] of ids.entries()) {
    await driver.dispatch({
      id,
      name: 'jobs.contention',
      connection: 'database',
      queue: 'default',
      payload: { index },
      attempts: 0,
      maxAttempts: 3,
      createdAt: createdAt + index,
    })
  }

  return ids
}

function withinDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    setTimeout(milliseconds).then(() => {
      throw new Error(message)
    }),
  ])
}

const servers: readonly { readonly driver: ServerDriver, readonly enabled: boolean }[] = [
  { driver: 'mysql', enabled: process.env.HOLO_MYSQL_INTEGRATION === '1' },
  { driver: 'postgres', enabled: process.env.HOLO_POSTGRES_INTEGRATION === '1' },
]

for (const server of servers) {
  describe.runIf(server.enabled)(`@holo-js/queue-db ${server.driver} reservation contention`, () => {
    it('lets a losing worker return promptly while another worker holds the only job', async () => {
      const harness = await createContentionHarness(server.driver)
      const [jobId] = await dispatchJobs(harness.driver, 1)

      const outcome = await harness.control.transaction(async (tx) => {
        await tx.queryCompiled({
          sql: `SELECT id FROM ${harness.table} WHERE id = ${tx.getDialect().createPlaceholder(1)} FOR UPDATE`,
          bindings: [jobId],
          source: 'test:queue:contention:hold',
        })
        await tx.executeCompiled({
          sql: `UPDATE ${harness.table} SET reserved_at = ${tx.getDialect().createPlaceholder(1)}, reservation_id = 'held' WHERE id = ${tx.getDialect().createPlaceholder(2)}`,
          bindings: [Date.now(), jobId],
          source: 'test:queue:contention:hold',
        })

        return withinDeadline(
          harness.createDriver().reserve({ queueNames: ['default'], workerId: 'loser' }),
          2_000,
          'The losing worker waited on a job another worker holds.',
        )
      })

      expect(outcome).toBeNull()
      await expect(harness.driver.reserve({ queueNames: ['default'], workerId: 'late' })).resolves.toBeNull()
    }, 20_000)

    it('reserves every job exactly once across concurrent workers', async () => {
      const harness = await createContentionHarness(server.driver)
      const ids = await dispatchJobs(harness.driver, 40)
      const reserved: QueueReservedJob[] = []

      const work = async (workerId: string): Promise<void> => {
        const driver = harness.createDriver()
        while (true) {
          const job = await driver.reserve({ queueNames: ['default'], workerId })
          if (!job) {
            return
          }

          reserved.push(job)
        }
      }

      await withinDeadline(
        Promise.all(Array.from({ length: 8 }, (_, index) => work(`worker-${index}`))),
        10_000,
        'Concurrent workers did not drain the queue promptly.',
      )

      expect(reserved.map(job => job.envelope.id).sort()).toEqual(ids)
      expect(new Set(reserved.map(job => job.reservationId)).size).toBe(ids.length)
      expect(reserved.every(job => job.envelope.attempts === 0)).toBe(true)
    }, 20_000)
  })
}
