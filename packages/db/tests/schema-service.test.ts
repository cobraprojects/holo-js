import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { CapabilityError, column, createSchemaService, SchemaError } from '../src'
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

      it('restores foreign-key checks when a logger fails before the restore statement starts', async () => {
        const { db, schema } = await openDatabase(driver, {
          logger: {
            onQueryStart: entry => {
              if (entry.source === 'schema:enableForeignKeys') throw new Error('logger failed')
            },
          },
        })
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }

        await schema.withoutForeignKeyConstraints(async () => {})
        expect(String((await db.queryCompiled(state)).rows[0]!.state)).toBe(driver === 'postgres' ? 'origin' : '1')
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
          })
          second = db.transaction(async tx => {
            await tx.table(table).insert({ id: 2, name: 'second' })
          })
        })

        await expect(first).rejects.toThrow('must finish before the callback returns')
        await expect(second).rejects.toThrow('must finish before the callback returns')
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
