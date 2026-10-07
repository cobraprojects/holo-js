import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { column, createDatabase, createDialect, createMigrationService, createSchemaService, defineGeneratedTable, defineMigration } from '../src'

describe('schema mutation outcomes', () => {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  const schema = createSchemaService(db)

  beforeEach(async () => {
    db.getSchemaRegistry().clear()
    await adapter.initialize()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('does not publish metadata when table creation fails', async () => {
    await expect(schema.createTable('invalid', (table) => {
      table.id()
      table.id('second_id')
    })).rejects.toThrow()
    expect(await schema.hasTable('invalid')).toBe(false)
    expect(db.getSchemaRegistry().has('invalid')).toBe(false)
  })
  it('restores the original SQLite table when a column rebuild fails', async () => {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name').nullable()
    })
    await db.executeCompiled({ sql: 'INSERT INTO users (name) VALUES (NULL)', source: 'test:seed' })
    const original = db.getSchemaRegistry().get('users')
    await expect(schema.table('users', (table) => {
      table.string('name').change()
    })).rejects.toThrow()
    expect(await schema.getTables()).toEqual(['users'])
    expect(db.getSchemaRegistry().get('users')).toBe(original)
    expect((await schema.getColumns('users')).find(column => column.name === 'name')?.notNull).toBe(false)
    expect((await db.queryCompiled({ sql: 'SELECT name FROM users', source: 'test:read' })).rows).toEqual([{ name: null }])
  })

  it('retains a declared definition when its creation fails', async () => {
    const declared = schema.register(defineGeneratedTable('invalid', { id: column.id(), second_id: column.id() }))
    await expect(schema.sync()).rejects.toThrow()
    expect(await schema.hasTable('invalid')).toBe(false)
    expect(db.getSchemaRegistry().get('invalid')).toBe(declared)
  })

  it('retains successful preceding alterations when a later alteration fails', async () => {
    await schema.createTable('users', table => { table.id() })
    await expect(schema.table('users', (table) => {
      table.string('name').nullable()
      table.string('name').nullable()
    })).rejects.toThrow()
    expect((await schema.getColumns('users')).map(column => column.name)).toEqual(['id', 'name'])
    expect(Object.keys(db.getSchemaRegistry().get('users')!.columns)).toEqual(['id', 'name'])
  })

  it('keeps metadata aligned after successful and refused rename and drop operations', async () => {
    await schema.createTable('users', table => { table.id() })
    await schema.createTable('occupied', table => { table.id() })
    const original = db.getSchemaRegistry().get('users')
    await expect(schema.renameTable('users', 'occupied')).rejects.toThrow()
    expect(db.getSchemaRegistry().get('users')).toBe(original)
    await schema.renameTable('users', 'renamed')
    expect(await schema.hasTable('renamed')).toBe(true)
    expect(db.getSchemaRegistry().has('users')).toBe(false)
    expect(db.getSchemaRegistry().has('renamed')).toBe(true)
    await schema.dropTable('renamed')
    expect(await schema.hasTable('renamed')).toBe(false)
    expect(db.getSchemaRegistry().has('renamed')).toBe(false)
  })

  it('records only indexes whose DDL succeeded during partial table creation', async () => {
    await expect(schema.createTable('users', (table) => {
      table.id()
      table.index(['id'], 'users_id_index')
      table.index(['missing'], 'users_missing_index')
    })).rejects.toThrow()
    expect(await schema.hasTable('users')).toBe(true)
    expect((await schema.getIndexes('users')).map(index => index.name)).toEqual(['users_id_index'])
    expect(db.getSchemaRegistry().get('users')?.indexes.map(index => index.name)).toEqual(['users_id_index'])
  })

  it('restores metadata on root rollback while preserving an earlier declaration', async () => {
    const declared = schema.register(defineGeneratedTable('declared', { id: column.id() }))
    await expect(db.transaction(async (tx) => {
      const transactionalSchema = createSchemaService(tx)
      await transactionalSchema.sync([declared])
      await transactionalSchema.table('declared', (table) => { table.string('name').nullable() })
      await transactionalSchema.createTable('temporary', (table) => { table.id() })
      expect(Object.keys(tx.getSchemaRegistry().get('declared')!.columns)).toEqual(['id', 'name'])
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect(await schema.getTables()).toEqual([])
    expect(db.getSchemaRegistry().get('declared')).toBe(declared)
    expect(db.getSchemaRegistry().has('temporary')).toBe(false)
  })

  it('rolls back a nested scope without discarding its parent changes and commits later mutations', async () => {
    await db.transaction(async (tx) => {
      const parent = createSchemaService(tx)
      await parent.createTable('users', table => { table.id(); table.string('name').nullable() })
      const preceding = tx.getSchemaRegistry().get('users')
      await expect(tx.transaction(async (nested) => {
        const child = createSchemaService(nested)
        await child.renameTable('users', 'renamed')
        await child.table('renamed', table => { table.string('name').default('guest').change() })
        await child.createTable('temporary', table => { table.id() })
        throw new Error('nested abort')
      })).rejects.toThrow('nested abort')
      expect(await parent.getTables()).toEqual(['users'])
      expect(tx.getSchemaRegistry().get('users')).toBe(preceding)
      expect(tx.getSchemaRegistry().has('renamed')).toBe(false)
      expect(tx.getSchemaRegistry().has('temporary')).toBe(false)
      await parent.table('users', table => { table.string('nickname').nullable() })
    })
    expect(Object.keys(db.getSchemaRegistry().get('users')!.columns)).toEqual(['id', 'name', 'nickname'])
    expect((await schema.getColumns('users')).map(column => column.name)).toEqual(['id', 'name', 'nickname'])
  })

  it('restores dropped and renamed definitions after an outer rollback of committed savepoints', async () => {
    await schema.createTable('users', table => { table.id() })
    await schema.createTable('posts', table => { table.id() })
    const users = db.getSchemaRegistry().get('users')
    const posts = db.getSchemaRegistry().get('posts')
    await expect(db.transaction(async (tx) => {
      await tx.transaction(async (nested) => {
        const child = createSchemaService(nested)
        await child.renameTable('users', 'renamed')
        await child.dropTable('posts')
      })
      throw new Error('outer abort')
    })).rejects.toThrow('outer abort')
    expect(await schema.getTables()).toEqual(['posts', 'users'])
    expect(db.getSchemaRegistry().get('users')).toBe(users)
    expect(db.getSchemaRegistry().get('posts')).toBe(posts)
    expect(db.getSchemaRegistry().has('renamed')).toBe(false)
  })

  it('preserves unrelated definitions registered while a transaction is pending', async () => {
    let release!: () => void
    let ready!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { ready = resolve })
    const transaction = db.transaction(async (tx) => {
      await createSchemaService(tx).createTable('temporary', table => { table.id() })
      ready()
      await pending
      throw new Error('abort')
    })
    await started
    const unrelated = schema.register(defineGeneratedTable('unrelated', { id: column.id() }))
    release()
    await expect(transaction).rejects.toThrow('abort')
    expect(db.getSchemaRegistry().get('unrelated')).toBe(unrelated)
    expect(db.getSchemaRegistry().has('temporary')).toBe(false)
  })

  it('leaves failed migrations pending with their schema metadata rolled back', async () => {
    const migration = defineMigration({
      name: '2026_10_07_120000_create_users',
      async up({ schema }) {
        await schema.createTable('users', table => { table.id() })
        await schema.table('users', table => { table.string('name').nullable() })
        throw new Error('migration abort')
      },
    })
    const migrator = createMigrationService(db, [migration])
    await expect(migrator.migrate()).rejects.toThrow('migration abort')
    expect(await schema.hasTable('users')).toBe(false)
    expect(db.getSchemaRegistry().has('users')).toBe(false)
    expect(await migrator.status()).toEqual([{ name: migration.name, status: 'pending' }])
  })

})
