import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheDriverContract } from '@holo-js/cache'
import { createSchemaService, registerDatabaseDriverFactory, TableQueryBuilder, type DatabaseContext } from '@holo-js/db'
import { mysqlDatabaseDriverFactory } from '@holo-js/db-mysql'
import { postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import type { HoloProjectConnectionConfig } from '@holo-js/kernel'
import { cacheDbInternals, createDatabaseCacheDriver } from '../src/index'

type ServerDriver = 'mysql' | 'postgres'

const CONTENDERS = 8
const ROUNDS = 12
const CACHE_DRIVER_DISPOSE_SYMBOL = Symbol.for('holo.cache.driver.dispose')

registerDatabaseDriverFactory(mysqlDatabaseDriverFactory)
registerDatabaseDriverFactory(postgresDatabaseDriverFactory)

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function integrationEnabled(driver: ServerDriver): boolean {
  return driver === 'mysql'
    ? process.env.HOLO_MYSQL_INTEGRATION === '1'
    : process.env.HOLO_POSTGRES_INTEGRATION === '1'
}

function connectionConfig(driver: ServerDriver): HoloProjectConnectionConfig {
  if (driver === 'mysql') {
    return {
      driver,
      host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
      username: process.env.HOLO_MYSQL_USER ?? 'root',
      password: process.env.HOLO_MYSQL_PASSWORD,
      database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
    }
  }

  return {
    driver,
    host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
    username: process.env.HOLO_POSTGRES_USER ?? 'postgres',
    password: process.env.HOLO_POSTGRES_PASSWORD,
    database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
  }
}

async function disposeDriver(driver: CacheDriverContract): Promise<void> {
  const dispose = Reflect.get(driver, CACHE_DRIVER_DISPOSE_SYMBOL)
  if (typeof dispose === 'function') {
    await dispose.call(driver)
  }
}

describe.each(['mysql', 'postgres'] as const)('@holo-js/cache-db %s lock contention', (driver) => {
  it.skipIf(!integrationEnabled(driver))('yields a single holder per lock across independent connections', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const table = `cache_${suffix}`
    const lockTable = `cache_locks_${suffix}`
    const config = connectionConfig(driver)
    const control = cacheDbInternals.createDatabaseConnection(`control-${driver}`, config)
    await cacheDbInternals.prepareCacheDatabaseTables(control, table, lockTable)
    cleanups.push(async () => {
      try {
        const schema = createSchemaService(control)
        await schema.dropTable(table)
        await schema.dropTable(lockTable)
      } finally {
        await control.disconnect()
      }
    })

    const contenders = Array.from({ length: CONTENDERS }, () => createDatabaseCacheDriver({
      name: 'database',
      connectionName: `cache-${driver}`,
      table,
      lockTable,
      connection: config,
    }))
    cleanups.push(async () => {
      await Promise.all(contenders.map(disposeDriver))
    })

    for (let round = 0; round < ROUNDS; round += 1) {
      const name = `contended-${round}`
      if (round % 2 === 0) {
        await new TableQueryBuilder(lockTable, control).insert({
          name,
          owner: 'expired-owner',
          expires_at: Date.now() - 1_000,
        })
      }

      const outcomes = await Promise.all(contenders.map(contender => contender.lock(name, 60).get()))

      expect(outcomes.filter(outcome => outcome === true)).toHaveLength(1)
    }
  }, 120_000)
})

type DeadlockHarness = {
  readonly control: DatabaseContext
  readonly holder: DatabaseContext
  readonly driver: CacheDriverContract
  readonly lockTable: string
}

async function createDeadlockHarness(driver: ServerDriver): Promise<DeadlockHarness> {
  const suffix = randomUUID().replaceAll('-', '')
  const table = `cache_${suffix}`
  const lockTable = `cache_locks_${suffix}`
  const config = connectionConfig(driver)
  const control = cacheDbInternals.createDatabaseConnection(`deadlock-control-${driver}`, config)
  const holder = cacheDbInternals.createDatabaseConnection(`deadlock-holder-${driver}`, config)
  await cacheDbInternals.prepareCacheDatabaseTables(control, table, lockTable)
  const cacheDriver = createDatabaseCacheDriver({
    name: 'database',
    connectionName: `deadlock-cache-${driver}`,
    table,
    lockTable,
    connection: config,
  })
  cleanups.push(async () => {
    try {
      await disposeDriver(cacheDriver)
      const schema = createSchemaService(control)
      await schema.dropTable(table)
      await schema.dropTable(lockTable)
    } finally {
      await Promise.all([control.disconnect(), holder.disconnect()])
    }
  })
  return { control, holder, driver: cacheDriver, lockTable }
}

async function insertFillerLocks(connection: DatabaseContext, lockTable: string): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new TableQueryBuilder(lockTable, connection).insert({
      name: `filler-${index}`,
      owner: 'filler',
      expires_at: Date.now() + 3_600_000,
    })
  }
}

async function waitForBlockedPrune(control: DatabaseContext, driver: ServerDriver, lockTable: string): Promise<void> {
  await vi.waitUntil(async () => {
    const result = driver === 'mysql'
      ? await control.queryCompiled({
          sql: 'SELECT COUNT(*) AS waiting FROM information_schema.processlist WHERE COMMAND = ? AND INFO LIKE ?',
          bindings: ['Query', `DELETE%${lockTable}%`],
          source: 'test:cache-db:deadlock',
        })
      : await control.queryCompiled({
          sql: "SELECT COUNT(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
          bindings: [`DELETE%${lockTable}%`],
          source: 'test:cache-db:deadlock',
        })
    return Number(result.rows[0]?.waiting) > 0
  }, { timeout: 15_000, interval: 5 }).catch(error => {
    throw new Error(`No ${driver} session blocked on the expired-lock prune of ${lockTable}.`, { cause: error })
  })
}

function deferred(): { readonly promise: Promise<void>, readonly resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function settle<TValue>(promise: Promise<TValue>): Promise<{ readonly ok: true, readonly value: TValue } | { readonly ok: false, readonly error: unknown }> {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}

describe.each(['mysql', 'postgres'] as const)('@holo-js/cache-db %s expired-lock prune deadlocks through DatabaseContext', (driver) => {
  it.skipIf(!integrationEnabled(driver))('retries a lock acquisition whose expired-lock prune the server rolls back to break a deadlock', async () => {
    const harness = await createDeadlockHarness(driver)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const expiredAt = Date.now()
      await new TableQueryBuilder(harness.lockTable, harness.control).insert({
        name: 'stale-first',
        owner: 'expired-owner',
        expires_at: expiredAt - 2_000,
      })
      await new TableQueryBuilder(harness.lockTable, harness.control).insert({
        name: 'stale-second',
        owner: 'expired-owner',
        expires_at: expiredAt - 1_000,
      })

      const placeholder = driver === 'mysql' ? '?' : '$1'
      const holderReady = deferred()
      const holding = settle(harness.holder.transaction(async (tx) => {
        await tx.queryCompiled({
          sql: `SELECT name FROM ${harness.lockTable} WHERE name = ${placeholder} FOR UPDATE`,
          bindings: ['stale-second'],
          source: 'test:cache-db:deadlock',
        })
        await insertFillerLocks(tx, harness.lockTable)
        holderReady.resolve()
        await waitForBlockedPrune(harness.control, driver, harness.lockTable)
        await tx.queryCompiled({
          sql: `SELECT name FROM ${harness.lockTable} WHERE name = ${placeholder} FOR UPDATE`,
          bindings: ['stale-first'],
          source: 'test:cache-db:deadlock',
        })
      }))

      await Promise.race([
        holderReady.promise,
        holding.then((outcome) => {
          throw new Error(`The holder transaction ended before it was ready: ${outcome.ok ? 'ok' : String(outcome.error)}`)
        }),
      ])
      const acquisition = settle(harness.driver.lock('fresh', 60).get())
      await holding

      expect(await acquisition).toEqual({ ok: true, value: true })
    } finally {
      random.mockRestore()
    }
  }, 60_000)
})
