import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  ConfigurationError,
  createDatabase,
  createDialect,
  createMigrationService,
  createSchemaService,
  defineMigration,
  type MigrationDefinition,
  createMigrationFileName,
  createMigrationTimestamp,
  generateMigrationTemplate,
  inferMigrationTableName,
  inferMigrationTemplateKind,
  normalizeMigrationSlug } from '../src'

describe('migration template generation', () => {
  it('normalizes migration names and creates timestamped file names', () => {
    const date = new Date('2026-03-25T10:11:12.000Z')

    expect(normalizeMigrationSlug(' Create Users Table ')).toBe('create_users_table')
    expect(normalizeMigrationSlug('2026 create-user profiles table')).toBe('2026_create_user_profiles_table')
    expect(createMigrationTimestamp(date)).toBe('2026_03_25_101112')
    expect(createMigrationFileName('Create Users Table', date)).toBe('2026_03_25_101112_create_users_table.ts')
  })

  it('infers create-table templates and renders a driver-agnostic scaffold', () => {
    const template = generateMigrationTemplate('create_users_table', {
      date: new Date('2026-03-25T10:11:12.000Z') })

    expect(inferMigrationTemplateKind('create_users_table')).toBe('create_table')
    expect(inferMigrationTableName('create_users_table', 'create_table')).toBe('users')
    expect(template).toMatchObject({
      fileName: '2026_03_25_101112_create_users_table.ts',
      migrationName: '2026_03_25_101112_create_users_table',
      kind: 'create_table',
      tableName: 'users' })
    expect(template.contents).toContain('import { defineMigration, type MigrationContext } from \'@holo-js/db\'')
    expect(template.contents).not.toContain('name:')
    expect(template.contents).toContain('await schema.createTable(\'users\', (table) => {')
    expect(template.contents).toContain('table.id()')
    expect(template.contents).toContain('table.timestamps()')
    expect(template.contents).toContain('await schema.dropTable(\'users\')')
  })

  it('preserves irregular plural table names in generated migration templates', () => {
    const peopleTemplate = generateMigrationTemplate('create_people_table', {
      date: new Date('2026-03-25T10:11:12.000Z') })
    const childrenTemplate = generateMigrationTemplate('create_children_table', {
      date: new Date('2026-03-25T10:11:12.000Z') })

    expect(inferMigrationTableName('create_people_table', 'create_table')).toBe('people')
    expect(inferMigrationTableName('create_children_table', 'create_table')).toBe('children')
    expect(peopleTemplate).toMatchObject({
      fileName: '2026_03_25_101112_create_people_table.ts',
      kind: 'create_table',
      tableName: 'people' })
    expect(childrenTemplate).toMatchObject({
      fileName: '2026_03_25_101112_create_children_table.ts',
      kind: 'create_table',
      tableName: 'children' })
    expect(peopleTemplate.contents).toContain('await schema.createTable(\'people\', (table) => {')
    expect(peopleTemplate.contents).toContain('await schema.dropTable(\'people\')')
    expect(childrenTemplate.contents).toContain('await schema.createTable(\'children\', (table) => {')
    expect(childrenTemplate.contents).toContain('await schema.dropTable(\'children\')')
  })

  it('infers alter-table templates and renders a table mutation scaffold', () => {
    const template = generateMigrationTemplate('add_status_to_users_table', {
      date: new Date('2026-03-25T10:11:12.000Z') })

    expect(inferMigrationTemplateKind('add_status_to_users_table')).toBe('alter_table')
    expect(inferMigrationTableName('add_status_to_users_table', 'alter_table')).toBe('users')
    expect(template).toMatchObject({
      fileName: '2026_03_25_101112_add_status_to_users_table.ts',
      migrationName: '2026_03_25_101112_add_status_to_users_table',
      kind: 'alter_table',
      tableName: 'users' })
    expect(template.contents).toContain('await schema.table(\'users\', (table) => {')
    expect(template.contents).toContain('void table')
    expect(template.contents).not.toContain('name:')
  })

  it('renders drop-table and blank templates and rejects invalid names', () => {
    const dropTemplate = generateMigrationTemplate('Drop Posts Table', {
      date: new Date('2026-03-25T10:11:12.000Z') })
    expect(inferMigrationTemplateKind('drop_posts_table')).toBe('drop_table')
    expect(inferMigrationTableName('drop_posts_table', 'drop_table')).toBe('posts')
    expect(dropTemplate.kind).toBe('drop_table')
    expect(dropTemplate.contents).not.toContain('name:')
    expect(dropTemplate.contents).toContain('await schema.dropTable(\'posts\')')
    expect(dropTemplate.contents).toContain([
      '  async down({ schema }: MigrationContext) {',
      '    await schema.createTable(\'posts\', (table) => {',
      '      table.id()',
      '      table.timestamps()',
      '    })',
      '  },',
    ].join('\n'))
    expect(dropTemplate.contents).not.toContain('throw')

    const blankTemplate = generateMigrationTemplate('Backfill User Status', {
      date: new Date('2026-03-25T10:11:12.000Z'),
      kind: 'blank' })
    expect(inferMigrationTemplateKind('backfill_user_status')).toBe('blank')
    expect(inferMigrationTableName('backfill_user_status', 'blank')).toBeUndefined()
    expect(blankTemplate.kind).toBe('blank')
    expect(blankTemplate.contents).not.toContain('name:')
    expect(blankTemplate.contents).toContain('void schema')
    expect(blankTemplate.contents).toContain('void db')

    expect(() => generateMigrationTemplate('!!!')).toThrow(ConfigurationError)
    expect(() => generateMigrationTemplate('create', { kind: 'create_table' })).toThrow(ConfigurationError)
    expect(() => generateMigrationTemplate('whatever', { kind: 'alter_table' })).toThrow(ConfigurationError)
  })

  it('rolls back a batch containing a generated drop-table migration', async () => {
    const template = generateMigrationTemplate('drop_posts_table', {
      date: new Date('2026-03-25T10:11:12.000Z') })
    const directory = await mkdtemp(join(tmpdir(), 'holo-drop-template-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, template.fileName)
    await writeFile(path, template.contents)
    const dropMigration = (await import(pathToFileURL(path).href)).default as MigrationDefinition

    const db = createDatabase({ adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite') })
    onTestFinished(() => db.disconnect())
    const schema = createSchemaService(db)
    const createMigration = defineMigration({
      name: '2026_03_25_000000_create_posts_table',
      async up({ schema }) {
        await schema.createTable('posts', table => {
          table.id()
        })
      },
      async down({ schema }) {
        await schema.dropTable('posts')
      },
    })
    const migrator = createMigrationService(db, [
      createMigration,
      { ...dropMigration, name: template.migrationName },
    ])

    await migrator.migrate({ step: 1 })
    await migrator.migrate()
    expect(await schema.hasTable('posts')).toBe(false)

    expect((await migrator.rollback()).map(migration => migration.name)).toEqual([template.migrationName])
    expect(await schema.hasTable('posts')).toBe(true)
    expect((await schema.getColumns('posts')).map(column => column.name)).toEqual(['id', 'created_at', 'updated_at'])
  })
})
