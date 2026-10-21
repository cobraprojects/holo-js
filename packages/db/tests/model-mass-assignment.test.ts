import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  clearGeneratedTables,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  resetDB,
  type DatabaseContext,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

async function openDatabase(): Promise<DatabaseContext> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  return db
}

const accounts = defineTable('accounts', {
  code: column.string().primaryKey(),
  name: column.string(),
  role: column.string().default('member'),
  created_at: column.timestamp().nullable(),
  updated_at: column.timestamp().nullable(),
})

describe('model mass assignment', () => {
  beforeEach(() => {
    resetDB()
    clearGeneratedTables()
  })

  it('rejects mass assignment on a model without fillable or guarded', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    await db.table('accounts').insert({ code: 'a', name: 'Ada' })

    const Account = defineModelFromTable(accounts)

    await expect(Account.create({ code: 'b', name: 'Grace' })).rejects.toThrow(
      'Column "code" is not writable on model "Account".',
    )
    expect(() => Account.make({ name: 'Grace' })).toThrow(
      'Column "name" is not writable on model "Account".',
    )
    await expect(Account.query().where('code', 'a').update({ name: 'Changed' })).rejects.toThrow(
      'Column "name" is not writable on model "Account".',
    )
    const account = await Account.findOrFail('a')
    await expect(account.update({ name: 'Changed' })).rejects.toThrow(
      'Column "name" is not writable on model "Account".',
    )
    await expect(db.table('accounts').get()).resolves.toMatchObject([{ code: 'a', name: 'Ada' }])
  })

  it('guards the primary key and timestamps unless they are explicitly fillable', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)

    const Guarded = defineModelFromTable(accounts, { guarded: ['role'] })
    const Wildcard = defineModelFromTable(accounts, { fillable: ['*'] })
    const Explicit = defineModelFromTable(accounts, { fillable: ['code', 'name', 'created_at', 'updated_at'] })

    for (const Account of [Guarded, Wildcard]) {
      await expect(Account.create({ code: 'x', name: 'Ada' })).rejects.toThrow(
        'Column "code" is not writable on model "Account".',
      )
      await expect(Account.query().where('code', 'x').update({ created_at: new Date('2020-01-01T00:00:00.000Z') })).rejects.toThrow(
        'Column "created_at" is not writable on model "Account".',
      )
      await expect(Account.query().where('code', 'x').update({ updated_at: new Date('2020-01-01T00:00:00.000Z') })).rejects.toThrow(
        'Column "updated_at" is not writable on model "Account".',
      )
    }

    await db.table('accounts').insert({ code: 'a', name: 'Ada' })
    await expect((await Guarded.findOrFail('a')).update({ code: 'b' })).rejects.toThrow(
      'Column "code" is not writable on model "Account".',
    )
    await expect((await Guarded.findOrFail('a')).update({ updated_at: new Date('2020-01-01T00:00:00.000Z') })).rejects.toThrow(
      'Column "updated_at" is not writable on model "Account".',
    )

    const renamed = await (await Guarded.findOrFail('a')).update({ name: 'Ada Lovelace' })
    expect(renamed.get('name')).toBe('Ada Lovelace')
    expect(renamed.get('updated_at')).toBeInstanceOf(Date)

    const created = await Explicit.create({
      code: 'e',
      name: 'Explicit',
      created_at: new Date('2020-01-01T00:00:00.000Z'),
      updated_at: new Date('2020-01-02T00:00:00.000Z'),
    })
    expect(created.get('code')).toBe('e')
    expect(created.get('created_at')).toEqual(new Date('2020-01-01T00:00:00.000Z'))
    expect(created.get('updated_at')).toEqual(new Date('2020-01-02T00:00:00.000Z'))
  })

  it('lets forceFill write guarded columns', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)

    const Account = defineModelFromTable(accounts, { fillable: ['name'] })

    const created = await Account.make({ name: 'Ada' }).forceFill({ code: 'a', role: 'admin' }).save()
    expect(created.get('role')).toBe('admin')

    const loaded = await Account.findOrFail('a')
    await loaded.forceFill({ role: 'owner' }).save()
    await expect(db.table('accounts').where('code', 'a').first()).resolves.toMatchObject({ role: 'owner' })

    const refilled = await Account.findOrFail('a')
    refilled.forceFill({ role: 'admin' })
    expect(() => refilled.fill({ role: 'guest' })).toThrow('Column "role" is not writable on model "Account".')
    expect(() => refilled.set('role', 'guest')).toThrow('Column "role" is not writable on model "Account".')
    await refilled.save()
    await expect(db.table('accounts').where('code', 'a').first()).resolves.toMatchObject({ role: 'admin' })
  })

  it('rejects a guarded JSON path at fill even when a sibling path is force-filled', async () => {
    const db = await openDatabase()
    const profiles = defineTable('profiles', {
      id: column.id(),
      name: column.string(),
      settings: column.json().nullable(),
    })
    await createTestTable(db, profiles)
    await db.table('profiles').insert({ name: 'Ada', settings: JSON.stringify({ role: 'member' }) })

    const Profile = defineModelFromTable(profiles, { fillable: ['name'], timestamps: false })

    const profile = await Profile.findOrFail(1)
    const request = { 'settings->is_admin': true } as Record<string, unknown>
    expect(() => profile.fill(request as never)).toThrow('Column "settings" is not writable on model "Profile".')
    expect(() => profile.set('settings->is_admin' as never, true as never)).toThrow('Column "settings" is not writable on model "Profile".')
    profile.forceFill({ 'settings->last_seen': '2026-01-01' } as never)
    await profile.save()
    await expect(db.table('profiles').where('id', 1).first()).resolves.toMatchObject({
      settings: JSON.stringify({ role: 'member', last_seen: '2026-01-01' }),
    })
  })

  it('ignores internal state injected onto a loaded model when saving', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    await db.table('accounts').insert({ code: 'a', name: 'Ada', role: 'member' })

    const Account = defineModelFromTable(accounts, { fillable: ['name'], timestamps: false })

    const account = await Account.findOrFail('a')
    const body = JSON.parse(`{
      "attributes": { "code": "a", "name": "Ada", "role": "admin" },
      "original": { "code": "a", "name": "Ada", "role": "member" },
      "changes": { "role": "admin" },
      "persisted": false,
      "repository": {}
    }`) as Record<string, unknown>
    Object.assign(account, body)
    expect(account.get('role')).toBe('member')
    expect(account.isDirty()).toBe(false)
    await account.save()
    await account.update({ name: 'Ada Lovelace' })
    await expect(db.table('accounts').where('code', 'a').first()).resolves.toMatchObject({ name: 'Ada Lovelace', role: 'member' })
    expect(account.toJSON()).toMatchObject({ code: 'a', name: 'Ada Lovelace', role: 'member' })

    const prototyped = await Account.findOrFail('a')
    Object.assign(prototyped, JSON.parse('{ "__proto__": { "attributes": { "role": "admin" } } }') as Record<string, unknown>)
    await expect(db.table('accounts').where('code', 'a').first()).resolves.toMatchObject({ role: 'member' })

    const assigned = await Account.findOrFail('a')
    expect(() => Object.assign(assigned, { role: 'admin' })).toThrow('Column "role" is not writable on model "Account".')
    expect(() => { (assigned as unknown as Record<string, unknown>).role = 'admin' }).toThrow('Column "role" is not writable on model "Account".')
    await assigned.save()
    await expect(db.table('accounts').where('code', 'a').first()).resolves.toMatchObject({ role: 'member' })
  })

  it('saves and deletes the row the model was loaded from after its key changes', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    await db.table('accounts').insert({ code: 'a', name: 'Ada' })
    await db.table('accounts').insert({ code: 'b', name: 'Grace' })

    const Account = defineModelFromTable(accounts, { fillable: ['code', 'name'] })

    const moved = await Account.findOrFail('a')
    await moved.update({ code: 'z', name: 'Ada Lovelace' })
    expect(moved.get('code')).toBe('z')
    await expect(db.table('accounts').orderBy('code').get()).resolves.toMatchObject([
      { code: 'b', name: 'Grace' },
      { code: 'z', name: 'Ada Lovelace' },
    ])

    const redirected = await Account.findOrFail('z')
    redirected.fill({ code: 'b', name: 'Hijacked' })
    await expect(redirected.save()).rejects.toThrow()
    await expect(db.table('accounts').orderBy('code').get()).resolves.toMatchObject([
      { code: 'b', name: 'Grace' },
      { code: 'z', name: 'Ada Lovelace' },
    ])

    const deleted = await Account.findOrFail('z')
    deleted.set('code', 'b')
    await deleted.delete()
    await expect(db.table('accounts').orderBy('code').get()).resolves.toMatchObject([
      { code: 'b', name: 'Grace' },
    ])
  })

  it('restore saves an unsaved key change, and force delete still targets the row the model was loaded from', async () => {
    const db = await openDatabase()
    const members = defineTable('members', {
      code: column.string().primaryKey(),
      name: column.string(),
      deleted_at: column.timestamp().nullable(),
    })
    await createTestTable(db, members)
    await db.table('members').insert({ code: 'a', name: 'Ada', deleted_at: '2020-01-01T00:00:00.000Z' })
    await db.table('members').insert({ code: 'b', name: 'Grace', deleted_at: '2020-01-01T00:00:00.000Z' })

    const Member = defineModelFromTable(members, { fillable: ['code', 'name'], softDeletes: true, timestamps: false })

    const restored = await Member.withTrashed().findOrFail('a')
    restored.set('code', 'c')
    await restored.restore()
    await expect(db.table('members').orderBy('code').get()).resolves.toMatchObject([
      { code: 'b', deleted_at: expect.anything() },
      { code: 'c', name: 'Ada', deleted_at: null },
    ])

    const removed = await Member.withTrashed().findOrFail('b')
    removed.set('code', 'd')
    await removed.forceDelete()
    await expect(db.table('members').get()).resolves.toMatchObject([{ code: 'c', name: 'Ada' }])
  })

  it('restore saves unsaved changes, so later writes target the restored row after its key changes', async () => {
    const db = await openDatabase()
    const members = defineTable('members', {
      code: column.string().primaryKey(),
      name: column.string(),
      deleted_at: column.timestamp().nullable(),
    })
    await createTestTable(db, members)
    await db.table('members').insert({ code: 'a', name: 'Ada', deleted_at: '2020-01-01T00:00:00.000Z' })
    await db.table('members').insert({ code: 'b', name: 'Grace', deleted_at: '2020-01-01T00:00:00.000Z' })

    const Member = defineModelFromTable(members, { fillable: ['code', 'name'], softDeletes: true, timestamps: false })

    const member = await Member.withTrashed().findOrFail('a')
    member.set('code', 'z')
    const restored = await member.restore()
    expect(restored.get('code')).toBe('z')
    expect(restored.isDirty('code')).toBe(false)
    await expect(db.table('members').orderBy('code').get()).resolves.toMatchObject([
      { code: 'b', name: 'Grace', deleted_at: expect.anything() },
      { code: 'z', name: 'Ada', deleted_at: null },
    ])

    restored.set('name', 'Ada Lovelace')
    await restored.save()
    await expect(db.table('members').orderBy('code').get()).resolves.toMatchObject([
      { code: 'b', name: 'Grace', deleted_at: expect.anything() },
      { code: 'z', name: 'Ada Lovelace', deleted_at: null },
    ])

    const removed = await Member.withTrashed().findOrFail('b')
    removed.set('code', 'c')
    await removed.forceDelete()
    await expect(db.table('members').get()).resolves.toMatchObject([{ code: 'z', name: 'Ada Lovelace' }])
  })
})
