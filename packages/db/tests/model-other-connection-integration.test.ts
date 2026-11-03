import { randomUUID } from 'node:crypto'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineGeneratedTable, defineModel, hasMany, latestOfMany, registerGeneratedTables, resetDB } from '../src'
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
