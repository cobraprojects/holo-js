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
  readonly held: DatabaseContext
  readonly table: string
  driver(connection?: 'database' | 'held'): QueueAsyncDriver
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function connect(driver: ServerDriver, connectionName: string): DatabaseContext {
  if (driver === 'mysql') {
    return new DatabaseContext({
      connectionName,
      driver,
      dialect: createDialect(driver),
      adapter: createMySQLAdapter({
        config: {
          host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
          port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
          user: process.env.HOLO_MYSQL_USER ?? 'root',
          password: process.env.HOLO_MYSQL_PASSWORD,
          database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
        },
      }),
    })
  }

  return new DatabaseContext({
    connectionName,
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
  const connection = connect(driver, 'main')
  const held = connect(driver, 'held')
  const control = connect(driver, 'control')
  await Promise.all([connection.initialize(), held.initialize(), control.initialize()])
  cleanups.push(async () => {
    try {
      await control.executeCompiled({ sql: `DROP TABLE IF EXISTS ${table}`, source: 'test:queue:contention' })
    } finally {
      resetDB()
      resetQueueRuntime()
      await Promise.all([connection.disconnect(), held.disconnect(), control.disconnect()])
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
    builder.index(['queue', 'available_at'], `${table}_queue_available_at_index`)
    builder.index(['queue', 'reserved_at'], `${table}_queue_reserved_at_index`)
    builder.index(['reservation_id'], `${table}_reservation_id_index`)
  })

  configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection, held } }))
  configureQueueRuntime({
    config: {
      default: 'database',
      failed: false,
      connections: {
        database: { driver: 'database', connection: 'main', table, queue: 'default' },
        held: { driver: 'database', connection: 'held', table, queue: 'default' },
      },
    },
    ...createQueueDbRuntimeOptions(),
  })

  return {
    control,
    held,
    table,
    driver(name = 'database') {
      const resolved = queueRuntimeInternals.resolveConnectionDriver(name)
      if (resolved.mode !== 'async') {
        throw new Error('Expected an async database queue driver.')
      }

      return resolved
    },
  }
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

async function seedActiveReservations(harness: ContentionHarness, server: ServerDriver, count: number): Promise<void> {
  const now = Date.now()
  for (let offset = 0; offset < count; offset += 500) {
    const size = Math.min(500, count - offset)
    const rows = Array.from({ length: size }, (_, index) => {
      const id = `active-${String(offset + index).padStart(6, '0')}`
      return `('${id}', 'jobs.active', 'database', 'default', '{}', 1, 3, ${now - 60_000}, ${now}, '${id}', ${now - 60_000})`
    })
    await harness.control.executeCompiled({
      sql: `INSERT INTO ${harness.table} (id, job, connection, queue, payload, attempts, max_attempts, available_at, reserved_at, reservation_id, created_at) VALUES ${rows.join(', ')}`,
      source: 'test:queue:contention:seed',
    })
  }

  await harness.control.executeCompiled({
    sql: server === 'mysql' ? `ANALYZE TABLE ${harness.table}` : `ANALYZE ${harness.table}`,
    source: 'test:queue:contention:seed',
  })
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
    it.each([0, 5_000])('reserves the next job while another worker holds a reservation alongside %i in-flight jobs and returns promptly when none is left', async (activeReservations) => {
      const harness = await createContentionHarness(server.driver)
      await seedActiveReservations(harness, server.driver, activeReservations)
      const ids = await dispatchJobs(harness.driver(), 3)
      const reserve = async (connection: 'database' | 'held', workerId: string) => {
        const job = await withinDeadline(
          harness.driver(connection).reserve({ queueNames: ['default'], workerId }),
          2_000,
          `Worker "${workerId}" waited on a job another worker holds.`,
        )
        return job?.envelope.id ?? null
      }

      const outcome = await harness.held.transaction(async () => [
        await reserve('held', 'first'),
        await reserve('database', 'second'),
        await reserve('database', 'third'),
        await reserve('database', 'fourth'),
      ])

      expect(outcome).toEqual([...ids, null])
    }, 20_000)

    it('reserves every job exactly once across concurrent workers', async () => {
      const harness = await createContentionHarness(server.driver)
      const ids = await dispatchJobs(harness.driver(), 40)
      const reserved: QueueReservedJob[] = []

      const work = async (workerId: string): Promise<void> => {
        const driver = harness.driver()
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
