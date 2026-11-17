import { randomUUID } from 'node:crypto'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, belongsToMany, clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineGeneratedTable, defineModel, hasMany, latestOfMany, registerGeneratedTables, resetDB } from '../src'
import { openDatabase } from './support/database'

async function openAnalyticsConnection() {
  const { db } = await openDatabase('postgres')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { pageViews: `page_views_${suffix}`, sites: `sites_${suffix}` }
  const analyticsAdapter = createSQLiteAdapter({ filename: ':memory:' })
  await analyticsAdapter.initialize()
  onTestFinished(() => analyticsAdapter.disconnect())
  const analytics = createDatabase({ connectionName: 'analytics', adapter: analyticsAdapter, dialect: createDialect('sqlite') })
  const schema = createSchemaService(analytics)
  await schema.createTable(names.sites, (table) => {
    table.id()
    table.string('host')
  })
  await schema.createTable(names.pageViews, (table) => {
    table.id()
    table.integer('site_id').nullable()
    table.string('path')
    table.integer('hits').default(0)
    table.text('meta').nullable()
    table.timestamps()
    table.timestamp('deleted_at').nullable()
  })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db, analytics } }))
  return { names, db }
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('a model on a connection other than the default', () => {
  afterEach(() => {
    resetDB()
    clearGeneratedTables()
  })

  it('creates and finds a record without a Generated-schema definition', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', fillable: ['path'] })

    const created = await PageView.create({ path: '/pricing' })
    const found = await PageView.findOrFail(created.get('id'))

    expect(created.get('id')).toBe(1)
    expect(found.get('path')).toBe('/pricing')
    expect(found.toJSON()).toMatchObject({ id: 1, path: '/pricing', hits: 0 })
  })

  it('queries, updates, paginates and deletes records', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', fillable: ['path', 'hits'] })
    await PageView.create({ path: '/a', hits: 3 })
    const second = await PageView.create({ path: '/b', hits: 5 })
    await PageView.create({ path: '/c', hits: 7 })

    await second.update({ hits: 6 })
    await PageView.where('path', '/c').firstOrFail().then(view => view.delete())
    const page = await PageView.where('hits', '>', 1).orderBy('id').paginate(1, 2)

    expect(page.meta.total).toBe(2)
    expect(page.data.map(view => view.get('path'))).toEqual(['/b'])
    expect((await PageView.findOrFail(second.get('id'))).path).toBe('/b')
    expect((await PageView.findOrFail(second.get('id'))).get('hits')).toBe(6)
    expect(await PageView.find(3)).toBeUndefined()
  })

  it('fills timestamps and soft-deletes by convention', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', fillable: ['path'], softDeletes: true })
    const view = await PageView.create({ path: '/a' })

    await view.delete()

    expect(view.get('created_at')).toBeInstanceOf(Date)
    expect(view.get('updated_at')).toBeInstanceOf(Date)
    expect(await PageView.find(view.get('id'))).toBeUndefined()
    expect((await PageView.withTrashed().findOrFail(view.get('id'))).get('deleted_at')).not.toBeNull()
  })

  it('leaves timestamps alone when the model turns them off', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', fillable: ['path'], timestamps: false })

    const view = await PageView.create({ path: '/a' })

    expect(view.get('created_at')).toBeUndefined()
    expect(view.get('updated_at')).toBeUndefined()
  })

  it('applies declared casts and returns other values as the driver reads them', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', fillable: ['path', 'meta'], casts: { meta: 'json' } })

    const view = await PageView.create({ path: '/a', meta: { source: 'ad' } })
    const found = await PageView.findOrFail(view.get('id'))

    expect(found.get('meta')).toEqual({ source: 'ad' })
    expect(await DB.table(names.pageViews, 'analytics').where('id', view.get('id')).value('meta')).toBe('{"source":"ad"}')
    expect(found.get('hits')).toBe(0)
  })

  it('allows only fillable attributes on a fillable model', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', name: 'PageView', fillable: ['path'] })

    await expect(PageView.create({ path: '/a', hits: 9 })).rejects.toThrow('Column "hits" is not writable on model "PageView".')
    expect((await PageView.create({ path: '/b' })).get('path')).toBe('/b')
  })

  it('checks a guarded model\'s attributes against the table\'s real columns', async () => {
    const { names } = await openAnalyticsConnection()
    const Guarded = defineModel(names.pageViews, { connectionName: 'analytics', name: 'GuardedPageView', guarded: ['hits'] })

    await expect(Guarded.make({ path: '/a', referrer: 'ad' }).save()).rejects.toThrow('Column "referrer" is not writable on model "GuardedPageView".')
    await expect(Guarded.create({ path: '/a', hits: 9 })).rejects.toThrow('Column "hits" is not writable on model "GuardedPageView".')
    await expect(Guarded.create({ path: '/a', referrer: 'ad' })).rejects.toThrow('Column "referrer" is not writable on model "GuardedPageView".')
    await expect(Guarded.create({ path: '/a', 'meta->role': 'admin' })).rejects.toThrow('Column "meta->role" is not writable on model "GuardedPageView".')
    const view = await Guarded.create({ path: '/b', site_id: 4 })
    expect(() => view.fill({ 'meta->role': 'admin' })).toThrow('Column "meta->role" is not writable on model "GuardedPageView".')
    expect(view.get('site_id')).toBe(4)
    expect(await DB.table(names.pageViews, 'analytics').count()).toBe(1)
  })

  it('sees a column a migration adds to a guarded model\'s table in the same process', async () => {
    const { names } = await openAnalyticsConnection()
    const Guarded = defineModel(names.pageViews, { connectionName: 'analytics', name: 'GuardedPageView', guarded: ['hits'] })
    await expect(Guarded.create({ path: '/a', referrer: 'ad' })).rejects.toThrow('Column "referrer" is not writable on model "GuardedPageView".')

    await createSchemaService(DB.connection('analytics')).table(names.pageViews, (table) => {
      table.string('referrer').nullable()
    })

    expect((await Guarded.create({ path: '/a', referrer: 'ad' })).get('referrer')).toBe('ad')
  })

  it('reads the key the model names as its primary key', async () => {
    const { names } = await openAnalyticsConnection()
    const tableName = `${names.pageViews}_keyed`
    await createSchemaService(DB.connection('analytics')).createTable(tableName, (table) => {
      table.id('view_id')
      table.string('path')
    })
    const PageView = defineModel(tableName, { connectionName: 'analytics', fillable: ['path'], primaryKey: 'view_id', timestamps: false })

    const first = await PageView.create({ path: '/a' })
    const second = await PageView.create({ path: '/b' })

    expect([first.get('view_id'), second.get('view_id')]).toEqual([1, 2])
    expect((await PageView.findOrFail(2)).get('path')).toBe('/b')
  })

  it('loads relations between models on that connection', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', name: 'PageView', fillable: ['path', 'site_id', 'hits'] })
    const Site = defineModel(names.sites, {
      connectionName: 'analytics',
      fillable: ['host'],
      timestamps: false,
      relations: { pageViews: hasMany(() => PageView, 'site_id'), latestView: latestOfMany(() => PageView, 'site_id') },
    })
    const SiteView = defineModel(names.pageViews, {
      connectionName: 'analytics',
      name: 'SiteView',
      relations: { site: belongsTo(() => Site, 'site_id') },
    })
    const site = await Site.create({ host: 'example.com' })
    await PageView.create({ path: '/a', site_id: site.get('id'), hits: 2 })
    await PageView.create({ path: '/b', site_id: site.get('id'), hits: 3 })

    const loaded = await Site.with('pageViews').findOrFail(site.get('id'))
    const view = await SiteView.with('site').where('path', '/b').firstOrFail()
    const counted = await Site.withCount('pageViews').withSum('pageViews', 'hits').findOrFail(site.get('id'))
    const latest = await Site.with('latestView').findOrFail(site.get('id'))

    expect(loaded.pageViews.map(related => related.get('path'))).toEqual(['/a', '/b'])
    expect(view.site?.get('host')).toBe('example.com')
    expect(counted.get('pageViews_count')).toBe(2)
    expect(counted.get('pageViews_sum_hits')).toBe(5)
    expect(latest.latestView?.get('path')).toBe('/b')
  })

  it('queries its own connection through the model\'s table definition without checking column names', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', fillable: ['path', 'hits'] })
    await PageView.create({ path: '/a', hits: 3 })
    await PageView.create({ path: '/b', hits: 5 })

    await DB.table(PageView.definition.table, 'analytics').where('path', '/b').update({ hits: 8 })

    expect(await DB.table(PageView.definition.table, 'analytics').where('path', '/b').value('hits')).toBe(8)
    expect(await DB.table(PageView.definition.table, 'analytics').where('hits', '>', 1).orderBy('id').pluck('path')).toEqual(['/a', '/b'])
    expect(await DB.table(PageView.definition.table, 'analytics').select('path', 'hits').where('id', 1).first()).toEqual({ path: '/a', hits: 3 })
  })

  it('queries a same-named default-connection table in a transaction through the model\'s table definition', async () => {
    const { names, db } = await openAnalyticsConnection()
    const defaultSchema = createSchemaService(db)
    await defaultSchema.createTable(names.pageViews, (table) => {
      table.id()
      table.string('path')
      table.integer('hits').default(0)
    })
    onTestFinished(() => defaultSchema.dropTable(names.pageViews))
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics' })
    await DB.table(names.pageViews).insert([{ path: '/a', hits: 1 }, { path: '/b', hits: 2 }])

    const hits = await DB.transaction(async (tx) => {
      await tx.table(PageView.definition.table).where('path', '/b').update({ hits: 9 })
      return tx.table(PageView.definition.table).where('path', '/b').lockForUpdate().value('hits')
    })

    expect(hits).toBe(9)
    expect(await DB.table(names.pageViews).orderBy('id').pluck('hits')).toEqual([1, 9])
  })

  it('keeps a model\'s own columns when it joins a subquery that joins an untyped model\'s table definition', async () => {
    const { names, db } = await openAnalyticsConnection()
    const defaultSchema = createSchemaService(db)
    const owners = `owners_${names.sites}`
    await defaultSchema.createTable(owners, (table) => {
      table.id()
      table.string('name')
    })
    await defaultSchema.createTable(names.pageViews, (table) => {
      table.id()
      table.integer('owner_id')
      table.string('path')
    })
    onTestFinished(async () => {
      await defaultSchema.dropTable(names.pageViews)
      await defaultSchema.dropTable(owners)
    })
    registerGeneratedTables({
      owners: defineGeneratedTable(owners, { id: column.id(), name: column.string() }),
    })
    const Owner = defineModel(owners, { timestamps: false })
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics' })
    await DB.table(owners).insert({ name: 'Ada' })
    await DB.table(names.pageViews).insert({ id: 9, owner_id: 1, path: '/a' })
    const views = DB.table(owners)
      .join(PageView.definition.table, `${owners}.id`, '=', `${names.pageViews}.owner_id`)
      .select(`${names.pageViews}.*`)

    const [owner] = await Owner.joinSub(views, 'views', `${owners}.id`, '=', 'views.owner_id')
      .select(`${owners}.*`, 'views.*')
      .get()

    expect(owner?.get('id')).toBe(1)
    expect(owner?.get('name')).toBe('Ada')
  })

  it('reads a pivot through an untyped model\'s table definition as it reads the pivot\'s table name', async () => {
    const { names, db } = await openAnalyticsConnection()
    const defaultSchema = createSchemaService(db)
    const users = `users_${names.sites}`
    const roles = `roles_${names.sites}`
    const roleUser = `role_user_${names.sites}`
    await defaultSchema.createTable(users, (table) => {
      table.id()
      table.string('name')
    })
    await defaultSchema.createTable(roles, (table) => {
      table.id()
      table.string('name')
    })
    await defaultSchema.createTable(roleUser, (table) => {
      table.string('user_id')
      table.string('role_id')
    })
    onTestFinished(async () => {
      await defaultSchema.dropTable(roleUser)
      await defaultSchema.dropTable(roles)
      await defaultSchema.dropTable(users)
    })
    registerGeneratedTables({
      users: defineGeneratedTable(users, { id: column.id(), name: column.string() }),
      roles: defineGeneratedTable(roles, { id: column.id(), name: column.string() }),
    })
    const RoleUser = defineModel(roleUser, { connectionName: 'analytics' })
    const Role = defineModel(roles, { timestamps: false })
    const User = defineModel(users, { timestamps: false, relations: { roles: belongsToMany(() => Role, RoleUser.definition.table, 'user_id', 'role_id') } })
    await DB.table(users).insert([{ name: 'Ada' }, { name: 'Grace' }])
    await DB.table(roles).insert({ name: 'admin' })
    await DB.table(roleUser).insert({ user_id: '1', role_id: '1' })

    expect(await User.whereHas('roles').count()).toBe(1)
  })

  it('defines another untyped model from an untyped model\'s table definition', async () => {
    const { names } = await openAnalyticsConnection()
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics' })
    const Visit = defineModel(PageView.definition.table, { connectionName: 'analytics', name: 'Visit', fillable: ['path'] })

    const visit = await Visit.create({ path: '/a' })

    expect(visit.get('id')).toBe(1)
    expect(visit.get('created_at')).toBeInstanceOf(Date)
    expect((await Visit.findOrFail(1)).get('path')).toBe('/a')
  })

  it('ignores a same-named Generated-schema table on the default connection', async () => {
    const { names, db } = await openAnalyticsConnection()
    const defaultSchema = createSchemaService(db)
    await defaultSchema.createTable(names.pageViews, (table) => {
      table.uuid('code').primaryKey()
      table.integer('path')
    })
    onTestFinished(() => defaultSchema.dropTable(names.pageViews))
    registerGeneratedTables({
      pageViews: defineGeneratedTable(names.pageViews, { code: column.uuid().primaryKey(), path: column.integer() }),
    })
    const PageView = defineModel(names.pageViews, { connectionName: 'analytics', fillable: ['path', 'hits'] })

    const view = await PageView.create({ path: '/pricing', hits: 2 })
    const found = await PageView.findOrFail(view.get('id'))

    expect(view.get('id')).toBe(1)
    expect(found.get('path')).toBe('/pricing')
    expect(found.get('hits')).toBe(2)
  })
})
