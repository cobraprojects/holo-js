import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { CacheDriverContract } from '@holo-js/cache'
import { createSchemaService, registerDatabaseDriverFactory, TableQueryBuilder } from '@holo-js/db'
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
