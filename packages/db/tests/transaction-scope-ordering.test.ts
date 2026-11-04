import { randomUUID } from 'node:crypto'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createDatabase, createDialect, createMigrationService, createQueryScheduler, createSchemaService, DB, defineMigration, type DatabaseLogger, type DriverAdapter } from '../src'
import { openDatabase } from './support/database'

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function nextMacrotask(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function watchRootTransactions(): { logger: DatabaseLogger, nextStart: () => Promise<void> } {
  let started: (() => void) | undefined
  return {
    logger: {
      onTransactionStart(entry) {
        if (entry.scope === 'transaction') started?.()
      },
    },
    nextStart() {
      const next = deferred()
      started = next.resolve
      return next.promise
    },
  }
}

function startFromAnotherChain<T>(work: () => Promise<T>): { start: () => void, done: Promise<T> } {
  const trigger = deferred()
  return { start: trigger.resolve, done: trigger.promise.then(work) }
}

async function readForeignKeys(adapter: DriverAdapter): Promise<number> {
  const result = await adapter.query<{ foreign_keys: number }>('PRAGMA foreign_keys')
  return Number(result.rows[0]?.foreign_keys)
}

function holdNextTransactionScope(adapter: DriverAdapter): { adapter: DriverAdapter, hold: () => { entered: Promise<void>, release: () => void } } {
  let pending: { entered: () => void, released: Promise<void> } | undefined
  const wrapped = new Proxy(adapter, {
    get(target, property) {
      if (property !== 'runWithTransactionScope') return Reflect.get(target, property, target)
      return <T>(callback: () => Promise<T>): Promise<T> => {
        const held = pending
        pending = undefined
        return target.runWithTransactionScope!(async () => {
          if (held) {
            held.entered()
            await held.released
          }
          return callback()
        })
      }
    },
  })
  return {
    adapter: wrapped,
    hold() {
      const entered = deferred()
      const released = deferred()
      pending = { entered: entered.resolve, released: released.promise }
      return { entered: entered.promise, release: released.resolve }
    },
  }
}

describe('transaction scope ordering on one SQLite context', () => {
  it('finishes a root transaction that starts while withoutForeignKeyConstraints() yields between statements', async () => {
    const transactions = watchRootTransactions()
    const { db, schema, table, adapter } = await openDatabase('sqlite', { logger: transactions.logger })
    const transaction = startFromAnotherChain(() => db.transaction(async (tx) => {
      await tx.table(table).insert({ id: 3, name: 'transaction' })
    }))

    await schema.withoutForeignKeyConstraints(async () => {
      await db.table(table).insert({ id: 1, name: 'before yield' })
      const started = transactions.nextStart()
      transaction.start()
      await started
      await nextMacrotask()
      await db.table(table).insert({ id: 2, name: 'after yield' })
    })
    await transaction.done

    expect(await db.table(table).orderBy('id').pluck('id')).toEqual([1, 2, 3])
    expect(await readForeignKeys(adapter)).toBe(1)
  }, 5_000)

  it('keeps statements from another chain off the connection while foreign-key checks are off', async () => {
    const { db, schema } = await openDatabase('sqlite')
    const read = startFromAnotherChain(async () => {
      const result = await db.queryCompiled<{ foreign_keys: number }>({ sql: 'PRAGMA foreign_keys', bindings: [], source: 'schema' })
      return Number(result.rows[0]?.foreign_keys)
    })

    await schema.withoutForeignKeyConstraints(async () => {
      read.start()
      await nextMacrotask()
      await nextMacrotask()
    })

    expect(await read.done).toBe(1)
  }, 5_000)

  it('finishes a root transaction that starts while a SQLite table rebuild holds the transaction scope', async () => {
    const transactions = watchRootTransactions()
    let held!: ReturnType<typeof holdNextTransactionScope>
    const { db, schema, adapter } = await openDatabase('sqlite', {
      logger: transactions.logger,
      wrapAdapter: (created) => {
        held = holdNextTransactionScope(created)
        return held.adapter
      },
    })
    const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
    const parents = `holo_parents_${suffix}`
    const children = `holo_children_${suffix}`
    onTestFinished(async () => {
      await schema.dropTable(children)
      await schema.dropTable(parents)
    })
    await schema.createTable(parents, (table) => {
      table.id()
      table.string('name').nullable()
    })
    await schema.createTable(children, (table) => {
      table.id()
      table.foreignId('parent_id').constrained(parents)
    })
    await db.table(parents).insert({ name: 'first' })
    await db.table(children).insert({ parent_id: 1 })
    const transaction = startFromAnotherChain(() => db.transaction(async (tx) => {
      await tx.table(parents).insert({ name: 'second' })
    }))

    const scope = held.hold()
    const change = schema.table(parents, (table) => { table.string('name').nullable().default('unnamed').change() })
    await scope.entered
    const started = transactions.nextStart()
    transaction.start()
    await started
    await nextMacrotask()
    scope.release()
    await change
    await transaction.done

    expect(await db.table(parents).orderBy('id').pluck('name')).toEqual(['first', 'second'])
    expect(await db.table(children).pluck('parent_id')).toEqual([1])
    expect(await readForeignKeys(adapter)).toBe(1)
  }, 5_000)

  it('finishes a root transaction that starts while adding a column with an expression default rebuilds the table', async () => {
    const transactions = watchRootTransactions()
    let held!: ReturnType<typeof holdNextTransactionScope>
    const { db, schema, table, adapter } = await openDatabase('sqlite', {
      logger: transactions.logger,
      wrapAdapter: (created) => {
        held = holdNextTransactionScope(created)
        return held.adapter
      },
    })
    await db.table(table).insert({ id: 1, name: 'first' })
    const transaction = startFromAnotherChain(() => db.transaction(async (tx) => {
      await tx.table(table).insert({ id: 2, name: 'transaction' })
    }))

    const scope = held.hold()
    const change = schema.table(table.tableName, (builder) => { builder.string('token').default(DB.raw('lower(hex(randomblob(16)))')) })
    await scope.entered
    const started = transactions.nextStart()
    transaction.start()
    await started
    await nextMacrotask()
    scope.release()
    await change
    await transaction.done

    const rows = await db.table(table.tableName).orderBy('id').get<{ id: number, token: string }>()
    expect(rows.map(row => row.id)).toEqual([1, 2])
    expect(rows.every(row => /^[0-9a-f]{32}$/.test(row.token))).toBe(true)
    expect(await readForeignKeys(adapter)).toBe(1)
  }, 5_000)

  it('finishes a root transaction that starts while a migration holds the transaction scope', async () => {
    const transactions = watchRootTransactions()
    const held = holdNextTransactionScope(createSQLiteAdapter({ filename: ':memory:' }))
    const db = createDatabase({ adapter: held.adapter, dialect: createDialect('sqlite'), logger: transactions.logger })
    onTestFinished(() => db.disconnect())
    const schema = createSchemaService(db)
    await schema.createTable('records', (table) => {
      table.id()
      table.string('value')
    })
    const migrator = createMigrationService(db, [defineMigration({
      name: '2026_01_01_000001_create_items',
      async up({ schema: migrationSchema }) {
        await migrationSchema.createTable('items', (table) => {
          table.id()
        })
      },
    })])
    const transaction = startFromAnotherChain(() => db.transaction(async (tx) => {
      await tx.table('records').insert({ value: 'transaction' })
    }))
    await createMigrationService(db, []).migrate()

    const scope = held.hold()
    const migration = migrator.migrate()
    await scope.entered
    const started = transactions.nextStart()
    transaction.start()
    await started
    await nextMacrotask()
    scope.release()

    expect((await migration).map(entry => entry.name)).toEqual(['2026_01_01_000001_create_items'])
    await transaction.done
    expect(await schema.hasTable('items')).toBe(true)
    expect(await db.table('records').pluck('value')).toEqual(['transaction'])
    expect(await readForeignKeys(held.adapter)).toBe(1)
  }, 5_000)
})

describe('transaction scope ordering across contexts sharing one SQLite adapter', () => {
  it('keeps statements of another context off the connection while foreign-key checks are off', async () => {
    const { schema, adapter } = await openDatabase('sqlite')
    const other = createDatabase({ connectionName: 'default', adapter, dialect: createDialect('sqlite') })
    const read = startFromAnotherChain(async () => {
      const result = await other.queryCompiled<{ foreign_keys: number }>({ sql: 'PRAGMA foreign_keys', bindings: [], source: 'schema' })
      return Number(result.rows[0]?.foreign_keys)
    })

    await schema.withoutForeignKeyConstraints(async () => {
      read.start()
      await nextMacrotask()
      await nextMacrotask()
    })

    expect(await read.done).toBe(1)
  }, 5_000)

  it('finishes when a suspension queries another context on which a root transaction started meanwhile', async () => {
    const transactions = watchRootTransactions()
    const { schema, adapter, table } = await openDatabase('sqlite')
    const other = createDatabase({ connectionName: 'default', adapter, dialect: createDialect('sqlite'), logger: transactions.logger })
    const transaction = startFromAnotherChain(() => other.transaction(async (tx) => {
      await tx.table(table).insert({ id: 2, name: 'transaction' })
    }))

    await schema.withoutForeignKeyConstraints(async () => {
      const started = transactions.nextStart()
      transaction.start()
      await started
      await nextMacrotask()
      await other.table(table).insert({ id: 1, name: 'suspension' })
    })
    await transaction.done

    expect(await other.table(table).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await readForeignKeys(adapter)).toBe(1)
  }, 5_000)
})

describe('query scheduler exclusive gate', () => {
  it('never runs two exclusive sections at once when one starts while the gate hands over to a waiter', async () => {
    const scheduler = createQueryScheduler({ connectionName: 'default', supportsConcurrentQueries: false, supportsWorkerThreads: false })
    let running = 0
    let overlapped = false
    const section = async (): Promise<void> => {
      running += 1
      if (running > 1) overlapped = true
      await nextMacrotask()
      running -= 1
    }
    const holderReleased = deferred()
    const holder = scheduler.exclusive(async () => {
      await section()
      await holderReleased.promise
    })
    await nextMacrotask()
    const waiter = scheduler.exclusive(section)
    const latecomers: Promise<void>[] = []
    let chain = holderReleased.promise
    for (let depth = 0; depth < 20; depth += 1) {
      chain = chain.then(() => undefined)
      latecomers.push(chain.then(() => scheduler.exclusive(section)))
    }

    holderReleased.resolve()
    await Promise.all([holder, waiter, ...latecomers])

    expect(overlapped).toBe(false)
  }, 5_000)
})

describe('transaction scope re-entry on one SQLite context', () => {
  it('makes a root transaction forked from a finished transaction wait for the transaction that holds the context', async () => {
    const { db, table } = await openDatabase('sqlite')
    const forkReleased = deferred()
    let fork!: Promise<void>
    await db.transaction(async () => {
      fork = forkReleased.promise.then(() => db.transaction(async (tx) => {
        await tx.table(table).insert({ id: 2, name: 'fork' })
      }))
    })

    await db.transaction(async (tx) => {
      await tx.table(table).insert({ id: 1, name: 'holder' })
      forkReleased.resolve()
      await nextMacrotask()
      expect(await tx.table(table).pluck('id')).toEqual([1])
    })
    await fork

    expect(await db.table(table).orderBy('id').pluck('id')).toEqual([1, 2])
  }, 5_000)
})

for (const driver of ['postgres', 'mysql'] as const) {
  const enabled = process.env[driver === 'postgres' ? 'HOLO_POSTGRES_INTEGRATION' : 'HOLO_MYSQL_INTEGRATION'] === '1'
  describe.skipIf(!enabled)(`concurrent ${driver} transaction scopes`, () => {
    it('commits a root transaction from another chain while withoutForeignKeyConstraints() is still running, with one query slot', async () => {
      const { db, schema, table } = await openDatabase(driver, { concurrency: { maxConcurrentQueries: 1 } })
      const transaction = startFromAnotherChain(() => db.transaction(async (tx) => {
        await tx.table(table).insert({ id: 1, name: 'transaction' })
      }))

      await schema.withoutForeignKeyConstraints(async () => {
        transaction.start()
        await transaction.done
        await db.table(table).insert({ id: 2, name: 'suspension' })
      })

      expect(await db.table(table).orderBy('id').pluck('id')).toEqual([1, 2])
    }, 5_000)
  })
}
