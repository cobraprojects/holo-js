import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, resetDB } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

const users = defineTable('users', {
  id: column.id(),
  name: column.string(),
  email: column.string(),
})

async function seedUserModel() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  await createTestTable(db, users)
  const User = defineModelFromTable(users, { fillable: ['name', 'email'] })
  await User.createMany([
    { name: 'Mohamed', email: 'mo@example.com' },
    { name: 'mona', email: 'mona@example.com' },
    { name: 'Amina', email: 'amina@example.org' },
  ])
  return User
}

beforeEach(() => resetDB())

describe('model where clauses', () => {
  it('filters models with like patterns', async () => {
    const User = await seedUserModel()

    expect(await User.whereLike('name', 'mo%').orderBy('id').pluck('name')).toEqual(['Mohamed', 'mona'])
    expect(await User.whereNotLike('name', 'mo%').pluck('name')).toEqual(['Amina'])
    expect(await User.whereLike('name', 'Mo%', true).pluck('name')).toEqual(['Mohamed'])
    expect(await User.where('name', 'Amina').orWhereNotLike('name', 'mo%', true).orderBy('id').pluck('name')).toEqual(['Mohamed', 'Amina'])
    expect(await User.query().whereNotLike('email', '%.com').orWhereLike('name', 'MONA').orderBy('id').pluck('name')).toEqual(['mona', 'Amina'])
  })

  it('filters models with or variants and subqueries', async () => {
    const User = await seedUserModel()
    const monaIds = User.select('id').where('name', 'mona')

    expect(await User.where('id', 1).orWhereIn('id', monaIds).orderBy('id').pluck('name')).toEqual(['Mohamed', 'mona'])
    expect(await User.whereNotIn('id', monaIds).orWhereNotIn('name', ['Amina']).orderBy('id').pluck('name')).toEqual(['Mohamed', 'mona', 'Amina'])
    expect(await User.where('id', 1).orWhereBetween('id', [3, 9]).orderBy('id').pluck('name')).toEqual(['Mohamed', 'Amina'])
    expect(await User.where('id', 1).orWhereNotBetween('id', [1, 2]).orderBy('id').pluck('name')).toEqual(['Mohamed', 'Amina'])
    expect(await User.where('id', 1).orWhereColumn('name', 'email').pluck('name')).toEqual(['Mohamed'])
    expect(await User.where('id', 3).orWhereAny(['name', 'email'], 'like', 'mona%').orderBy('id').pluck('name')).toEqual(['mona', 'Amina'])
    expect(await User.where('id', 3).orWhereAll(['name', 'email'], 'like', 'mo%').orderBy('id').pluck('name')).toEqual(['Mohamed', 'mona', 'Amina'])
    expect(await User.where('id', 3).orWhereNone(['name', 'email'], 'like', '%o%').pluck('name')).toEqual(['Amina'])
  })
})
