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
