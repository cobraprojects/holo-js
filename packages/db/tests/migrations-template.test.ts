import { describe, expect, it } from 'vitest'
import {
  ConfigurationError,
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
    expect(dropTemplate.contents).toContain('Recreate "posts" manually')

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
})
