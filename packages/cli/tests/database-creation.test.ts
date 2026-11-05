import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, createDialect, createSchemaService, type DatabaseLogger } from '@holo-js/db'
import { sqliteDatabaseDriverFactory } from '../../db-sqlite/src'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createDatabasesOnFirstUse } from '../src/database-creation'

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('database-creating SQLite adapters', () => {
  it('finishes when a suspension writes through another connection on the same file on which a root transaction started meanwhile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-cli-database-creation-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const factory = createDatabasesOnFirstUse(sqliteDatabaseDriverFactory)
    const url = join(directory, 'nested', 'database.sqlite')
    let started = deferred()
    const logger: DatabaseLogger = {
      onTransactionStart(entry) {
        if (entry.scope === 'transaction') started.resolve()
      },
    }
    const db = createDatabase({ adapter: factory.create({ url }), dialect: createDialect('sqlite') })
    const other = createDatabase({ adapter: factory.create({ url }), dialect: createDialect('sqlite'), logger })
    onTestFinished(async () => {
      await other.disconnect()
      await db.disconnect()
    })
    const schema = createSchemaService(db)
    await schema.createTable('records', (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    const trigger = deferred()
    const transaction = trigger.promise.then(() => other.transaction(async (tx) => {
      await tx.table('records').insert({ id: 2, name: 'transaction' })
    }))

    await schema.withoutForeignKeyConstraints(async () => {
      started = deferred()
      trigger.resolve()
      await started.promise
      await new Promise(resolve => setImmediate(resolve))
      await other.table('records').insert({ id: 1, name: 'suspension' })
    })
    await transaction

    expect(await other.table('records').orderBy('id').pluck('id')).toEqual([1, 2])
  }, 5_000)
})
