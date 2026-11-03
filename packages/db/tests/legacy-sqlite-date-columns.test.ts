import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  belongsToMany,
  clearGeneratedTables,
  createSchemaService,
  defineModel,
  holoRuntimeInternals,
  registerGeneratedTables,
  renderGeneratedSchemaModule,
  resetDB,
  type DatabaseContext,
  type TableDefinition,
} from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

const legacyTables = ['legacy_date_users', 'legacy_date_tags', 'legacy_date_tag_user'] as const

const legacyDdl = [
  'CREATE TABLE "legacy_date_users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "birthday" TEXT, "created_at" TEXT, "updated_at" TEXT, "deleted_at" TEXT)',
  'CREATE TABLE "legacy_date_tags" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT)',
  'CREATE TABLE "legacy_date_tag_user" ("user_id" INTEGER NOT NULL, "tag_id" INTEGER NOT NULL, "is_primary" INTEGER NOT NULL DEFAULT 0, "created_at" TEXT, "updated_at" TEXT, UNIQUE ("user_id", "tag_id"))',
]

beforeEach(() => {
  resetDB()
  clearGeneratedTables()
})

async function readGeneratedTables(db: DatabaseContext, tableNames: readonly string[]): Promise<TableDefinition[]> {
  const reader = createSchemaReader(db)
  const tables: TableDefinition[] = []
  for (const tableName of tableNames) {
    const table = await reader.readTable(tableName)
    if (!table) throw new Error(`Table "${tableName}" was not read from the database.`)
    tables.push(table)
  }
  return tables
}

async function registerLegacyTables(db: DatabaseContext): Promise<TableDefinition[]> {
  const tables = await readGeneratedTables(db, legacyTables)
  registerGeneratedTables(Object.fromEntries(tables.map(table => [table.tableName, table])))
  return tables
}

async function openLegacyDatabase() {
  const { db } = await openDatabase('sqlite')
  for (const sql of legacyDdl) {
    await db.executeCompiled({ sql, source: 'test:legacy-sqlite-date-table' })
  }
  const tables = await registerLegacyTables(db)
  return { db, tables }
}

function defineLegacyModels() {
  const Tag = defineModel('legacy_date_tags', { guarded: [] })
  const User = defineModel('legacy_date_users', {
    fillable: ['name', 'birthday', 'created_at'],
    softDeletes: true,
    relations: {
      tags: belongsToMany(() => Tag, 'legacy_date_tag_user', 'user_id', 'tag_id').withTimestamps(),
    },
  })
  return { Tag, User }
}

async function storedText(db: DatabaseContext, column: string, id: number): Promise<unknown> {
  const result = await db.queryCompiled<Record<string, unknown>>({
    sql: `SELECT "${column}" AS value FROM "legacy_date_users" WHERE "id" = ?`,
    bindings: [id],
  })
  return result.rows[0]?.value
}

describe('SQLite date columns created before 0.6', () => {
  it('writes the Generated schema module the legacy date type tests compile against', async () => {
    const { tables } = await openLegacyDatabase()

    await expect(renderGeneratedSchemaModule(tables)).toMatchFileSnapshot('./fixtures/legacy-sqlite-dates/sqlite.generated.ts')
  })

  it('reads the model timestamps as dates', async () => {
    await openLegacyDatabase()
    const { User } = defineLegacyModels()

    const created = await User.create({ name: 'Ada' })
    const found = await User.findOrFail(created.id)

    for (const user of [created, found]) {
      expect(user.created_at).toBeInstanceOf(Date)
      expect(user.updated_at).toBeInstanceOf(Date)
    }
    expect(found.created_at).toEqual(created.created_at)
  })

  it('stores a Date written to a TEXT column as ISO text on create and update', async () => {
    const { db } = await openLegacyDatabase()
    const { User } = defineLegacyModels()

    const created = await User.create({ name: 'Ada', created_at: new Date('2026-01-02T03:04:05.000Z') })
    expect(await storedText(db, 'created_at', created.id)).toBe('2026-01-02T03:04:05.000Z')
    await User.update(created.id, { created_at: new Date('2026-02-03T04:05:06.000Z') })
    expect(await storedText(db, 'created_at', created.id)).toBe('2026-02-03T04:05:06.000Z')
    expect((await User.findOrFail(created.id)).created_at).toEqual(new Date('2026-02-03T04:05:06.000Z'))

    const users = db.table('legacy_date_users')
    await users.insert({ name: 'Grace', birthday: new Date('1990-02-03T04:05:06.000Z') })
    expect(await users.where('name', 'Grace').value('birthday')).toBe('1990-02-03T04:05:06.000Z')
    await users.where('name', 'Grace').update({ birthday: new Date('1991-03-04T05:06:07.000Z') })
    expect(await users.where('name', 'Grace').value('birthday')).toBe('1991-03-04T05:06:07.000Z')
  })

  it('filters a TEXT date column by a Date', async () => {
    const { db } = await openLegacyDatabase()
    const { User } = defineLegacyModels()
    const createdAt = new Date('2026-01-02T03:04:05.000Z')
    const ada = await User.create({ name: 'Ada', created_at: createdAt })
    await User.create({ name: 'Grace', created_at: new Date('2025-01-01T00:00:00.000Z') })

    expect((await User.where('created_at', createdAt).get()).map(user => user.id)).toEqual([ada.id])
    expect((await User.where('created_at', '>', new Date('2025-06-01T00:00:00.000Z')).get()).map(user => user.id)).toEqual([ada.id])
    expect(await db.table('legacy_date_users').where('created_at', createdAt).pluck('name')).toEqual(['Ada'])
  })

  it('soft deletes and restores with deleted_at read as a date', async () => {
    await openLegacyDatabase()
    const { User } = defineLegacyModels()
    const user = await User.create({ name: 'Ada' })

    await user.delete()
    expect(user.deleted_at).toBeInstanceOf(Date)
    const trashed = await User.onlyTrashed().firstOrFail()
    expect(trashed.deleted_at).toBeInstanceOf(Date)
    expect(await User.find(user.id)).toBeUndefined()

    await trashed.restore()
    expect(trashed.deleted_at).toBeNull()
    const restored = await User.findOrFail(user.id)
    expect(restored.deleted_at).toBeNull()
    expect(restored.updated_at).toBeInstanceOf(Date)
  })

  it('reads withTimestamps pivot columns as dates', async () => {
    await openLegacyDatabase()
    const { Tag, User } = defineLegacyModels()
    const user = await User.create({ name: 'Ada' })
    const tag = await Tag.create({ name: 'math' })

    await user.attach('tags', tag.id)
    const loaded = await User.with('tags').findOrFail(user.id)
    const pivot = loaded.tags[0]?.pivot

    expect(pivot?.created_at).toBeInstanceOf(Date)
    expect(pivot?.updated_at).toEqual(pivot?.created_at)
    expect(loaded.tags[0]?.created_at).toBeInstanceOf(Date)
  })

  it('reads a legacy INTEGER pivot boolean as a boolean once change() rebuilds the column', async () => {
    const { db } = await openLegacyDatabase()
    const Tag = defineModel('legacy_date_tags', { guarded: [] })
    const defineUser = () => defineModel('legacy_date_users', {
      guarded: [],
      relations: {
        tags: belongsToMany(() => Tag, 'legacy_date_tag_user', 'user_id', 'tag_id').withPivot('is_primary'),
      },
    })
    const user = await defineUser().create({ name: 'Ada' })
    const tag = await Tag.create({ name: 'math' })
    await user.attach('tags', tag.id, { is_primary: true })
    expect((await defineUser().with('tags').findOrFail(user.id)).tags[0]?.pivot.is_primary).toBe(1)

    await createSchemaService(db).table('legacy_date_tag_user', (table) => {
      table.boolean('is_primary').default(false).change()
    })
    await registerLegacyTables(db)

    expect((await defineUser().with('tags').findOrFail(user.id)).tags[0]?.pivot.is_primary).toBe(true)
  })
})

for (const driver of ['postgres', 'mysql'] as const) {
  describe(`${driver} model timestamps`, () => {
    it('keep reading, writing and filtering timestamp columns as dates', async () => {
      const { db, schema } = await openDatabase(driver)
      const tableName = `native_date_users_${driver}`
      await schema.dropTable(tableName)
      onTestFinished(() => schema.dropTable(tableName))
      await schema.createTable(tableName, (table) => {
        table.id()
        table.string('name')
        table.datetime('birthday').nullable()
        table.timestamps()
        table.softDeletes()
      })
      const tables = await readGeneratedTables(db, [tableName])
      registerGeneratedTables(Object.fromEntries(tables.map(table => [table.tableName, table])))
      const User = defineModel(tableName, { guarded: [], softDeletes: true })
      const birthday = new Date('1990-02-03T04:05:06.000Z')

      const created = await User.create({ name: 'Ada', birthday })
      const found = await User.findOrFail(created.id)
      expect(found.birthday).toEqual(birthday)
      expect(found.created_at).toBeInstanceOf(Date)
      expect(found.updated_at).toBeInstanceOf(Date)
      expect((await User.where('birthday', birthday).get()).map(user => user.id)).toEqual([created.id])

      await found.delete()
      expect((await User.onlyTrashed().firstOrFail()).deleted_at).toBeInstanceOf(Date)
      await (await User.onlyTrashed().firstOrFail()).restore()
      expect((await User.findOrFail(created.id)).deleted_at).toBeNull()
    })
  })
}
