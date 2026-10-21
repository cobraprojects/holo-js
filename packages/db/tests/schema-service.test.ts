import { randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { CapabilityError, column, createSchemaService, type DriverAdapter, SchemaError, TransactionError, unsafeSql } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`native ${driver} schema service`, () => {
    it('creates typed columns, defaults, indexes, and constraints that accept valid records', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_schema_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('email').unique()
        table.boolean('active').default(true)
        table.integer('visits').default(7)
        table.json('settings').nullable()
        table.timestamp('created_at').nullable()
        table.index(['active'])
      })
      expect(await schema.hasTable(name)).toBe(true)
      const definition = db.getSchemaRegistry().get(name)!
      const createdAt = new Date('2026-01-01T00:00:00Z')
      await db.table(definition).insert({ email: 'native@example.com', settings: { enabled: true }, created_at: createdAt })
      const row = (await db.table(definition).first())!
      expect(Number(row.id)).toBe(1)
      expect(Number(row.visits)).toBe(7)
      expect([true, 1]).toContain(row.active)
      expect(typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings).toEqual({ enabled: true })
      await expect(db.table(definition).insert({ email: 'native@example.com' })).rejects.toThrow()
      await expect(db.table(definition).insert({ active: false })).rejects.toThrow()
      expect(await db.table(definition).count()).toBe(1)
      expect((await schema.getColumns(name)).find(column => column.name === 'id')).toMatchObject({ primaryKey: true, notNull: true })
      expect(await schema.getIndexes(name)).toEqual(expect.arrayContaining([expect.objectContaining({ columns: ['active'], unique: false })]))
    })

    it('syncs missing registered tables without destroying existing rows', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = `holo_sync_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      const definition = defineTable(name, { id: column.id(), name: column.string() })
      schema.register(definition)
      const preview = await schema.previewSync([definition])
      expect(preview).toMatchObject({ mode: 'create_missing_only', tablesToCreate: [name], destructiveChanges: false })
      expect(await schema.hasTable(name)).toBe(false)
      await db.table(table).insert({ id: 1, name: 'Preserved', active: true })
      await schema.sync([definition])
      await db.table(definition).insert({ name: 'Created' })
      await schema.sync([definition])
      expect(await db.table(definition).pluck('name')).toEqual(['Created'])
      expect(await db.table(table).pluck('name')).toEqual(['Preserved'])
      expect((await schema.previewSync([definition])).tablesToCreate).toEqual([])
    })

    it('renames tables and columns and preserves persisted rows', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const original = table.tableName.split('.').at(-1)!
      const renamed = `${original}_renamed`
      onTestFinished(async () => { if (await schema.hasTable(renamed)) await schema.dropTable(renamed) })
      await db.table(table).insert({ id: 1, name: 'Preserved', active: true })
      await schema.renameTable(original, renamed)
      expect(await schema.hasTable(original)).toBe(false)
      expect(await schema.hasTable(renamed)).toBe(true)
      if (driver === 'sqlite') {
        await expect(schema.table(renamed, table => { table.renameColumn('name', 'title') })).rejects.toThrow(CapabilityError)
        expect(await db.table(renamed).pluck('name')).toEqual(['Preserved'])
        return
      }
      await schema.table(renamed, table => { table.renameColumn('name', 'title') })
      expect(await db.table(renamed).pluck('title')).toEqual(['Preserved'])
      expect((await schema.getColumns(renamed)).map(column => column.name)).toContain('title')
      expect((await schema.getColumns(renamed)).map(column => column.name)).not.toContain('name')
    })

    it('adds, changes, and drops columns while preserving keys and records', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      await db.table(table).insert({ id: 1, name: 'Original', active: true })
      await schema.table(name, table => { table.string('nickname').nullable().default('guest') })
      expect(await db.table(name).pluck('nickname')).toEqual(['guest'])
      await schema.table(name, table => { table.string('nickname').nullable().default('changed').change() })
      expect(await db.table(name).pluck('nickname')).toEqual(['guest'])
      await db.table(name).insert({ id: 2, name: 'Second', active: false })
      expect(await db.table(name).where('id', 2).pluck('nickname')).toEqual(['changed'])
      expect((await schema.getColumns(name)).find(column => column.name === 'id')?.primaryKey).toBe(true)
      if (driver === 'sqlite') {
        await expect(schema.table(name, table => { table.dropColumn('nickname') })).rejects.toThrow(CapabilityError)
        expect(await db.table(name).orderBy('id').pluck('name')).toEqual(['Original', 'Second'])
        return
      }
      await schema.table(name, table => { table.dropColumn('nickname') })
      expect((await schema.getColumns(name)).map(column => column.name)).not.toContain('nickname')
      expect(await db.table(name).orderBy('id').pluck('name')).toEqual(['Original', 'Second'])
    })

    it('creates and drops indexes and preserves index names across column renames', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      const index = `${name}_name_unique`
      await schema.table(name, table => { table.unique(['name'], index) })
      await db.table(table).insert({ id: 1, name: 'Unique' })
      await expect(db.table(table).insert({ id: 2, name: 'Unique' })).rejects.toThrow()
      if (driver === 'sqlite') {
        await expect(schema.table(name, table => { table.renameColumn('name', 'title') })).rejects.toThrow(CapabilityError)
        await schema.table(name, table => { table.dropIndex(index) })
        await db.table(table).insert({ id: 2, name: 'Unique' })
        expect(await db.table(table).count()).toBe(2)
        return
      }
      await schema.table(name, table => { table.renameColumn('name', 'title') })
      expect(await schema.getIndexes(name)).toEqual(expect.arrayContaining([expect.objectContaining({ name: index, columns: ['title'], unique: true })]))
      await schema.table(name, table => { table.dropIndex(index) })
      await db.table(name).insert({ id: 2, title: 'Unique' })
      expect(await db.table(name).count()).toBe(2)
    })

    it('preserves unique enforcement when renaming an index', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      const original = `${name}_original`
      const renamed = `${name}_renamed`
      await schema.table(name, table => { table.unique(['name'], original) })
      await db.table(table).insert({ id: 1, name: 'Unique' })
      if (driver === 'sqlite') {
        await expect(schema.table(name, table => { table.renameIndex(original, renamed) })).rejects.toThrow(CapabilityError)
      } else {
        await schema.table(name, table => { table.renameIndex(original, renamed) })
        expect((await schema.getIndexes(name)).map(index => index.name)).toContain(renamed)
        expect((await schema.getIndexes(name)).map(index => index.name)).not.toContain(original)
      }
      await expect(db.table(table).insert({ id: 2, name: 'Unique' })).rejects.toThrow()
      expect(await db.table(table).count()).toBe(1)
    })

    it('adds and removes foreign-key enforcement on an existing table', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_fk_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const constraint = `${child}_parent`
      onTestFinished(() => schema.dropTable(child))
      await schema.createTable(child, table => { table.id(); table.integer('parent_id') })
      if (driver === 'sqlite') {
        await expect(schema.table(child, table => { table.foreign('parent_id', constraint).references('id').on(parent) })).rejects.toThrow(CapabilityError)
        await db.table(child).insert({ parent_id: 99 })
        expect(await db.table(child).count()).toBe(1)
        return
      }
      await schema.table(child, table => { table.foreign('parent_id', constraint).references('id').on(parent) })
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      await db.table(table).insert({ id: 1, name: 'Parent' })
      await db.table(child).insert({ parent_id: 1 })
      await schema.table(child, table => { table.dropForeign(constraint) })
      await db.table(child).insert({ parent_id: 99 })
      expect(await db.table(child).orderBy('id').pluck('parent_id')).toEqual([1, 99])
      expect(await schema.getForeignKeys(child)).toEqual([])
    })

    it('enforces foreign keys and cascades deletes on the native engine', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_child_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(child))
      await schema.createTable(child, table => {
        table.id()
        table.integer('parent_id')
        table.foreign('parent_id').references('id').on(parent).cascadeOnDelete().restrictOnUpdate()
      })
      await db.table(table).insert({ id: 1, name: 'Parent' })
      await db.table(child).insert({ parent_id: 1 })
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      expect(await schema.getForeignKeys(child)).toEqual([{ table: parent, from: 'parent_id', to: 'id', onUpdate: 'RESTRICT', onDelete: 'CASCADE' }])
      await db.table(table).where('id', 1).delete()
      expect(await db.table(child).count()).toBe(0)
    })

    it('rejects malformed identifiers and incomplete foreign-key chains without creating tables', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_invalid_${randomUUID().replaceAll('-', '')}`
      await expect(schema.createTable('users; DROP TABLE users', table => { table.id() })).rejects.toThrow(SchemaError)
      await expect(schema.getColumns('users; DROP TABLE users')).rejects.toThrow(SchemaError)
      await expect(schema.createTable(name, table => { table.foreign('owner_id').references('id') })).rejects.toThrow(SchemaError)
      expect(await schema.hasTable(name)).toBe(false)
      if (driver === 'mysql') {
        const longName = `holo_${'a'.repeat(50)}`
        await expect(schema.createTable(longName, table => { table.integer('parent_id'); table.foreign('parent_id').references('id').on(name) })).rejects.toThrow(SchemaError)
        expect(await schema.hasTable(longName)).toBe(false)
      }
    })

    it('restores foreign-key enforcement after a scoped callback fails', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_child_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(child))
      await schema.createTable(child, table => { table.id(); table.integer('parent_id'); table.foreign('parent_id').references('id').on(parent) })
      await expect(schema.withoutForeignKeyConstraints(async () => { throw new Error('callback failed') })).rejects.toThrow('callback failed')
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      expect(await db.table(child).count()).toBe(0)
    })

    it('rejects a plain write issued while a pinned-connection transaction is open, and keeps it out of that transaction', async () => {
      const { db, schema, table } = await openDatabase(driver)
      let transactionStarted!: () => void
      const started = new Promise<void>(resolve => { transactionStarted = resolve })

      await schema.withoutForeignKeyConstraints(async () => {
        const failing = db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'rolled back' })
          transactionStarted()
          await new Promise(resolve => { setTimeout(resolve, 20) })
          throw new Error('transaction failed')
        })
        await started
        await expect(db.table(table).insert({ id: 2, name: 'plain' })).rejects.toBeInstanceOf(TransactionError)
        await expect(failing).rejects.toThrow('transaction failed')
        await db.table(table).insert({ id: 3, name: 'after' })
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 3 }])
    })

    it('rejects a transaction that awaits a query started outside it instead of hanging', async () => {
      const { db, schema, table } = await openDatabase(driver)

      await schema.withoutForeignKeyConstraints(async () => {
        let outsideWrite!: Promise<unknown>
        const transaction = db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'inside' })
          await outsideWrite
        })
        outsideWrite = new Promise(resolve => { setTimeout(resolve, 30) })
          .then(() => db.table(table).insert({ id: 2, name: 'outside' }))
        await expect(transaction).rejects.toBeInstanceOf(TransactionError)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([])
    }, 2_000)

    it('rejects a write scheduled from a finished transaction that runs while a later transaction is open', async () => {
      const { db, schema, table } = await openDatabase(driver)
      let releaseStray!: () => void
      const strayReleased = new Promise<void>(resolve => { releaseStray = resolve })
      let strayOutcome!: Promise<unknown>

      await schema.withoutForeignKeyConstraints(async () => {
        await db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'first' })
          strayOutcome = strayReleased
            .then(() => db.table(table).insert({ id: 2, name: 'stray' }))
            .then(() => 'ran', (error: unknown) => error)
        })
        await expect(db.transaction(async tx => {
          await tx.table(table).insert({ id: 3, name: 'second' })
          releaseStray()
          await new Promise(resolve => { setTimeout(resolve, 20) })
          throw new Error('second failed')
        })).rejects.toThrow('second failed')
        expect(await strayOutcome).toBeInstanceOf(TransactionError)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 1 }])
    })

    it('rejects a write still running its query logger when a later transaction opens before it reaches the connection', async () => {
      let pauseNextQuery = false
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQueryStart: async () => {
            if (!pauseNextQuery) return
            pauseNextQuery = false
            await new Promise(resolve => { setTimeout(resolve, 20) })
          },
        },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        let strayOutcome!: Promise<unknown>
        await db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'first' })
          pauseNextQuery = true
          strayOutcome = db.table(table).insert({ id: 2, name: 'stray' }).then(() => 'ran', (error: unknown) => error)
        })
        await expect(db.transaction(async tx => {
          await tx.table(table).insert({ id: 3, name: 'second' })
          await new Promise(resolve => { setTimeout(resolve, 60) })
          throw new Error('second failed')
        })).rejects.toThrow('second failed')
        expect(await strayOutcome).toBeInstanceOf(TransactionError)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 1 }])
    })

    it('lets a query logger start a transaction on the pinned connection after a plain write succeeds', async () => {
      let loggedWrite = false
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQuerySuccess: async entry => {
            if (loggedWrite || !entry.source?.startsWith('query:insert')) return
            loggedWrite = true
            await db.transaction(async tx => {
              await tx.table(table).insert({ id: 2, name: 'from logger' })
            })
          },
        },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        await db.table(table).insert({ id: 1, name: 'plain' })
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 1 }, { id: 2 }])
    })

    it('keeps a timed-out write counted until it reaches the connection, so a transaction cannot take it', async () => {
      const delaySubmission = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
        get(target, property) {
          if (property === 'execute') {
            return async (...args: Parameters<DriverAdapter['execute']>) => {
              await new Promise(resolve => { setTimeout(resolve, 30) })
              return target.execute(...args)
            }
          }
          return Reflect.get(target, property, target)
        },
      })
      const { db, schema, table } = await openDatabase(driver, {
        security: { allowUnsafeRawSql: true },
        wrapAdapter: delaySubmission,
      })
      const placeholder = (index: number) => driver === 'postgres' ? `$${index}` : '?'

      await schema.withoutForeignKeyConstraints(async () => {
        const slow = db.unsafeExecute(unsafeSql(
          `insert into ${table.tableName} (id, name) values (${placeholder(1)}, ${placeholder(2)})`,
          [2, 'slow'],
        ), { timeoutMs: 5 })
        await expect(slow).rejects.toThrow()
        await db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'transaction' })
          await new Promise(resolve => { setTimeout(resolve, 80) })
          throw new Error('transaction failed')
        }).catch(() => undefined)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 2 }])
    }, 5_000)

    it('does not hang when a query logger starts a transaction while foreign-key checks are restored', async () => {
      let loggedRestore = false
      const { db, schema } = await openDatabase(driver, {
        logger: {
          onQuerySuccess: async entry => {
            if (loggedRestore || entry.source !== 'schema:enableForeignKeys') return
            loggedRestore = true
            await db.transaction(async () => undefined)
          },
        },
      })

      await expect(schema.withoutForeignKeyConstraints(async () => undefined)).resolves.toBeUndefined()
    }, 2_000)

    it('does not let a transaction started from the restore query logger take a write the callback left running', async () => {
      let restoreLogged = false
      let sibling!: Promise<unknown>
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQuerySuccess: async entry => {
            if (restoreLogged || entry.source !== 'schema:enableForeignKeys') return
            restoreLogged = true
            await db.transaction(async tx => {
              await tx.table(table).insert({ id: 3, name: 'restore' })
              await sibling
            })
          },
        },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        sibling = new Promise(resolve => { setTimeout(resolve, 20) })
          .then(() => db.table(table).insert({ id: 2, name: 'sibling' }))
      })
      const siblingOutcome = await sibling.then(() => 'committed' as const, (error: unknown) => error)
      const rows = (await db.table(table).select('id').orderBy('id').get()).map(row => row.id)

      expect(rows).not.toContain(3)
      if (siblingOutcome === 'committed') {
        expect(rows).toContain(2)
      } else {
        expect(siblingOutcome).toBeInstanceOf(TransactionError)
        expect(rows).not.toContain(2)
      }
    }, 2_000)

    it('keeps a write out of a transaction whose timed-out BEGIN has not settled yet', async () => {
      const delayBegin = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
        get(target, property) {
          if (property === 'beginTransaction') {
            return async (...args: Parameters<DriverAdapter['beginTransaction']>) => {
              await new Promise(resolve => { setTimeout(resolve, 30) })
              return target.beginTransaction(...args)
            }
          }
          return Reflect.get(target, property, target)
        },
      })
      const { db, schema, table } = await openDatabase(driver, { wrapAdapter: delayBegin })

      await schema.withoutForeignKeyConstraints(async () => {
        const started = db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'transaction' })
        }, { timeoutMs: 5 }).then(() => undefined, (error: unknown) => error)
        await new Promise(resolve => { setTimeout(resolve, 15) })
        await expect(db.table(table).insert({ id: 2, name: 'during begin' })).rejects.toBeInstanceOf(TransactionError)
        expect(await started).toBeInstanceOf(Error)
        await db.table(table).insert({ id: 3, name: 'after begin' })
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 3 }])
    }, 5_000)

    it('keeps a pinned scope on one connection in place when a concurrent scope on another connection exits', async () => {
      const first = await openDatabase(driver)
      const second = await openDatabase(driver)
      let secondTransactionOpen!: () => void
      const transactionOpen = new Promise<void>(resolve => { secondTransactionOpen = resolve })
      let firstExited!: () => void
      const exited = new Promise<void>(resolve => { firstExited = resolve })

      await second.schema.withoutForeignKeyConstraints(async () => {
        const transaction = second.db.transaction(async tx => {
          await tx.table(second.table).insert({ id: 1, name: 'open' })
          secondTransactionOpen()
          await exited
          throw new Error('second failed')
        })
        await transactionOpen
        await first.schema.withoutForeignKeyConstraints(async () => undefined)
        firstExited()
        await expect(second.db.table(second.table).insert({ id: 2, name: 'plain' })).rejects.toBeInstanceOf(TransactionError)
        await expect(transaction).rejects.toThrow('second failed')
      })

      expect(await second.db.table(second.table).select('id').orderBy('id').get()).toEqual([])
    }, 5_000)

    it('rejects a query outside a transaction whose rollback failed, instead of joining that transaction', async () => {
      let failNextRollback = true
      const failFirstRollback = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
        get(target, property) {
          if (property === 'rollback') {
            return async (...args: Parameters<DriverAdapter['rollback']>) => {
              if (failNextRollback) {
                failNextRollback = false
                throw new Error('rollback failed')
              }
              return target.rollback(...args)
            }
          }
          return Reflect.get(target, property, target)
        },
      })
      const { db, schema, table, adapter } = await openDatabase(driver, { wrapAdapter: failFirstRollback })

      await schema.withoutForeignKeyConstraints(async () => {
        try {
          await expect(db.transaction(async tx => {
            await tx.table(table).insert({ id: 1, name: 'failed' })
            throw new Error('callback failed')
          })).rejects.toThrow()
          await expect(db.table(table).insert({ id: 2, name: 'plain' })).rejects.toBeInstanceOf(TransactionError)
        } finally {
          await adapter.rollback().catch(() => undefined)
        }
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([])
    }, 5_000)

    it('rejects an unawaited write that resumes after the callback returned, and persists nothing while the restore is delayed', async () => {
      let pauseNextInsert = false
      let restored = false
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQueryStart: async entry => {
            if (pauseNextInsert && entry.source?.startsWith('query:insert')) {
              pauseNextInsert = false
              await new Promise(resolve => { setTimeout(resolve, 20) })
            }
            if (entry.source === 'schema:enableForeignKeys') {
              await new Promise(resolve => { setTimeout(resolve, 60) })
            }
          },
          onQuerySuccess: entry => {
            if (entry.source === 'schema:enableForeignKeys') restored = true
          },
        },
      })
      let late!: Promise<unknown>

      await schema.withoutForeignKeyConstraints(async () => {
        pauseNextInsert = true
        late = db.table(table).insert({ id: 1, name: 'late' }).then(() => 'ran', (error: unknown) => error)
      })

      expect(await late).toBeInstanceOf(TransactionError)
      expect(restored).toBe(true)
      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([])
    }, 3_000)

    it('leaves no abort listener or timer behind when queries reusing one signal are rejected at submission', async () => {
      let pauseQueries = false
      const delay = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms) })
      const guardTimers = new Set<unknown>()
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
        const handle = realSetTimeout(handler, timeout)
        if (timeout === 60_000) guardTimers.add(handle)
        return handle
      }) as typeof setTimeout
      globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
        guardTimers.delete(handle)
        return realClearTimeout(handle)
      }) as typeof clearTimeout
      onTestFinished(() => {
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
        for (const handle of guardTimers) realClearTimeout(handle as ReturnType<typeof setTimeout>)
      })

      const { db, schema } = await openDatabase(driver, {
        security: { allowUnsafeRawSql: true },
        logger: {
          onQueryStart: async entry => {
            if (entry.source === 'schema:enableForeignKeys') await delay(80)
            else if (pauseQueries && entry.kind === 'query') await delay(20)
          },
        },
      })
      const controller = new AbortController()
      const listenersBefore = getEventListeners(controller.signal, 'abort').length

      let outcomes!: Promise<unknown>[]
      await schema.withoutForeignKeyConstraints(async () => {
        pauseQueries = true
        outcomes = Array.from({ length: 20 }, () => db.unsafeQuery(unsafeSql('select 1'), { signal: controller.signal, timeoutMs: 60_000 })
          .then(() => 'ran', (error: unknown) => error))
        pauseQueries = false
      })
      for (const outcome of await Promise.all(outcomes)) expect(outcome).toBeInstanceOf(TransactionError)

      expect(getEventListeners(controller.signal, 'abort').length).toBe(listenersBefore)
      expect(guardTimers.size).toBe(0)
    }, 5_000)

    if (driver !== 'sqlite') {
      it('applies foreign-key relaxation to every query in a scoped callback and restores pooled connections', async () => {
        const { db, schema } = await openDatabase(driver)
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const readStates = async () => (await Promise.all(Array.from({ length: 6 }, () => db.queryCompiled(state))))
          .map(result => String(result.rows[0]!.state))
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        const enforced = driver === 'postgres' ? 'origin' : '1'

        await schema.withoutForeignKeyConstraints(async () => {
          expect(await readStates()).toEqual(Array.from({ length: 6 }, () => relaxed))
        })
        expect(await readStates()).toEqual(Array.from({ length: 6 }, () => enforced))
      })

      it('keeps foreign-key checks off for the outer callback when a nested scoped call returns', async () => {
        const { db, schema } = await openDatabase(driver)
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const readState = async () => String((await db.queryCompiled(state)).rows[0]!.state)
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        const enforced = driver === 'postgres' ? 'origin' : '1'

        await schema.withoutForeignKeyConstraints(async () => {
          await schema.withoutForeignKeyConstraints(async () => {})
          expect(await readState()).toBe(relaxed)
        })
        expect(await readState()).toBe(enforced)
      })

      it('restores foreign-key checks when a logger fails after the checks are turned off', async () => {
        const { db, schema } = await openDatabase(driver, {
          logger: {
            onQuerySuccess: entry => {
              if (entry.source === 'schema:disableForeignKeys') throw new Error('logger failed')
            },
          },
        })
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }

        await expect(schema.withoutForeignKeyConstraints(async () => {})).rejects.toThrow('logger failed')
        expect(String((await db.queryCompiled(state)).rows[0]!.state)).toBe(driver === 'postgres' ? 'origin' : '1')
      })

      it('runs the standalone enable through the query logger', async () => {
        const sources: string[] = []
        const { schema } = await openDatabase(driver, {
          logger: {
            onQueryStart: entry => {
              sources.push(entry.source ?? '')
            },
          },
        })

        await schema.enableForeignKeyConstraints()
        expect(sources).toContain('schema:enableForeignKeys')
      })

      it('restores foreign-key checks when a logger fails before the restore statement starts, and reports the logger error', async () => {
        const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
        errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
        onTestFinished(() => { errorReportingInternals.configure(undefined) })
        const loggerError = new Error('logger failed')
        const { db, schema } = await openDatabase(driver, {
          logger: {
            onQueryStart: entry => {
              if (entry.source === 'schema:enableForeignKeys') throw loggerError
            },
          },
        })
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }

        await expect(schema.withoutForeignKeyConstraints(async () => {})).resolves.toBeUndefined()
        expect(String((await db.queryCompiled(state)).rows[0]!.state)).toBe(driver === 'postgres' ? 'origin' : '1')
        expect(reports).toEqual([{ error: loggerError, context: { capability: 'db', operation: 'schema.restoreForeignKeys' } }])
      })

      it('runs transactions started inside a scoped callback one at a time on the pinned connection', async () => {
        const { db, schema, table } = await openDatabase(driver)
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        const events: string[] = []
        const pause = () => new Promise(resolve => { setTimeout(resolve, 20) })

        await schema.withoutForeignKeyConstraints(async () => {
          await Promise.all([
            db.transaction(async tx => {
              events.push('a:start')
              expect(String((await tx.queryCompiled(state)).rows[0]!.state)).toBe(relaxed)
              await pause()
              await tx.table(table).insert({ id: 1, name: 'first' })
              events.push('a:end')
            }),
            db.transaction(async tx => {
              events.push('b:start')
              expect(String((await tx.queryCompiled(state)).rows[0]!.state)).toBe(relaxed)
              await tx.table(table).insert({ id: 2, name: 'second' })
              throw new Error('second failed')
            }).catch(() => {}),
          ])
        })

        expect(events).toEqual(['a:start', 'a:end', 'b:start'])
        expect((await db.table(table).select('id').orderBy('id').get())).toEqual([{ id: 1 }])
      })

      it('rejects transactions that reach the pinned connection after its callback has returned, without writing', async () => {
        const { db, schema, table } = await openDatabase(driver)
        let first!: Promise<unknown>
        let second!: Promise<unknown>

        await schema.withoutForeignKeyConstraints(async () => {
          first = db.transaction(async tx => {
            await tx.table(table).insert({ id: 1, name: 'first' })
          }).then(() => undefined, (error: unknown) => error)
          second = db.transaction(async tx => {
            await tx.table(table).insert({ id: 2, name: 'second' })
          }).then(() => undefined, (error: unknown) => error)
        })

        expect(String(await first)).toContain('must finish before the callback returns')
        expect(String(await second)).toContain('must finish before the callback returns')
        expect((await db.table(table).select('id').orderBy('id').get())).toEqual([])
      })

      it('disables foreign-key checks again for work that starts after a scoped callback has finished', async () => {
        const { db, schema } = await openDatabase(driver)
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        let laterState: string | undefined

        let later!: Promise<void>
        await schema.withoutForeignKeyConstraints(async () => {
          later = gate.then(() => schema.withoutForeignKeyConstraints(async () => {
            laterState = String((await db.queryCompiled(state)).rows[0]!.state)
          }))
        })
        release()
        await later
        expect(laterState).toBe(relaxed)
      })
    }

    if (driver !== 'postgres') {
      it('rejects unsupported vectors before executing a migration', async () => {
        const { schema } = await openDatabase(driver)
        const name = `holo_vector_${randomUUID().replaceAll('-', '')}`
        await expect(schema.createTable(name, table => { table.vector('embedding', { dimensions: 3 }) })).rejects.toThrow(SchemaError)
        expect(await schema.hasTable(name)).toBe(false)
      })
    }
  })
}
