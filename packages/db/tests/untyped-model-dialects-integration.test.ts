import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, DatabaseError, type Entity, belongsTo, belongsToMany, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineGeneratedTable, defineModel, hasMany, hasOne, holoRuntimeInternals, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

type Driver = typeof drivers[number]

function useAppTimezone(timeZone: string): void {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone: timeZone } } as never)
  process.env.TZ = 'Asia/Tokyo'
  onTestFinished(() => {
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  })
}

async function openAnalyticsConnection(driver: Driver) {
  const { db: analytics } = await openDatabase(driver, { connectionName: 'analytics' })
  const defaultAdapter = createSQLiteAdapter({ filename: ':memory:' })
  await defaultAdapter.initialize()
  onTestFinished(() => defaultAdapter.disconnect())
  const defaultConnection = createDatabase({ connectionName: 'default', adapter: defaultAdapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: defaultConnection, analytics } }))
  const schema = createSchemaService(analytics)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const created: string[] = []
  onTestFinished(async () => {
    for (const name of created.reverse()) await schema.dropTable(name)
  })
  return {
    schema,
    async createTable(prefix: string, build: Parameters<typeof schema.createTable>[1]): Promise<string> {
      const name = `${prefix}_${suffix}`
      await schema.createTable(name, build)
      created.push(name)
      return name
    },
  }
}

function expectRecent(value: unknown): void {
  expect(value).toBeInstanceOf(Date)
  expect(Math.abs((value as Date).getTime() - Date.now())).toBeLessThan(60_000)
}

function storedInstant(value: unknown): Date {
  if (value instanceof Date) return value
  const text = String(value)
  return holoRuntimeInternals.parseSQLiteDateTime(text) ?? new Date(text)
}

describe.each(drivers)('an untyped model on a %s connection', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('stores dates, datetimes, timestamps and soft deletes the same way a typed model does', async () => {
    useAppTimezone('America/New_York')
    const { createTable } = await openAnalyticsConnection(driver)
    const name = await createTable('events', (table) => {
      table.id()
      table.string('label')
      table.date('day').nullable()
      table.datetime('at').nullable()
      table.timestamps()
      table.timestamp('deleted_at').nullable()
    })
    const typedTable = defineGeneratedTable(name, {
      id: column.id(),
      label: column.string(),
      day: column.date().nullable(),
      at: column.datetime().nullable(),
      created_at: column.timestamp().nullable(),
      updated_at: column.timestamp().nullable(),
      deleted_at: column.timestamp().nullable(),
    })
    const Typed = defineModel(typedTable, { connectionName: 'analytics', name: 'TypedEvent', fillable: ['label', 'day', 'at'], softDeletes: true })
    const Untyped = defineModel(name, { connectionName: 'analytics', name: 'UntypedEvent', fillable: ['label', 'day', 'at'], softDeletes: true, casts: { day: 'date', at: 'datetime' } })
    const at = new Date('2026-11-15T03:30:00Z')
    const day = new Date('2026-11-14T12:00:00Z')

    await Typed.create({ label: 'typed', day, at })
    const untyped = await Untyped.create({ label: 'untyped', day, at })
    const stored = await DB.table(name, 'analytics').orderBy('id').get()
    const found = await Untyped.findOrFail(untyped.get('id'))

    expect(stored[1]?.at).toEqual(stored[0]?.at)
    expect(stored[1]?.day).toEqual(stored[0]?.day)
    expect(found.get('at')).toEqual(at)
    expectRecent(found.get('created_at'))
    expectRecent(found.get('updated_at'))
    expect(await Untyped.where('at', at).count()).toBe(2)

    const later = new Date('2026-12-01T18:45:00Z')
    await found.update({ at: later })
    expect((await Untyped.findOrFail(untyped.get('id'))).get('at')).toEqual(later)
    expect(await Untyped.where('at', later).count()).toBe(1)

    await found.delete()
    expect(await Untyped.find(untyped.get('id'))).toBeUndefined()
    expectRecent((await Untyped.withTrashed().findOrFail(untyped.get('id'))).get('deleted_at'))

    await Untyped.where('label', 'typed').delete()
    expect(await Untyped.count()).toBe(0)
    expectRecent((await Untyped.withTrashed().where('label', 'typed').firstOrFail()).get('deleted_at'))

    await found.restore()
    expect((await Untyped.findOrFail(untyped.get('id'))).get('deleted_at')).toBeNull()
  })
  it('writes pivot timestamps as the instant of the attach', async () => {
    useAppTimezone('America/New_York')
    const { createTable } = await openAnalyticsConnection(driver)
    const users = await createTable('users', (table) => {
      table.id()
      table.string('name')
    })
    const roles = await createTable('roles', (table) => {
      table.id()
      table.string('name')
    })
    const memberships = await createTable('memberships', (table) => {
      table.integer('user_id')
      table.integer('role_id')
      table.timestamps()
    })
    const Role = defineModel(roles, { connectionName: 'analytics', name: 'Role', fillable: ['name'], timestamps: false })
    const User = defineModel(users, {
      connectionName: 'analytics',
      name: 'User',
      fillable: ['name'],
      timestamps: false,
      relations: { roles: belongsToMany(() => Role, memberships, 'user_id', 'role_id').withTimestamps() },
    })
    const user = await User.create({ name: 'Ada' })
    const role = await Role.create({ name: 'admin' })

    await user.attach('roles', role.get('id'))
    const [stored] = await DB.table(memberships, 'analytics').get()

    expectRecent(storedInstant(stored?.created_at))
    expectRecent(storedInstant(stored?.updated_at))
  })

  it('reads withTimestamps() pivot columns as Date', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const users = await createTable('users', (table) => {
      table.id()
      table.string('name')
    })
    const roles = await createTable('roles', (table) => {
      table.id()
      table.string('name')
    })
    const memberships = await createTable('memberships', (table) => {
      table.integer('user_id')
      table.integer('role_id')
      table.timestamps()
    })
    const Role = defineModel(roles, { connectionName: 'analytics', name: 'Role', fillable: ['name'], timestamps: false })
    const User = defineModel(users, {
      connectionName: 'analytics',
      name: 'User',
      fillable: ['name'],
      timestamps: false,
      relations: { roles: belongsToMany(() => Role, memberships, 'user_id', 'role_id').withTimestamps() },
    })
    const user = await User.create({ name: 'Ada' })
    await user.attach('roles', (await Role.create({ name: 'admin' })).get('id'))

    const eager = await User.with('roles').findOrFail(user.get('id'))
    const lazy = await User.findOrFail(user.get('id'))
    await lazy.load('roles')

    for (const loaded of [eager, lazy]) {
      const [role] = loaded.getRelation<Entity[]>('roles')
      const pivot = role?.getRelation<Record<string, unknown>>('pivot')
      expectRecent(pivot?.created_at)
      expectRecent(pivot?.updated_at)
    }
  })
  it('reads an incrementing key as the number create() returns', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const sites = await createTable('sites', (table) => {
      table.id()
      table.string('host')
    })
    const Site = defineModel(sites, { connectionName: 'analytics', fillable: ['host'], timestamps: false })

    const created = await Site.create({ host: 'example.com' })
    const found = await Site.findOrFail(created.get('id'))

    expect(created.get('id')).toBe(1)
    expect(found.get('id')).toBe(created.get('id'))
    expect((await Site.all()).map(site => site.get('id'))).toEqual([1])
  })

  it('keeps a numeric-looking string key it names as primaryKey, so update and delete touch only that row', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const accounts = await createTable('accounts', (table) => {
      table.string('number').primaryKey()
      table.string('owner')
    })
    const Account = defineModel(accounts, { connectionName: 'analytics', primaryKey: 'number', fillable: ['number', 'owner'], timestamps: false })
    await Account.create({ number: '42', owner: 'alice' })
    await Account.create({ number: '042', owner: 'bob' })

    const alice = await Account.findOrFail('42')
    expect(alice.get('number')).toBe('42')

    await alice.update({ owner: 'alice2' })
    expect(await DB.table(accounts, 'analytics').orderBy('number').get()).toEqual([
      { number: '042', owner: 'bob' },
      { number: '42', owner: 'alice2' },
    ])

    await alice.delete()
    expect(await DB.table(accounts, 'analytics').get()).toEqual([{ number: '042', owner: 'bob' }])
  })

  it('reads a non-canonical integer id as the text the driver returns', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const codes = await createTable('codes', (table) => {
      table.string('id').primaryKey()
      table.string('label')
    })
    const Code = defineModel(codes, { connectionName: 'analytics', fillable: ['id', 'label'], timestamps: false })
    await Code.create({ id: '42', label: 'canonical' })
    await Code.create({ id: '042', label: 'padded' })

    const padded = await Code.findOrFail('042')
    expect(padded.get('id')).toBe('042')
    expect((await Code.findOrFail('42')).get('id')).toBe(42)

    await padded.update({ label: 'padded2' })
    await padded.delete()
    expect(await DB.table(codes, 'analytics').get()).toEqual([{ id: '42', label: 'canonical' }])
  })

  it('matches relations whose key and foreign key columns have different integer types', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const sites = await createTable('sites', (table) => {
      table.id()
      table.string('host')
    })
    const posts = await createTable('posts', (table) => {
      table.id()
      table.integer('site_id')
      table.string('title')
    })
    const tags = await createTable('tags', (table) => {
      table.id()
      table.string('name')
    })
    const postTag = await createTable('post_tag', (table) => {
      table.integer('post_id')
      table.integer('tag_id')
    })
    const Tag = defineModel(tags, { connectionName: 'analytics', name: 'Tag', fillable: ['name'], timestamps: false })
    const Post = defineModel(posts, { connectionName: 'analytics', name: 'Post', fillable: ['site_id', 'title'], timestamps: false })
    const Site = defineModel(sites, {
      connectionName: 'analytics',
      name: 'Site',
      fillable: ['host'],
      timestamps: false,
      relations: { posts: hasMany(() => Post, 'site_id'), firstPost: hasOne(() => Post, 'site_id') },
    })
    const SitePost = defineModel(posts, {
      connectionName: 'analytics',
      name: 'SitePost',
      timestamps: false,
      relations: { site: belongsTo(() => Site, 'site_id'), tags: belongsToMany(() => Tag, postTag, 'post_id', 'tag_id') },
    })
    const site = await Site.create({ host: 'example.com' })
    const post = await Post.create({ site_id: site.get('id'), title: 'Hello' })
    const tag = await Tag.create({ name: 'news' })
    await (await SitePost.findOrFail(post.get('id'))).attach('tags', tag.get('id'))

    const eagerSite = await Site.with('posts', 'firstPost').withCount('posts').findOrFail(site.get('id'))
    const eagerPost = await SitePost.with('site', 'tags').withCount('tags').findOrFail(post.get('id'))
    const lazySite = await Site.findOrFail(site.get('id'))
    const lazyPost = await SitePost.findOrFail(post.get('id'))
    await lazySite.load('posts', 'firstPost')
    await lazySite.loadCount('posts')
    await lazyPost.load('site', 'tags')
    await lazyPost.loadCount('tags')

    for (const loaded of [eagerSite.toJSON(), lazySite.toJSON()]) {
      expect(loaded).toMatchObject({ posts: [{ title: 'Hello' }], firstPost: { title: 'Hello' }, posts_count: 1 })
    }
    for (const loaded of [eagerPost.toJSON(), lazyPost.toJSON()]) {
      expect(loaded).toMatchObject({ site: { host: 'example.com' }, tags: [{ name: 'news' }], tags_count: 1 })
    }
  })
})

describe.each(drivers)('relation key matching on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('matches an integer key to the same number stored as text, but not to other text', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const sites = await createTable('sites', (table) => {
      table.id()
      table.string('host')
    })
    const links = await createTable('links', (table) => {
      table.id()
      table.string('site_ref')
      table.string('url')
    })
    const sitesTable = defineGeneratedTable(sites, { id: column.id(), host: column.string() })
    const linksTable = defineGeneratedTable(links, { id: column.id(), site_ref: column.string(), url: column.string() })
    const Site = defineModel(sitesTable, { connectionName: 'analytics', name: 'Site', fillable: ['host'], timestamps: false })
    const Link = defineModel(linksTable, {
      connectionName: 'analytics',
      name: 'Link',
      fillable: ['site_ref', 'url'],
      timestamps: false,
      relations: { site: belongsTo(() => Site, 'site_ref') },
    })
    await Site.create({ host: 'example.com' })
    await Link.create({ site_ref: '1', url: '/same' })
    await Link.create({ site_ref: '01', url: '/padded' })

    const eager = await Link.with('site').orderBy('id').get()
    const lazy = await Link.orderBy('id').get()
    await lazy.load('site')

    for (const loaded of [eager, lazy]) {
      expect(loaded.map(link => link.toJSON())).toMatchObject([{ site: { host: 'example.com' } }, { site: null }])
    }
  })
})

describe.each(drivers)('an untyped model with a boolean cast on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('writes booleans to integer and boolean columns as a typed model does', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const name = await createTable('flags', (table) => {
      table.id()
      table.integer('active')
      table.boolean('enabled')
    })
    const typedTable = defineGeneratedTable(name, { id: column.id(), active: column.integer(), enabled: column.boolean() })
    const Typed = defineModel(typedTable, { connectionName: 'analytics', name: 'TypedFlag', fillable: ['active', 'enabled'], timestamps: false, casts: { active: 'boolean' } })
    const Untyped = defineModel(name, { connectionName: 'analytics', name: 'UntypedFlag', fillable: ['active', 'enabled'], timestamps: false, casts: { active: 'boolean', enabled: 'boolean' } })

    await Typed.create({ active: true, enabled: false })
    const created = await Untyped.create({ active: true, enabled: false })
    const stored = await DB.table(name, 'analytics').orderBy('id').get()

    expect(stored[1]).toEqual({ ...stored[0], id: stored[1]?.id })
    expect((await Untyped.findOrFail(created.get('id'))).toJSON()).toMatchObject({ active: true, enabled: false })
    expect(await Untyped.where('active', 1).count()).toBe(2)
  })

  it('finds the rows it wrote when where() compares a text or integer column with a boolean', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const name = await createTable('toggles', (table) => {
      table.id()
      table.string('label')
      table.integer('active')
    })
    const Toggle = defineModel(name, { connectionName: 'analytics', name: 'UntypedToggle', fillable: ['label', 'active'], timestamps: false, casts: { label: 'boolean', active: 'boolean' } })

    await Toggle.create({ label: true, active: true })
    await Toggle.create({ label: false, active: false })

    expect(await Toggle.where('label', true).count()).toBe(1)
    expect(await Toggle.where('active', true).count()).toBe(1)
    expect(await Toggle.where('active', false).count()).toBe(1)
  })

  it('binds a real boolean to a boolean column that a definition describes', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const name = await createTable('switches', (table) => {
      table.id()
      table.boolean('enabled')
    })
    const switches = defineGeneratedTable(name, { id: column.id(), enabled: column.boolean() })
    await DB.table(switches, 'analytics').insert([{ enabled: true }, { enabled: false }])

    expect(DB.table(switches, 'analytics').where('enabled', true).toSQL().bindings).toEqual([driver === 'postgres' ? true : 1])
    expect(await DB.table(switches, 'analytics').where('enabled', true).count()).toBe(1)
  })
})

describe.each(drivers)('an untyped model with guarded: [] on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('writes any attribute, leaving unknown columns to the database as Eloquent does', async () => {
    const { createTable } = await openAnalyticsConnection(driver)
    const name = await createTable('page_views', (table) => {
      table.id()
      table.string('path')
      table.integer('hits').default(0)
      table.json('meta').nullable()
    })
    const PageView = defineModel(name, { connectionName: 'analytics', name: 'OpenPageView', guarded: [], timestamps: false, casts: { meta: 'json' } })

    const view = await PageView.create({ path: '/a', hits: 9, meta: { role: 'guest' } })
    await view.update({ 'meta->role': 'admin' })

    expect((await PageView.findOrFail(view.get('id'))).toJSON()).toMatchObject({ path: '/a', hits: 9, meta: { role: 'admin' } })
    await expect(PageView.create({ path: '/b', referrer: 'ad' })).rejects.toThrow(DatabaseError)
  })
})
