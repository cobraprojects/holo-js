import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  createSeederService,
  binaryCast,
  defineFactory,
  defineSeeder,
  hasMany,
  resetDB,
  type DatabaseContext,
  type Entity,
  type TableDefinition,
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

async function openDatabaseWithDeferredForeignKey(): Promise<DatabaseContext> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  await adapter.execute('PRAGMA foreign_keys = ON')
  await adapter.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
  await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED, name TEXT NOT NULL)')
  return db
}

const accounts = defineTable('accounts', {
  id: column.id(),
  name: column.string(),
  slug: column.string().nullable(),
  status: column.string().nullable(),
})

type TestEntity = Entity<TableDefinition>

function asTestEntity(value: unknown): TestEntity {
  return value as TestEntity
}

const ledgers = defineTable('ledgers', {
  code: column.string().primaryKey(),
  name: column.string(),
  status: column.string().nullable(),
})

describe('model lifecycle persistence', () => {
  beforeEach(() => resetDB())

  it('persists attribute changes made in creating, saving, and updating handlers', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    const Account = defineModelFromTable(accounts, {
      fillable: ['name', 'slug', 'status'],
      events: {
        creating: [entity => { asTestEntity(entity).set('slug', 'created-slug') }],
        saving: [entity => { if (asTestEntity(entity).isDirty('name')) asTestEntity(entity).set('status', 'saved') }],
        updating: [entity => { asTestEntity(entity).set('slug', 'updated-slug') }],
      },
    })

    const made = await Account.make({ name: 'Ada' }).save()
    expect(made.get('slug')).toBe('created-slug')

    const created = await Account.create({ name: 'Grace' })
    expect(created.get('slug')).toBe('created-slug')
    expect(created.get('status')).toBe('saved')

    const loaded = await Account.findOrFail(created.get('id'))
    loaded.set('name', 'Grace Hopper')
    await loaded.save()

    expect(await db.table('accounts').where('id', loaded.get('id')).get()).toMatchObject([
      { name: 'Grace Hopper', slug: 'updated-slug', status: 'saved' },
    ])
    expect(loaded.get('slug')).toBe('updated-slug')
    expect(loaded.isDirty()).toBe(false)
  })

  it('runs saving handlers on a clean model and persists what they change', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', {
      id: column.id(),
      title: column.string(),
      slug: column.string().nullable(),
    })
    await createTestTable(db, slugged)
    await db.table('slugged').insert({ id: 1, title: 'Hello World', slug: null })
    const Post = defineModelFromTable(slugged, {
      timestamps: false,
      fillable: ['title', 'slug'],
      events: {
        saving: [entity => {
          const post = asTestEntity(entity)
          post.set('slug', String(post.get('title')).toLowerCase().replaceAll(' ', '-'))
        }],
      },
    })

    const post = await Post.findOrFail(1)
    expect(post.isDirty()).toBe(false)
    await post.save()

    expect(await db.table('slugged').where('id', 1).get()).toMatchObject([{ slug: 'hello-world' }])
  })

  it('applies mutators exactly once for make().save(), create(), and factories', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    const seen: string[] = []
    const Account = defineModelFromTable(accounts, {
      fillable: ['name', 'slug', 'status'],
      mutators: {
        name: (value) => {
          seen.push(String(value))
          return `${String(value)}!`
        },
      },
    })

    await Account.make({ name: 'Ada' }).save()
    await Account.create({ name: 'Grace' })
    await defineFactory(Account, () => ({ name: 'Linus' })).create()

    expect(seen).toEqual(['Ada', 'Grace', 'Linus'])
    expect((await db.table('accounts').get()).map(row => row.name)).toEqual(['Ada!', 'Grace!', 'Linus!'])
  })

  it('reads the raw assigned value until save applies the set mutator', async () => {
    const db = await openDatabase()
    const people = defineTable('people', { id: column.id(), email: column.string() })
    await createTestTable(db, people)
    const Person = defineModelFromTable(people, {
      fillable: ['email'],
      mutators: { email: value => String(value).trim().toLowerCase() },
    })

    const person = Person.make({ email: '  Amina@Example.com ' })
    expect(person.get('email')).toBe('  Amina@Example.com ')

    await person.save()
    expect(person.get('email')).toBe('amina@example.com')
    expect(await db.table('people').get()).toMatchObject([{ email: 'amina@example.com' }])
  })

  it('saves a model loaded with withCount and withExists without writing the computed values', async () => {
    const db = await openDatabase()
    const posts = defineTable('posts', { id: column.id(), userId: column.integer(), title: column.string() })
    await createTestTable(db, accounts)
    await createTestTable(db, posts)
    await db.table('accounts').insert({ id: 1, name: 'Ada', slug: null, status: null })
    await db.table('posts').insert([{ id: 1, userId: 1, title: 'First' }, { id: 2, userId: 1, title: 'Second' }])

    const Post = defineModelFromTable(posts, { fillable: ['userId', 'title'] })
    const Account = defineModelFromTable(accounts, {
      fillable: ['name', 'slug', 'status'],
      relations: { posts: hasMany(() => Post, 'userId') },
    })

    const account = await Account.query().withCount('posts').withExists('posts').firstOrFail()
    expect(account.get('posts_count' as never)).toBe(2)
    expect(account.isDirty()).toBe(false)

    account.set('name', 'Ada Lovelace')
    await expect(account.save()).resolves.toBe(account)
    expect(await db.table('accounts').where('id', 1).get()).toMatchObject([{ name: 'Ada Lovelace' }])
  })

  it('detects in-place changes to JSON and date attributes as dirty and saves them', async () => {
    const db = await openDatabase()
    const documents = defineTable('documents', {
      id: column.id(),
      meta: column.json<{ tags: string[] }>(),
      publishedAt: column.timestamp().nullable(),
    })
    await createTestTable(db, documents)
    const Document = defineModelFromTable(documents, {
      fillable: ['meta', 'publishedAt'],
      casts: { meta: 'json', publishedAt: 'date' },
    })
    const created = await Document.create({ meta: { tags: ['a'] }, publishedAt: new Date('2025-01-02T03:04:05.000Z') })

    const document = await Document.findOrFail(created.get('id'))
    document.get('meta').tags.push('b')
    document.get('publishedAt')?.setUTCFullYear(2026)
    expect(document.isDirty('meta')).toBe(true)
    expect(document.isDirty('publishedAt')).toBe(true)
    expect(document.getDirty()).toHaveProperty('meta')
    expect(document.getDirty()).toHaveProperty('publishedAt')

    await document.save()

    const stored = await Document.findOrFail(created.get('id'))
    expect(stored.get('meta')).toEqual({ tags: ['a', 'b'] })
    expect(stored.get('publishedAt')).toEqual(new Date('2026-01-02T03:04:05.000Z'))
    expect(stored.isDirty()).toBe(false)
  })

  it('runs factories without mass-assignment guards', async () => {
    const db = await openDatabase()
    await createTestTable(db, ledgers)
    const Ledger = defineModelFromTable(ledgers)

    const made = await defineFactory(Ledger, () => ({ code: 'made', name: 'Factory', status: 'draft' })).makeOne()
    expect(made.get('code')).toBe('made')

    const created = await defineFactory(Ledger, () => ({ code: 'created', name: 'Factory', status: 'active' })).createOne()
    expect(created.get('status')).toBe('active')
    expect(await db.table('ledgers').where('code', 'created').get()).toMatchObject([{ name: 'Factory', status: 'active' }])
    await expect(Ledger.create({ code: 'outside', name: 'Outside' })).rejects.toThrow(
      'Column "code" is not writable on model "Ledger".',
    )
  })

  it('keeps pending attribute defaults independent of each unsaved instance', async () => {
    const db = await openDatabase()
    const documents = defineTable('documents', { id: column.id(), meta: column.json<{ tags: string[] }>() })
    await createTestTable(db, documents)
    const Document = defineModelFromTable(documents, {
      fillable: ['meta'],
      casts: { meta: 'json' },
      pendingAttributes: { meta: { tags: [] } },
    })

    Document.make().get('meta').tags.push('leaked')

    expect(Document.make().get('meta')).toEqual({ tags: [] })
  })

  it('runs factory hooks and handlers without mass-assignment guards', async () => {
    const db = await openDatabase()
    await createTestTable(db, ledgers)
    const Ledger = defineModelFromTable(ledgers, {
      fillable: ['name'],
      events: {
        creating: [entity => { asTestEntity(entity).set('status', 'created') }],
      },
    })

    const created = await defineFactory(Ledger, () => ({ code: 'hooked', name: 'Hooked' }))
      .afterMaking(entity => { asTestEntity(entity).set('status', 'made') })
      .createOne()

    expect(created.get('status')).toBe('created')
    expect(await db.table('ledgers').where('code', 'hooked').get()).toMatchObject([{ status: 'created' }])
    expect(() => Ledger.make({ code: 'outside', name: 'Outside', status: 'x' })).toThrow(
      'Column "code" is not writable on model "Ledger".',
    )
    expect(() => Ledger.make({ name: 'Outside', status: 'x' })).toThrow(
      'Column "status" is not writable on model "Ledger".',
    )
  })

  it('does not report null-prototype JSON values as dirty when loaded unchanged', async () => {
    const db = await openDatabase()
    const documents = defineTable('documents', { id: column.id(), meta: column.string().nullable() })
    await createTestTable(db, documents)
    await db.table('documents').insert({ id: 1, meta: JSON.stringify({ enabled: true }) })
    const Document = defineModelFromTable(documents, {
      fillable: ['meta'],
      casts: {
        meta: {
          get: value => Object.assign(Object.create(null), JSON.parse(String(value))),
          set: value => JSON.stringify(value),
        },
      },
    })

    const document = await Document.findOrFail(1)
    expect(document.isDirty()).toBe(false)
    expect(document.getDirty()).toEqual({})
  })

  it('keeps a JSON key named __proto__ as data when loaded unchanged', async () => {
    const db = await openDatabase()
    const documents = defineTable('documents', { id: column.id(), meta: column.json<Record<string, unknown>>() })
    await createTestTable(db, documents)
    await db.table('documents').insert({ id: 1, meta: '{"__proto__":{"enabled":true},"tags":["a"]}' })
    const Document = defineModelFromTable(documents, { fillable: ['meta'], casts: { meta: 'json' } })

    const document = await Document.findOrFail(1)
    expect(Object.keys(document.get('meta') as object)).toEqual(['__proto__', 'tags'])
    expect(document.isDirty()).toBe(false)
  })

  it('keeps mass-assignment guards on seeder logger callbacks', async () => {
    const Ledger = defineModelFromTable(ledgers)
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({
      adapter,
      dialect: createDialect('sqlite'),
      logger: {
        onSeederStart: () => Ledger.create({ code: 'logged', name: 'Logged' }).then(() => undefined),
      },
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createTestTable(db, ledgers)

    const seeders = createSeederService(db, [defineSeeder({
      name: 'GuardedLoggerSeeder',
      async run() {
        await Ledger.create({ code: 'seeded', name: 'Seeded' })
      },
    })])

    await expect(seeders.seed()).rejects.toThrow('Column "code" is not writable on model "Ledger".')
    expect(await db.table('ledgers').get()).toEqual([])
  })

  it('detects in-place changes to binary attributes as dirty and saves them', async () => {
    const db = await openDatabase()
    const files = defineTable('files', { id: column.id(), payload: column.blob().nullable() })
    await createTestTable(db, files)
    const File = defineModelFromTable(files, { fillable: ['payload'], casts: { payload: binaryCast() } })
    const created = await File.create({ payload: new Uint8Array([1, 2, 3, 4]) })

    const file = await File.findOrFail(created.get('id'))
    const payload = file.get('payload') as Uint8Array
    payload[0] = 9
    expect(file.isDirty('payload')).toBe(true)

    await file.save()

    const stored = await File.findOrFail(created.get('id'))
    expect(Array.from(stored.get('payload') as Uint8Array)).toEqual([9, 2, 3, 4])
  })

  it('runs cancellable handlers on mutated values so an alias cannot pass a guard on create or update', async () => {
    const db = await openDatabase()
    const members = defineTable('members', { id: column.id(), name: column.string(), role: column.string() })
    await createTestTable(db, members)
    const rejectAdmin = (entity: unknown) => {
      if (asTestEntity(entity).get('role') === 'admin') throw new Error('admin is reserved')
    }
    const Member = defineModelFromTable(members, {
      fillable: ['name', 'role'],
      mutators: { role: value => String(value).trim().toLowerCase() },
      events: { creating: [rejectAdmin], updating: [rejectAdmin] },
    })

    await expect(Member.create({ name: 'Ada', role: ' ADMIN ' })).rejects.toThrow('admin is reserved')

    const member = await Member.create({ name: 'Grace', role: 'member' })
    member.set('role', ' ADMIN ')
    await expect(member.save()).rejects.toThrow('admin is reserved')

    expect(await db.table('members').get()).toMatchObject([{ name: 'Grace', role: 'member' }])
  })

  it('rejects an alias that an earlier handler on the same event sets to a reserved value', async () => {
    const db = await openDatabase()
    const members = defineTable('members', { id: column.id(), name: column.string(), role: column.string() })
    await createTestTable(db, members)
    const setAliasForMallory = (entity: unknown) => {
      if (asTestEntity(entity).get('name') === 'Mallory') asTestEntity(entity).set('role', ' ADMIN ')
    }
    const rejectAdmin = (entity: unknown) => {
      if (asTestEntity(entity).get('role') === 'admin') throw new Error('admin is reserved')
    }
    const Member = defineModelFromTable(members, {
      fillable: ['name', 'role'],
      mutators: { role: value => String(value).trim().toLowerCase() },
      events: { creating: [setAliasForMallory, rejectAdmin], updating: [setAliasForMallory, rejectAdmin] },
    })

    await expect(Member.create({ name: 'Mallory', role: 'member' })).rejects.toThrow('admin is reserved')
    const grace = await Member.create({ name: 'Grace', role: 'member' })

    grace.set('name', 'Mallory')
    await expect(grace.save()).rejects.toThrow('admin is reserved')
    expect(await db.table('members').get()).toMatchObject([{ name: 'Grace', role: 'member' }])
  })

  it('rejects an alias that a saving handler sets when a later creating handler checks it', async () => {
    const db = await openDatabase()
    const members = defineTable('members', { id: column.id(), name: column.string(), role: column.string() })
    await createTestTable(db, members)
    const setAliasForMallory = (entity: unknown) => {
      if (asTestEntity(entity).get('name') === 'Mallory') asTestEntity(entity).set('role', ' ADMIN ')
    }
    const rejectAdmin = (entity: unknown) => {
      if (asTestEntity(entity).get('role') === 'admin') throw new Error('admin is reserved')
    }
    const Member = defineModelFromTable(members, {
      fillable: ['name', 'role'],
      mutators: { role: value => String(value).trim().toLowerCase() },
      events: { saving: [setAliasForMallory], creating: [rejectAdmin] },
    })

    await expect(Member.create({ name: 'Mallory', role: 'member' })).rejects.toThrow('admin is reserved')
    await expect(Member.create({ name: 'Grace', role: 'member' })).resolves.toMatchObject({ role: 'member' })
    expect(await db.table('members').get()).toMatchObject([{ name: 'Grace', role: 'member' }])
  })

  it('fires saving and saved on a clean save of a model without timestamps', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', { id: column.id(), title: column.string() })
    await createTestTable(db, slugged)
    await db.table('slugged').insert({ id: 1, title: 'Hello' })
    const events: string[] = []
    const Post = defineModelFromTable(slugged, {
      timestamps: false,
      fillable: ['title'],
      events: {
        saving: [() => { events.push('saving') }],
        updating: [() => { events.push('updating') }],
        updated: [() => { events.push('updated') }],
        saved: [() => { events.push('saved') }],
      },
    })

    await (await Post.findOrFail(1)).save()

    expect(events).toEqual(['saving', 'saved'])
  })

  it('fires saving and saved on a clean save of a timestamped model without writing updated_at', async () => {
    const db = await openDatabase()
    const stamped = defineTable('stamped', {
      id: column.id(),
      title: column.string(),
      created_at: column.timestamp().nullable(),
      updated_at: column.timestamp().nullable(),
    })
    await createTestTable(db, stamped)
    await db.table('stamped').insert({ id: 1, title: 'Hello', created_at: null, updated_at: null })
    const events: string[] = []
    const Post = defineModelFromTable(stamped, {
      fillable: ['title'],
      events: {
        saving: [() => { events.push('saving') }],
        updating: [() => { events.push('updating') }],
        updated: [() => { events.push('updated') }],
        saved: [() => { events.push('saved') }],
      },
    })

    await (await Post.findOrFail(1)).save()

    expect(events).toEqual(['saving', 'saved'])
    expect((await db.table('stamped').get())[0]?.updated_at).toBeNull()
  })

  it('fires saved without an update when an updating handler reverts every change', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', { id: column.id(), title: column.string() })
    await createTestTable(db, slugged)
    await db.table('slugged').insert({ id: 1, title: 'Hello' })
    const events: string[] = []
    const Post = defineModelFromTable(slugged, {
      timestamps: false,
      fillable: ['title'],
      events: {
        saving: [() => { events.push('saving') }],
        updating: [entity => {
          events.push('updating')
          asTestEntity(entity).set('title', 'Hello')
        }],
        updated: [() => { events.push('updated') }],
        saved: [() => { events.push('saved') }],
      },
    })

    const post = await Post.findOrFail(1)
    post.set('title', 'Changed')
    await post.save()

    expect(events).toEqual(['saving', 'updating', 'saved'])
    expect(await db.table('slugged').get()).toMatchObject([{ title: 'Hello' }])
  })

  it('writes only updated_at when an updating handler reverts every change on a timestamped model', async () => {
    const db = await openDatabase()
    const stamped = defineTable('stamped', {
      id: column.id(),
      title: column.string(),
      created_at: column.timestamp().nullable(),
      updated_at: column.timestamp().nullable(),
    })
    await createTestTable(db, stamped)
    await db.table('stamped').insert({ id: 1, title: 'Hello', created_at: null, updated_at: null })
    const events: string[] = []
    const Post = defineModelFromTable(stamped, {
      fillable: ['title'],
      events: {
        saving: [() => { events.push('saving') }],
        updating: [entity => {
          events.push('updating')
          asTestEntity(entity).set('title', 'Hello')
        }],
        updated: [() => { events.push('updated') }],
        saved: [() => { events.push('saved') }],
      },
    })

    const post = await Post.findOrFail(1)
    post.set('title', 'Changed')
    await post.save()

    expect(events).toEqual(['saving', 'updating', 'updated', 'saved'])
    const row = (await db.table('stamped').get())[0]
    expect(row).toMatchObject({ title: 'Hello' })
    expect(row?.updated_at).not.toBeNull()
  })

  it('records no changes for a clean save whose saved handler sets an attribute', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', { id: column.id(), title: column.string(), slug: column.string().nullable() })
    await createTestTable(db, slugged)
    await db.table('slugged').insert({ id: 1, title: 'Hello', slug: null })
    const Post = defineModelFromTable(slugged, {
      timestamps: false,
      fillable: ['title', 'slug'],
      events: {
        saved: [entity => { asTestEntity(entity).set('slug', 'set-after-save') }],
      },
    })

    const post = await Post.findOrFail(1)
    await post.save()

    expect(post.wasChanged('slug')).toBe(false)
    expect(post.getChanges()).toEqual({})
    expect(await db.table('slugged').get()).toMatchObject([{ slug: null }])
  })

  it('records only the written attribute when a saved handler edits another attribute on an update', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', { id: column.id(), title: column.string(), slug: column.string().nullable() })
    await createTestTable(db, slugged)
    await db.table('slugged').insert({ id: 1, title: 'Hello', slug: null })
    const Post = defineModelFromTable(slugged, {
      timestamps: false,
      fillable: ['title', 'slug'],
      events: {
        saved: [entity => { asTestEntity(entity).set('slug', 'set-after-save') }],
      },
    })

    const post = await Post.findOrFail(1)
    post.set('title', 'Changed')
    await post.save()

    expect(post.getChanges()).toEqual({ title: 'Changed' })
    expect(post.wasChanged('slug')).toBe(false)
    expect(await db.table('slugged').get()).toMatchObject([{ title: 'Changed', slug: null }])
  })

  it('leaves the entity clean after save when a saved handler edits an attribute', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', { id: column.id(), title: column.string(), slug: column.string().nullable() })
    await createTestTable(db, slugged)
    await db.table('slugged').insert({ id: 1, title: 'Hello', slug: null })
    const Post = defineModelFromTable(slugged, {
      timestamps: false,
      fillable: ['title', 'slug'],
      events: {
        saved: [entity => { asTestEntity(entity).set('slug', 'set-after-save') }],
      },
    })

    const post = await Post.findOrFail(1)
    post.set('title', 'Changed')
    await post.save()
    expect(post.isDirty()).toBe(false)
    expect(post.isDirty('slug')).toBe(false)

    const clean = await Post.findOrFail(1)
    await clean.save()
    expect(clean.isDirty()).toBe(false)
    expect(clean.isDirty('slug')).toBe(false)
  })

  it('passes the caller\'s own instance to lifecycle handlers on create and update', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', { id: column.id(), title: column.string() })
    await createTestTable(db, slugged)
    await db.table('slugged').insert({ id: 1, title: 'Hello' })
    const seen: unknown[] = []
    const Post = defineModelFromTable(slugged, {
      timestamps: false,
      fillable: ['title'],
      events: {
        created: [entity => { seen.push(entity) }],
        updated: [entity => { seen.push(entity) }],
        saved: [entity => { seen.push(entity) }],
      },
    })

    const made = Post.make({ title: 'Made' })
    await made.save()
    expect(seen.slice(0, 2).every(entity => entity === made)).toBe(true)

    seen.length = 0
    const loaded = await Post.findOrFail(1)
    loaded.set('title', 'Changed')
    await loaded.save()
    expect(seen.length).toBe(2)
    expect(seen.every(entity => entity === loaded)).toBe(true)
  })

  it('records no changes after a create, as Laravel does', async () => {
    const db = await openDatabase()
    const slugged = defineTable('slugged', { id: column.id(), title: column.string() })
    await createTestTable(db, slugged)
    const Post = defineModelFromTable(slugged, { timestamps: false, fillable: ['title'] })

    const created = await Post.create({ title: 'Fresh' })
    expect(created.getChanges()).toEqual({})
    expect(created.wasChanged()).toBe(false)
    expect(created.isDirty()).toBe(false)

    const made = Post.make({ title: 'Made' })
    await made.save()
    expect(made.getChanges()).toEqual({})
    expect(made.wasChanged()).toBe(false)
    expect(made.isDirty()).toBe(false)
  })

  it('runs the full update path when a saving handler dirties a clean timestamped model', async () => {
    const db = await openDatabase()
    const stamped = defineTable('stamped', {
      id: column.id(),
      title: column.string(),
      created_at: column.timestamp().nullable(),
      updated_at: column.timestamp().nullable(),
    })
    await createTestTable(db, stamped)
    await db.table('stamped').insert({ id: 1, title: 'Hello', created_at: null, updated_at: null })
    const events: string[] = []
    const Post = defineModelFromTable(stamped, {
      fillable: ['title'],
      events: {
        saving: [entity => {
          events.push('saving')
          asTestEntity(entity).set('title', 'Changed by saving')
        }],
        updating: [() => { events.push('updating') }],
        updated: [() => { events.push('updated') }],
        saved: [() => { events.push('saved') }],
      },
    })

    await (await Post.findOrFail(1)).save()

    expect(events).toEqual(['saving', 'updating', 'updated', 'saved'])
    const row = (await db.table('stamped').get())[0]
    expect(row).toMatchObject({ title: 'Changed by saving' })
    expect(row?.updated_at).not.toBeNull()
  })

  it('keeps guards on logger callbacks of seeders started with call()', async () => {
    const Ledger = defineModelFromTable(ledgers)
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({
      adapter,
      dialect: createDialect('sqlite'),
      logger: {
        onSeederStart: log => {
          if (log.seederName !== 'NestedChildSeeder') return undefined
          return Ledger.create({ code: 'logged', name: 'Logged' }).then(() => undefined)
        },
      },
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createTestTable(db, ledgers)

    const seeders = createSeederService(db, [
      defineSeeder({
        name: 'NestedChildSeeder',
        async run() {
          await Ledger.create({ code: 'child', name: 'Child' })
        },
      }),
      defineSeeder({
        name: 'NestedParentSeeder',
        async run({ call }) {
          await call('NestedChildSeeder')
        },
      }),
    ])

    await expect(seeders.seed({ only: ['NestedParentSeeder'] })).rejects.toThrow(
      'Column "code" is not writable on model "Ledger".',
    )
    expect(await db.table('ledgers').get()).toEqual([])
  })

  it('runs seeders without mass-assignment guards', async () => {
    const db = await openDatabase()
    await createTestTable(db, ledgers)
    const Ledger = defineModelFromTable(ledgers)

    const seeders = createSeederService(db, [defineSeeder({
      name: 'LedgerSeeder',
      async run() {
        await Ledger.create({ code: 'seeded', name: 'Seeded', status: 'active' })
      },
    })])

    await seeders.seed()

    expect(await db.table('ledgers').get()).toMatchObject([{ code: 'seeded', name: 'Seeded', status: 'active' }])
  })
})

describe('model save writes', () => {
  beforeEach(() => resetDB())

  it('updates a soft-deleted entity loaded with withTrashed()', async () => {
    const db = await openDatabase()
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string(),
      deleted_at: column.timestamp().nullable(),
    })
    await createTestTable(db, posts)
    await db.table('posts').insert([{ id: 1, title: 'Old', deleted_at: '2025-01-01T00:00:00.000Z' }])
    const Post = defineModelFromTable(posts, {
      fillable: ['title'],
      softDeletes: true,
      casts: { deleted_at: 'date' },
    })

    const post = await Post.withTrashed().findOrFail(1)
    post.set('title', 'Renamed')
    await post.save()

    expect(await db.table('posts').where('id', 1).get()).toMatchObject([{ title: 'Renamed' }])
    expect(post.isDirty()).toBe(false)
  })

  it('runs mutators once when a failed save is retried', async () => {
    const db = await openDatabase()
    const members = defineTable('members', {
      id: column.id(),
      email: column.string().unique(),
      secret: column.string(),
    })
    await createTestTable(db, members)
    await db.table('members').insert([
      { id: 1, email: 'taken@example.com', secret: 'stored' },
      { id: 2, email: 'free@example.com', secret: 'stored' },
    ])
    const Member = defineModelFromTable(members, {
      fillable: ['email', 'secret'],
      mutators: { secret: value => `hashed:${String(value)}` },
    })

    const inserted = Member.make({ email: 'taken@example.com', secret: 'pw' })
    await expect(inserted.save()).rejects.toThrow()
    inserted.set('email', 'new@example.com')
    await inserted.save()
    expect(await db.table('members').where('email', 'new@example.com').get()).toMatchObject([{ secret: 'hashed:pw' }])

    const loaded = await Member.findOrFail(2)
    loaded.set('secret', 'next')
    loaded.set('email', 'taken@example.com')
    await expect(loaded.save()).rejects.toThrow()
    loaded.set('email', 'moved@example.com')
    await loaded.save()
    expect(await db.table('members').where('id', 2).get()).toMatchObject([
      { email: 'moved@example.com', secret: 'hashed:next' },
    ])
  })

  it('runs mutators once when a listener fails after the write and the save is retried', async () => {
    const db = await openDatabase()
    const members = defineTable('members', {
      id: column.id(),
      email: column.string(),
      secret: column.string(),
    })
    await createTestTable(db, members)
    let failNextCreated = true
    const Member = defineModelFromTable(members, {
      fillable: ['email', 'secret'],
      mutators: { secret: value => `hashed:${String(value)}` },
      events: {
        created: [() => {
          if (failNextCreated) {
            failNextCreated = false
            throw new Error('created listener failed')
          }
        }],
      },
    })

    const member = Member.make({ email: 'a@example.com', secret: 'pw' })
    await expect(member.save()).rejects.toThrow('created listener failed')
    await member.save()

    expect(await db.table('members').get()).toMatchObject([{ email: 'a@example.com', secret: 'hashed:pw' }])
  })

  it('restores a trashed row again when a restored listener fails and the restore is retried', async () => {
    const db = await openDatabase()
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string(),
      deleted_at: column.timestamp().nullable(),
    })
    await createTestTable(db, posts)
    await db.table('posts').insert([{ id: 1, title: 'Gone', deleted_at: '2025-01-01T00:00:00.000Z' }])
    let failNextRestored = true
    const Post = defineModelFromTable(posts, {
      fillable: ['title'],
      softDeletes: true,
      timestamps: false,
      casts: { deleted_at: 'date' },
      events: {
        restored: [() => {
          if (failNextRestored) {
            failNextRestored = false
            throw new Error('restored listener failed')
          }
        }],
      },
    })

    const post = await Post.withTrashed().findOrFail(1)
    await expect(post.restore()).rejects.toThrow('restored listener failed')
    expect(post.trashed()).toBe(true)
    await post.restore()

    expect(await db.table('posts').where('id', 1).get()).toMatchObject([{ deleted_at: null }])
    expect(post.trashed()).toBe(false)
  })

  describe('when the COMMIT itself fails after the write succeeded', () => {
    const children = defineTable('children', {
      id: column.id(),
      parentId: column.integer(),
      name: column.string(),
    })

    function defineChildModel(seen: string[]) {
      return defineModelFromTable(children, {
        timestamps: false,
        fillable: ['parentId', 'name'],
        mutators: {
          name: value => {
            seen.push(String(value))
            return `${String(value)}!`
          },
        },
      })
    }

    it('restores a created model so a retry runs mutators once and writes the row', async () => {
      const db = await openDatabaseWithDeferredForeignKey()
      const seen: string[] = []
      const Child = defineChildModel(seen)

      const child = Child.make({ parentId: 42, name: 'Ada' })
      await expect(child.save()).rejects.toThrow('FOREIGN KEY')
      expect(await db.table('children').count()).toBe(0)

      await db.table('parents').insert({ id: 42 })
      await child.save()

      expect(seen).toEqual(['Ada', 'Ada'])
      expect(await db.table('children').get()).toMatchObject([{ parentId: 42, name: 'Ada!' }])
      expect(child.isDirty()).toBe(false)
    })

    it('restores an updated model so a retry runs mutators once and writes the row', async () => {
      const db = await openDatabaseWithDeferredForeignKey()
      await db.table('parents').insert({ id: 1 })
      await db.table('children').insert({ id: 1, parentId: 1, name: 'Ada!' })
      const seen: string[] = []
      const Child = defineChildModel(seen)

      const child = await Child.findOrFail(1)
      child.set('parentId', 99)
      child.set('name', 'Grace')
      await expect(child.save()).rejects.toThrow('FOREIGN KEY')

      await db.table('parents').insert({ id: 99 })
      await child.save()

      expect(seen).toEqual(['Grace', 'Grace'])
      expect(await db.table('children').where('id', 1).get()).toMatchObject([{ parentId: 99, name: 'Grace!' }])
      expect(child.isDirty()).toBe(false)
    })

    it('restores a model saved in a caller transaction when that transaction fails to commit', async () => {
      const db = await openDatabaseWithDeferredForeignKey()
      const seen: string[] = []
      const Child = defineChildModel(seen)

      const child = Child.make({ parentId: 42, name: 'Ada' })
      await expect(db.transaction(async () => {
        await child.save()
      })).rejects.toThrow('FOREIGN KEY')
      expect(await db.table('children').count()).toBe(0)

      await db.table('parents').insert({ id: 42 })
      await child.save()

      expect(seen).toEqual(['Ada', 'Ada'])
      expect(await db.table('children').get()).toMatchObject([{ parentId: 42, name: 'Ada!' }])
    })

    it('restores a model saved in a released savepoint when the outer transaction fails to commit', async () => {
      const db = await openDatabaseWithDeferredForeignKey()
      const seen: string[] = []
      const Child = defineChildModel(seen)

      const child = Child.make({ parentId: 42, name: 'Ada' })
      await expect(db.transaction(async tx => {
        await tx.transaction(async () => {
          await child.save()
        })
      })).rejects.toThrow('FOREIGN KEY')
      expect(await db.table('children').count()).toBe(0)

      await db.table('parents').insert({ id: 42 })
      await child.save()

      expect(seen).toEqual(['Ada', 'Ada'])
      expect(await db.table('children').get()).toMatchObject([{ parentId: 42, name: 'Ada!' }])
    })

    it('restores a model whose savepoint rollback failed when the outer transaction then fails to commit', async () => {
      const adapter = createSQLiteAdapter({ filename: ':memory:' })
      onTestFinished(() => adapter.disconnect())
      let failNextSavepointRollback = true
      const failingRollbackAdapter = new Proxy(adapter, {
        get(target, property) {
          if (property === 'rollbackToSavepoint') {
            return async (name: string) => {
              if (failNextSavepointRollback) {
                failNextSavepointRollback = false
                throw new Error('savepoint rollback failed')
              }
              return target.rollbackToSavepoint?.(name)
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const db = createDatabase({ adapter: failingRollbackAdapter, dialect: createDialect('sqlite') })
      configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
      await adapter.execute('PRAGMA foreign_keys = ON')
      await adapter.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
      await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED, name TEXT NOT NULL)')
      const seen: string[] = []
      const Child = defineChildModel(seen)

      const child = Child.make({ parentId: 42, name: 'Ada' })
      await expect(db.transaction(async tx => {
        await expect(tx.transaction(async () => {
          await child.save()
          throw new Error('nested work failed')
        })).rejects.toThrow('savepoint rollback failed')
      })).rejects.toThrow('FOREIGN KEY')
      expect(await db.table('children').count()).toBe(0)
      expect(child.get('name')).toBe('Ada')
      expect(child.isDirty()).toBe(true)

      await db.table('parents').insert({ id: 42 })
      await child.save()

      expect(seen).toEqual(['Ada', 'Ada'])
      expect(await db.table('children').get()).toMatchObject([{ parentId: 42, name: 'Ada!' }])
    })

    it('keeps the saved state when an afterCommit callback fails after the COMMIT succeeded', async () => {
      const db = await openDatabaseWithDeferredForeignKey()
      await db.table('parents').insert({ id: 42 })
      const seen: string[] = []
      const Child = defineChildModel(seen)

      const child = Child.make({ parentId: 42, name: 'Ada' })
      await expect(db.transaction(async tx => {
        await child.save()
        tx.afterCommit(() => {
          throw new Error('notification failed')
        })
      })).rejects.toThrow('notification failed')

      expect(seen).toEqual(['Ada'])
      expect(child.get('name')).toBe('Ada!')
      expect(child.isDirty()).toBe(false)
      expect(await db.table('children').get()).toMatchObject([{ parentId: 42, name: 'Ada!' }])
    })
  })
})
