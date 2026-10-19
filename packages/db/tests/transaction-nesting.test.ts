import { setTimeout } from 'node:timers/promises'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigurationError, createDatabase, createDialect, resetDB, type DriverAdapter } from '../src'
import { openDatabase } from './support/database'

beforeEach(() => resetDB())

const drivers = ['sqlite', 'postgres', 'mysql'] as const
type Driver = (typeof drivers)[number]
const concurrencyCodes = { sqlite: 'SQLITE_BUSY', postgres: '40P01', mysql: 'ER_LOCK_DEADLOCK' } as const

function withAdapterOverrides(adapter: DriverAdapter, overrides: Partial<DriverAdapter>): DriverAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property)
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function createOverriddenDatabase(driver: Driver, adapter: DriverAdapter, overrides: Partial<DriverAdapter>) {
  return createDatabase({
    connectionName: 'default',
    adapter: withAdapterOverrides(adapter, overrides),
    dialect: createDialect(driver),
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('transaction nesting and commit integrity', () => {
  it.each(drivers)('joins a root transaction call inside an active transaction as a savepoint on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await expect(db.transaction(async outer => {
      await outer.table(table).insert({ id: 1, name: 'Outer' })
      await db.transaction(async inner => {
        await inner.table(table).insert({ id: 2, name: 'Inner' })
      })
      await db.writeTransaction(async inner => {
        await inner.table(table).insert({ id: 3, name: 'Written' })
      })
      await expect(db.transaction(async inner => {
        await inner.table(table).insert({ id: 4, name: 'Discarded' })
        throw new Error('inner abort')
      })).rejects.toThrow('inner abort')
      expect(await outer.table(table).orderBy('id').pluck('name')).toEqual(['Outer', 'Inner', 'Written'])
      throw new Error('outer abort')
    })).rejects.toThrow('outer abort')
    expect(await db.table(table).pluck('name')).toEqual([])
  })

  it.each(drivers)('serializes concurrent savepoints on one transaction on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const events: string[] = []
    await db.transaction(async tx => {
      const results = await Promise.allSettled([
        tx.transaction(async nested => {
          events.push('first start')
          await nested.table(table).insert({ id: 1, name: 'First' })
          await setTimeout(20)
          events.push('first end')
        }),
        tx.transaction(async nested => {
          events.push('second start')
          await nested.table(table).insert({ id: 2, name: 'Second' })
          events.push('second end')
          throw new Error('second abort')
        }),
      ])
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
      expect(events).toEqual(['first start', 'first end', 'second start', 'second end'])
      expect(await tx.table(table).orderBy('id').pluck('name')).toEqual(['First'])
    })
    expect(await db.table(table).orderBy('id').pluck('name')).toEqual(['First'])
  })

  it.each(drivers)('nests a transaction call made from inside a savepoint of the same transaction on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.transaction(async outer => {
      await outer.transaction(async inner => {
        await outer.transaction(async work => {
          await work.table(table).insert({ id: 1, name: 'Nested' })
        })
        await inner.table(table).insert({ id: 2, name: 'Inner' })
      })
    })
    expect(await db.table(table).orderBy('id').pluck('name')).toEqual(['Nested', 'Inner'])
  }, 5_000)

  it.each(drivers)('rolls back a savepoint that failed with a concurrency error even when the caller catches it on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.transaction(async tx => {
      await tx.table(table).insert({ id: 1, name: 'Outer' })
      await tx.transaction(async nested => {
        await nested.table(table).insert({ id: 2, name: 'Discarded' })
        throw Object.assign(new Error('lock wait timeout'), { code: concurrencyCodes[driver] })
      }).catch(() => undefined)
    })
    expect(await db.table(table).orderBy('id').pluck('name')).toEqual(['Outer'])
  })

  it.each(drivers)('does not apply transaction timeouts to commit on %s', async driver => {
    const { db, table, adapter } = await openDatabase(driver)
    const slowDb = createOverriddenDatabase(driver, adapter, { commit: async () => {
      await setTimeout(300)
      return adapter.commit()
    } })
    const committed: string[] = []
    await slowDb.transaction(async tx => {
      tx.afterCommit(() => { committed.push('committed') })
      await tx.table(table).insert({ id: 1, name: 'Committed' })
    }, { timeoutMs: 100 })
    expect(committed).toEqual(['committed'])
    expect(await db.table(table).pluck('name')).toEqual(['Committed'])
  })

  it.each(drivers)('does not apply transaction timeouts to rollback on %s', async driver => {
    const { db, table, adapter } = await openDatabase(driver)
    const slowDb = createOverriddenDatabase(driver, adapter, { rollback: async () => {
      await setTimeout(300)
      return adapter.rollback()
    } })
    const rolledBack: string[] = []
    await expect(slowDb.transaction(async tx => {
      tx.afterRollback(() => { rolledBack.push('rolled back') })
      await tx.table(table).insert({ id: 1, name: 'Discarded' })
      throw new Error('abort')
    }, { timeoutMs: 100 })).rejects.toThrow('abort')
    expect(rolledBack).toEqual(['rolled back'])
    expect(await db.table(table).pluck('name')).toEqual([])
  })

  it.each(drivers)('does not run rollback callbacks when commit fails before committing on %s', async driver => {
    const { db, table, adapter } = await openDatabase(driver)
    const failingDb = createOverriddenDatabase(driver, adapter, { commit: async () => {
      throw new Error('commit rejected')
    } })
    const callbacks: string[] = []
    await expect(failingDb.transaction(async tx => {
      tx.afterCommit(() => { callbacks.push('commit') })
      tx.afterRollback(() => { callbacks.push('rollback') })
      await tx.table(table).insert({ id: 1, name: 'Discarded' })
    })).rejects.toThrow('commit rejected')
    expect(callbacks).toEqual([])
    expect(await db.table(table).pluck('name')).toEqual([])
  })

  it.each(drivers)('never reports a committed transaction as rolled back when commit reply fails on %s', async driver => {
    const { db, table, adapter } = await openDatabase(driver)
    const flakyDb = createOverriddenDatabase(driver, adapter, { commit: async () => {
      await adapter.commit()
      throw new Error('commit reply lost')
    } })
    const callbacks: string[] = []
    await expect(flakyDb.transaction(async tx => {
      tx.afterRollback(() => { callbacks.push('rollback') })
      await tx.table(table).insert({ id: 1, name: 'Durable' })
    })).rejects.toThrow('commit reply lost')
    expect(callbacks).toEqual([])
    expect(await db.table(table).pluck('name')).toEqual(['Durable'])
  })

  it.each(drivers)('propagates the original after-commit error and skips remaining callbacks on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const failure = new Error('notification failed')
    const calls: string[] = []
    await expect(db.transaction(async tx => {
      tx.afterCommit(() => { throw failure })
      tx.afterCommit(() => { calls.push('second') })
      await tx.table(table).insert({ id: 1, name: 'Durable' })
    })).rejects.toBe(failure)
    expect(calls).toEqual([])
    expect(await db.table(table).pluck('name')).toEqual(['Durable'])
  })

  it.each(drivers)('does not retry a committed transaction when an after-commit callback fails with a concurrency error on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    let calls = 0
    await expect(db.transaction(async tx => {
      calls += 1
      tx.afterCommit(() => { throw Object.assign(new Error('notification busy'), { code: concurrencyCodes[driver] }) })
      await tx.table(table).insert({ id: calls, name: `Attempt ${calls}` })
    }, { attempts: 2 })).rejects.toThrow('notification busy')
    expect(calls).toBe(1)
    expect(await db.table(table).pluck('name')).toEqual(['Attempt 1'])
  })

  it.each(drivers)('retries concurrency errors up to the attempt limit and then rethrows on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    let calls = 0
    await expect(db.transaction(async tx => {
      calls += 1
      await tx.table(table).insert({ id: calls, name: `Attempt ${calls}` })
      throw Object.assign(new Error('deadlock detected'), { code: concurrencyCodes[driver] })
    }, { attempts: 3 })).rejects.toThrow('deadlock detected')
    expect(calls).toBe(3)
    expect(await db.table(table).pluck('name')).toEqual([])
  })

  it.each(drivers)('returns the result of a transaction retried after a concurrency error on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    let calls = 0
    const result = await db.transaction(async tx => {
      calls += 1
      await tx.table(table).insert({ id: calls, name: `Attempt ${calls}` })
      if (calls === 1) throw Object.assign(new Error('deadlock detected'), { code: concurrencyCodes[driver] })
      return 'done'
    }, { attempts: 2 })
    expect(result).toBe('done')
    expect(calls).toBe(2)
    expect(await db.table(table).pluck('name')).toEqual(['Attempt 2'])
  })

  it.each(drivers)('does not retry application errors on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    let calls = 0
    await expect(db.transaction(async tx => {
      calls += 1
      await tx.table(table).insert({ id: calls, name: 'Discarded' })
      throw new Error('validation failed')
    }, { attempts: 3 })).rejects.toThrow('validation failed')
    expect(calls).toBe(1)
    expect(await db.table(table).pluck('name')).toEqual([])
  })

  it.each([0, 1.5, -1])('rejects invalid transaction attempt counts (%s)', async attempts => {
    const { db } = await openDatabase('sqlite')
    await expect(db.transaction(async () => {}, { attempts })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it.each(['postgres', 'mysql'] as const)('retries a real deadlock victim on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert([{ id: 1, name: 'One' }, { id: 2, name: 'Two' }])
    const firstLocked = deferred()
    const secondLocked = deferred()
    const calls = { first: 0, second: 0 }
    const first = db.transaction(async tx => {
      calls.first += 1
      const attempt = calls.first
      await tx.table(table).where('id', 1).update({ name: 'First' })
      if (attempt === 1) {
        firstLocked.resolve()
        await secondLocked.promise
      }
      await tx.table(table).where('id', 2).update({ name: 'First' })
    }, { attempts: 2 })
    const second = db.transaction(async tx => {
      calls.second += 1
      const attempt = calls.second
      await tx.table(table).where('id', 2).update({ name: 'Second' })
      if (attempt === 1) {
        secondLocked.resolve()
        await firstLocked.promise
      }
      await tx.table(table).where('id', 1).update({ name: 'Second' })
    }, { attempts: 2 })
    const results = await Promise.allSettled([first, second])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(calls.first + calls.second).toBe(3)
    expect(await db.table(table).orderBy('id').pluck('id')).toEqual([1, 2])
  }, 20_000)
})
