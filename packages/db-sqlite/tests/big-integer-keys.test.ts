import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DB,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  createSchemaService,
  defineGeneratedTable,
  defineModel,
  resetDB,
} from '@holo-js/db'
import { createSQLiteAdapter } from '../src'

describe('SQLite keys beyond the safe integer range', () => {
  let directory: string
  let database: ReturnType<typeof createDatabase>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-big-keys-'))
    const adapter = createSQLiteAdapter({ filename: join(directory, 'database.sqlite') })
    await adapter.ensureDatabaseExists()
    database = createDatabase({ adapter, dialect: createDialect('sqlite') })
    await createSchemaService(database).createTable('counted', (table) => {
      table.id()
      table.string('name')
    })
    await database.executeCompiled({ sql: 'INSERT INTO "counted" ("id", "name") VALUES (9007199254740993, \'seed\')', source: 'test:seed' })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: database, analytics: database } }))
  })

  afterEach(async () => {
    resetDB()
    await database.disconnect()
    await rm(directory, { recursive: true, force: true })
  })

  it('returns the inserted key as its exact text instead of a rounded number', async () => {
    const counted = defineGeneratedTable('counted', { id: column.id(), name: column.string() })

    const byName = await DB.table('counted').insertGetId({ name: 'a' })
    const byDefinition = await DB.table(counted).insertGetId({ name: 'b' })

    expect([byName, byDefinition]).toEqual(['9007199254740994', '9007199254740995'])
    expect(await DB.table('counted').where('name', 'b').value('id')).toBe('9007199254740995')
    expect(await DB.table('counted').count()).toBe(3)
  })

  it('creates and finds a model whose auto-increment key is beyond the safe integer range', async () => {
    const Counted = defineModel('counted', { connectionName: 'analytics', fillable: ['name'], timestamps: false })

    const created = await Counted.create({ name: 'c' })

    expect(created.get('id')).toBe('9007199254740994')
    expect((await Counted.findOrFail(created.get('id'))).get('name')).toBe('c')
  })
})
