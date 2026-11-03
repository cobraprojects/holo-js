import { describe, expect, it } from 'vitest'
import { type DatabaseContext, holoRuntimeInternals, SchemaError } from '../src'
import { openDatabase } from './support/database'

async function readForeignKeyNames(db: DatabaseContext, tableName: string) {
  const structure = await holoRuntimeInternals.createSchemaReader(db).readTableStructure(tableName)
  return (structure?.foreignKeys ?? []).map(({ name, table }) => ({ name, table })).sort((left, right) => `${left.table}${left.name}`.localeCompare(`${right.table}${right.name}`))
}

describe('SQLite schema changes on tables created by raw SQL', () => {
  it('drops a primary key whose quoted constraint name contains a space', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE "pairs" ("a" INTEGER, "b" INTEGER, CONSTRAINT "pk name" PRIMARY KEY ("a", "b"))')
    await db.table('pairs').insert({ a: 1, b: 1 })

    await schema.table('pairs', (table) => { table.dropPrimary() })

    await db.table('pairs').insert({ a: 1, b: 1 })
    expect(await db.table('pairs').count()).toBe(2)
  })

  it('drops a unique constraint whose quoted constraint name contains a space', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE "accounts" ("id" INTEGER PRIMARY KEY, "email" TEXT, CONSTRAINT "unique email" UNIQUE ("email"))')
    await db.table('accounts').insert({ id: 1, email: 'a@example.com' })

    await schema.table('accounts', (table) => { table.dropUnique(['email']) })

    await db.table('accounts').insert({ id: 2, email: 'a@example.com' })
    expect(await db.table('accounts').count()).toBe(2)
  })

  it('drops a foreign key that references a table named like a column-constraint keyword', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE generated (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES generated(id))')

    await schema.table('children', (table) => { table.dropForeign(['parent_id']) })

    await db.table('children').insert({ id: 1, parent_id: 99 })
    expect(await schema.getForeignKeys('children')).toEqual([])
  })

  it('reads and drops foreign keys whose names use every SQLite identifier quote style', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
    await adapter.execute(`CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      single_id INTEGER CONSTRAINT 'single''s fk' REFERENCES parents(id),
      double_id INTEGER CONSTRAINT "double ""fk""" REFERENCES parents(id),
      backtick_id INTEGER,
      bracket_id INTEGER,
      CONSTRAINT \`backtick\`\`s fk\` FOREIGN KEY (backtick_id) REFERENCES parents(id),
      CONSTRAINT [bracket fk] FOREIGN KEY (bracket_id) REFERENCES parents(id)
    )`)
    await db.table('parents').insert({ id: 1 })

    expect((await readForeignKeyNames(db, 'children')).map(({ name }) => name))
      .toEqual(['backtick`s fk', 'bracket fk', 'double "fk"', 'single\'s fk'])

    await schema.table('children', (table) => {
      table.dropForeign('single\'s fk')
      table.dropForeign('double "fk"')
      table.dropForeign('backtick`s fk')
      table.dropForeign('bracket fk')
    })

    await db.table('children').insert({ id: 1, single_id: 9, double_id: 9, backtick_id: 9, bracket_id: 9 })
    expect(await schema.getForeignKeys('children')).toEqual([])
  })

  it('reads and drops a named foreign key declared after an unnamed one on the same column', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE first_parents (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE second_parents (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES first_parents(id) CONSTRAINT second_fk REFERENCES second_parents(id))')
    await db.table('first_parents').insert([{ id: 1 }, { id: 2 }])
    await db.table('second_parents').insert({ id: 1 })

    expect(await readForeignKeyNames(db, 'children'))
      .toEqual([{ name: undefined, table: 'first_parents' }, { name: 'second_fk', table: 'second_parents' }])

    await schema.table('children', (table) => { table.dropForeign('second_fk') })

    await db.table('children').insert({ id: 1, parent_id: 2 })
    await expect(db.table('children').insert({ id: 2, parent_id: 3 })).rejects.toThrow()
  })

  it('renames an index created with a single-quoted name and IF NOT EXISTS', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT)')
    await adapter.execute('CREATE UNIQUE INDEX IF NOT EXISTS \'old_email\' ON accounts (email)')

    await schema.table('accounts', (table) => { table.renameIndex('old_email', 'accounts_email_unique') })

    expect((await schema.getIndexes('accounts')).map(index => index.name)).toEqual(['accounts_email_unique'])
    await db.table('accounts').insert({ id: 1, email: 'a@example.com' })
    await expect(db.table('accounts').insert({ id: 2, email: 'a@example.com' })).rejects.toThrow()
  })

  it('keeps a foreign key with a SET NULL and SET DEFAULT action tail when change() rebuilds its column', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL DEFAULT NULL REFERENCES parents(id) ON DELETE SET NULL ON UPDATE SET DEFAULT NOT DEFERRABLE INITIALLY IMMEDIATE)')
    await db.table('parents').insert([{ id: 1 }, { id: 2 }])
    await db.table('children').insert({ id: 1, parent_id: 1 })

    await schema.table('children', (table) => { table.integer('parent_id').nullable().change() })

    await expect(db.table('children').insert({ id: 2, parent_id: 3 })).rejects.toThrow()
    await db.table('parents').where('id', 1).delete()
    expect(await db.table('children').pluck('parent_id')).toEqual([null])
    expect(await schema.getForeignKeys('children')).toEqual([expect.objectContaining({ onDelete: 'SET NULL', onUpdate: 'SET DEFAULT' })])
  })

  it('replaces a NOT NULL ON CONFLICT clause and keeps a CHECK with nested parentheses and quotes when change() rebuilds its column', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT NOT NULL ON CONFLICT FAIL CHECK (length(trim(code, \')\')) > 1 AND code <> \'no (way)\'))')

    await schema.table('codes', (table) => { table.text('code').nullable().change() })

    await db.table('codes').insert([{ id: 1, code: 'ok' }, { id: 2, code: null }])
    await expect(db.table('codes').insert({ id: 3, code: 'no (way)' })).rejects.toThrow()
    await expect(db.table('codes').insert({ id: 4, code: 'x)' })).rejects.toThrow()
    expect(await db.table('codes').orderBy('id').pluck('code')).toEqual(['ok', null])
  })

  it('keeps a GENERATED ALWAYS AS STORED expression when change() rebuilds the generated column', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE prices (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, doubled INTEGER NOT NULL GENERATED ALWAYS AS (amount * 2) STORED)')
    await db.table('prices').insert({ id: 1, amount: 2 })

    await schema.table('prices', (table) => { table.integer('doubled').nullable().change() })

    await db.table('prices').insert({ id: 2, amount: 5 })
    expect(await db.table('prices').orderBy('id').pluck('doubled')).toEqual([4, 10])
  })

  it('rejects giving a default to a generated column on change() and leaves the table unchanged', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE prices (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, doubled INTEGER AS (amount * 2) VIRTUAL)')
    await db.table('prices').insert({ id: 1, amount: 2 })

    await expect(schema.table('prices', (table) => { table.integer('doubled').default(1).change() }))
      .rejects.toThrow(new SchemaError('SQLite cannot give column "doubled" on table "prices" a default because it is a generated column.'))

    expect(await db.table('prices').pluck('doubled')).toEqual([4])
  })
})
