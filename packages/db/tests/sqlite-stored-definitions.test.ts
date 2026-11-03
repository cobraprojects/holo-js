import { describe, expect, it } from 'vitest'
import { type DatabaseContext, holoRuntimeInternals, SchemaError } from '../src'
import { openDatabase } from './support/database'

async function readStructure(db: DatabaseContext, tableName: string) {
  const structure = await holoRuntimeInternals.createSchemaReader(db).readTableStructure(tableName)
  if (!structure) throw new Error(`Missing table ${tableName}`)
  return structure
}

async function readForeignKeys(db: DatabaseContext, tableName: string) {
  return (await readStructure(db, tableName)).foreignKeys
    .map(({ name, from, to, onUpdate, onDelete }) => ({ name, from, to, onUpdate, onDelete }))
    .sort((left, right) => `${left.name}`.localeCompare(`${right.name}`))
}

async function readIndexColumns(db: DatabaseContext, tableName: string) {
  return (await readStructure(db, tableName)).indexes.map(({ name, columns }) => ({ name, columns }))
}

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

  it('drops only the unique constraint SQLite numbered in the autoindex name when two uniques share columns', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT, UNIQUE(email COLLATE NOCASE), UNIQUE(email COLLATE BINARY))')

    await schema.table('u', (table) => { table.dropUnique('sqlite_autoindex_u_2') })

    expect(await readIndexColumns(db, 'u')).toEqual([{ name: 'sqlite_autoindex_u_1', columns: ['email'] }])
    await db.table('u').insert({ id: 1, email: 'A@example.com' })
    await expect(db.table('u').insert({ id: 2, email: 'a@example.com' })).rejects.toThrow()
  })

  it('maps autoindex numbers to inline and table-level unique and primary key constraints in SQLite declaration order', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute(`CREATE TABLE m (
      a TEXT UNIQUE,
      b TEXT PRIMARY KEY,
      c TEXT,
      d TEXT UNIQUE COLLATE NOCASE,
      UNIQUE (c, a),
      UNIQUE (a DESC),
      UNIQUE (d),
      UNIQUE (d COLLATE BINARY)
    )`)
    expect(await readIndexColumns(db, 'm')).toEqual([
      { name: 'sqlite_autoindex_m_1', columns: ['a'] },
      { name: 'sqlite_autoindex_m_2', columns: ['b'] },
      { name: 'sqlite_autoindex_m_3', columns: ['d'] },
      { name: 'sqlite_autoindex_m_4', columns: ['c', 'a'] },
      { name: 'sqlite_autoindex_m_5', columns: ['d'] },
    ])

    await schema.table('m', (table) => { table.dropUnique('sqlite_autoindex_m_3') })

    expect(await readIndexColumns(db, 'm')).toEqual([
      { name: 'sqlite_autoindex_m_1', columns: ['a'] },
      { name: 'sqlite_autoindex_m_2', columns: ['b'] },
      { name: 'sqlite_autoindex_m_3', columns: ['c', 'a'] },
      { name: 'sqlite_autoindex_m_4', columns: ['d'] },
    ])
    await db.table('m').insert([{ a: 'a1', b: 'b1', d: 'X' }, { a: 'a2', b: 'b2', d: 'x' }])
    await expect(db.table('m').insert({ a: 'a3', b: 'b3', d: 'x' })).rejects.toThrow()
  })

  it('reads a column whose type name contains a constraint keyword as part of its type and changes it to the new type', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE g (id INTEGER PRIMARY KEY, x GENERATED INT NOT NULL, y GENERATED ALWAYS INT)')

    await schema.table('g', (table) => {
      table.text('x').nullable().change()
      table.integer('y').default(1).change()
    })

    const columns = (await readStructure(db, 'g')).columns
    expect(columns.find(column => column.name === 'x')).toEqual(expect.objectContaining({ fullType: 'TEXT', notNull: false }))
    expect(columns.find(column => column.name === 'y')).toEqual(expect.objectContaining({ fullType: 'INTEGER', defaultExpression: '1', computed: false }))
    await db.table('g').insert({ id: 1, x: null })
    expect(await db.table('g').pluck('y')).toEqual([1])
  })

  it('treats a single-quoted CHECK operand as a string literal, not as an enum check on a column', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE s (id INTEGER PRIMARY KEY, status TEXT, CHECK (\'status\' IN (\'a\', \'b\')))')

    expect((await readStructure(db, 's')).enumChecks).toEqual([])

    await schema.table('s', (table) => { table.string('status').nullable().change() })

    await expect(db.table('s').insert({ id: 1, status: 'a' })).rejects.toThrow()
  })

  it('names two foreign keys on one column to the same parent by their parent columns and actions', async () => {
    const { db, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE p (id INTEGER PRIMARY KEY, code TEXT UNIQUE)')
    await adapter.execute('CREATE TABLE c (id INTEGER PRIMARY KEY, x INTEGER CONSTRAINT fk_id REFERENCES p(id) ON DELETE CASCADE CONSTRAINT fk_code REFERENCES p(code) ON DELETE SET NULL)')

    expect(await readForeignKeys(db, 'c')).toEqual([
      { name: 'fk_code', from: 'x', to: 'code', onUpdate: 'NO ACTION', onDelete: 'SET NULL' },
      { name: 'fk_id', from: 'x', to: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
    ])
  })

  it('names two same-parent foreign keys on the same columns that differ only by their update action', async () => {
    const { db, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE p (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE c (id INTEGER PRIMARY KEY, x INTEGER, CONSTRAINT fk_cascade FOREIGN KEY (x) REFERENCES p ON UPDATE CASCADE, CONSTRAINT fk_restrict FOREIGN KEY (x) REFERENCES p(id) ON UPDATE RESTRICT)')

    expect(await readForeignKeys(db, 'c')).toEqual([
      { name: 'fk_cascade', from: 'x', to: 'id', onUpdate: 'CASCADE', onDelete: 'NO ACTION' },
      { name: 'fk_restrict', from: 'x', to: 'id', onUpdate: 'RESTRICT', onDelete: 'NO ACTION' },
    ])
  })
})

describe('SQLite identifier matching on stored definitions', () => {
  it('drops a unique constraint by columns that differ from the stored columns only in ASCII case', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, UNIQUE (EMAIL))')
    await db.table('accounts').insert({ id: 1, email: 'a@example.com' })

    await schema.table('accounts', (table) => { table.dropUnique(['email']) })

    await db.table('accounts').insert({ id: 2, email: 'a@example.com' })
    expect(await db.table('accounts').count()).toBe(2)
  })

  it('drops an autoindex unique whose stored column and collation names differ from SQLite\'s only in ASCII case', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT COLLATE nocase, UNIQUE (EMAIL), UNIQUE (Email COLLATE binary))')

    await schema.table('accounts', (table) => { table.dropUnique('sqlite_autoindex_accounts_1') })

    await db.table('accounts').insert([{ id: 1, email: 'A@example.com' }, { id: 2, email: 'a@example.com' }])
    await expect(db.table('accounts').insert({ id: 3, email: 'a@example.com' })).rejects.toThrow()
  })

  it('drops an unnamed foreign key by columns that differ from the stored columns only in ASCII case', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY (PARENT_ID) REFERENCES parents(id))')

    await schema.table('children', (table) => { table.dropForeign(['parent_id']) })

    await db.table('children').insert({ id: 1, parent_id: 99 })
    expect(await schema.getForeignKeys('children')).toEqual([])
  })

  it('reads an enum check on a column named in a different ASCII case under the column\'s own name', async () => {
    const { db, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE s (id INTEGER PRIMARY KEY, status TEXT, CHECK (STATUS IN (\'a\', \'b\')))')

    expect((await readStructure(db, 's')).enumChecks).toEqual([{ column: 'status', values: ['a', 'b'] }])
  })

  it('changes a column named in a different ASCII case and drops its enum check named in another case', async () => {
    const { db, schema, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE s (id INTEGER PRIMARY KEY, Status TEXT NOT NULL, CHECK (STATUS IN (\'a\', \'b\')))')

    await schema.table('s', (table) => { table.string('status').nullable().change() })

    await db.table('s').insert([{ id: 1, status: 'z' }, { id: 2, status: null }])
    expect(await db.table('s').count()).toBe(2)
  })

  it('names foreign keys on columns that differ only in non-ASCII case as distinct columns, as SQLite does', async () => {
    const { db, adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE p (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE c (id INTEGER PRIMARY KEY, "é" INTEGER CONSTRAINT fk_lower REFERENCES p(id), "É" INTEGER CONSTRAINT fk_upper REFERENCES p(id))')

    expect(await readForeignKeys(db, 'c')).toEqual([
      { name: 'fk_lower', from: 'é', to: 'id', onUpdate: 'NO ACTION', onDelete: 'NO ACTION' },
      { name: 'fk_upper', from: 'É', to: 'id', onUpdate: 'NO ACTION', onDelete: 'NO ACTION' },
    ])
  })
})
