import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, belongsToMany, clearGeneratedTables, column, defineGeneratedTable, defineModel, hasMany, hasManyThrough, hasOne, registerGeneratedTables, resetDB, type Entity, type ModelDefinitionLike, type TableDefinition } from '../src'
import { integrationDrivers, mysqlTestConnection, openDatabase } from './support/database'

type Category = Entity<TableDefinition>

function id(entity: Category): number {
  return Number(entity.get('id' as never))
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right)
}

function related(entity: Category, name: string): Category[] {
  const value = entity.getRelation<Category | Category[] | null>(name)
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

async function openSelfFixtures(driver: 'sqlite' | 'postgres' | 'mysql') {
  const { schema, adapter, db } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { categories: `sr_categories_${suffix}`, links: `sr_links_${suffix}`, posts: `sr_posts_${suffix}`, grants: `sr_grants_${suffix}` }
  await schema.createTable(names.categories, (table) => {
    table.integer('id').primaryKey()
    table.integer('parent_id').nullable()
    table.string('name')
  })
  onTestFinished(() => schema.dropTable(names.categories))
  await schema.createTable(names.links, (table) => {
    table.integer('id').primaryKey()
    table.integer('category_id')
    table.integer('related_id')
  })
  onTestFinished(() => schema.dropTable(names.links))
  await schema.createTable(names.posts, (table) => {
    table.integer('id').primaryKey()
    table.integer('category_id')
  })
  onTestFinished(() => schema.dropTable(names.posts))
  await schema.createTable(names.grants, (table) => {
    table.integer('id').primaryKey()
    table.integer('category_id')
  })
  onTestFinished(() => schema.dropTable(names.grants))

  const categories = defineGeneratedTable(names.categories, { id: column.integer().primaryKey(), parent_id: column.integer().nullable(), name: column.string() })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), category_id: column.integer() })
  const links = defineGeneratedTable(names.links, { id: column.integer().primaryKey(), category_id: column.integer(), related_id: column.integer() })

  await DB.table(categories).insert([
    { id: 1, parent_id: null, name: 'root' },
    { id: 2, parent_id: 1, name: 'branch' },
    { id: 3, parent_id: 1, name: 'leaf' },
    { id: 4, parent_id: 2, name: 'leaf' },
    { id: 5, parent_id: null, name: 'lonely' },
  ])
  await DB.table(links).insert([
    { id: 1, category_id: 1, related_id: 2 },
    { id: 2, category_id: 2, related_id: 5 },
    { id: 3, category_id: 3, related_id: 4 },
    { id: 4, category_id: 4, related_id: 4 },
  ])
  const grants = defineGeneratedTable(names.grants, { id: column.integer().primaryKey(), category_id: column.integer() })
  await DB.table(grants).insert([{ id: 1, category_id: 1 }, { id: 2, category_id: 2 }, { id: 3, category_id: 3 }])
  await DB.table(posts).insert([{ id: 1, category_id: 3 }, { id: 2, category_id: 1 }, { id: 3, category_id: 2 }])

  const Post = defineModel(posts, { timestamps: false })
  const Leaf = defineModel(categories, { timestamps: false })
  const selfRelations = <TModel extends ModelDefinitionLike<TableDefinition>>(Target: TModel) => ({
    children: hasMany(() => Target, 'parent_id'),
    firstChild: hasOne(() => Target, 'parent_id'),
    parent: belongsTo(() => Target, 'parent_id'),
    linked: belongsToMany(() => Target, links, 'category_id', 'related_id'),
    grandchildren: hasManyThrough(() => Target, () => Target, 'parent_id', 'parent_id'),
    posts: hasMany(() => Post, 'category_id'),
    pivotChildren: belongsToMany(() => Target, categories, 'parent_id', 'id'),
    childPosts: hasManyThrough(() => Post, () => Target, 'parent_id', 'category_id'),
  })
  const Branch = defineModel(categories, { timestamps: false, relations: selfRelations(Leaf) })
  const Category = defineModel(categories, { timestamps: false, relations: selfRelations(Branch) })
  const WithPosts = defineModel(categories, { timestamps: false, relations: { posts: hasMany(() => Post, 'category_id') }, globalScopes: { withPosts: query => query.has('posts') } })
  const ScopedParent = defineModel(categories, { timestamps: false, relations: { children: hasMany(() => WithPosts, 'parent_id') } })
  const Granted = defineModel(categories, {
    timestamps: false,
    globalScopes: { granted: query => query.whereExists(DB.table(grants).whereColumn(`${names.grants}.category_id` as never, '=', `${names.categories}.id`)) },
  })
  const GrantedParent = defineModel(categories, { timestamps: false, relations: { children: hasMany(() => Granted, 'parent_id') } })
  const schemaName = driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : mysqlTestConnection().database
  const qualifiedCategories = defineGeneratedTable(`${schemaName}.${names.categories}`, { id: column.integer().primaryKey(), parent_id: column.integer().nullable(), name: column.string() })
  const QualifiedLeaf = defineModel(qualifiedCategories, { name: `QualifiedLeaf${suffix}`, timestamps: false })
  const QualifiedParent = defineModel(qualifiedCategories, { name: `QualifiedParent${suffix}`, timestamps: false, relations: { children: hasMany(() => Leaf, 'parent_id'), parent: belongsTo(() => Leaf, 'parent_id') } })
  const PlainParent = defineModel(categories, { timestamps: false, relations: { children: hasMany(() => QualifiedLeaf, 'parent_id'), parent: belongsTo(() => QualifiedLeaf, 'parent_id') } })
  const QualifiedTree = defineModel(qualifiedCategories, { name: `QualifiedTree${suffix}`, timestamps: false, relations: { children: hasMany(() => QualifiedLeaf, 'parent_id') } })
  const PivotParent = defineModel(categories, {
    name: `PivotParent${suffix}`,
    timestamps: false,
    relations: { branchChildren: belongsToMany(() => Leaf, qualifiedCategories, 'parent_id', 'id').wherePivot(`${names.categories}.name` as never, 'branch') },
  })
  return { Category, Leaf, ScopedParent, GrantedParent, QualifiedParent, PlainParent, QualifiedTree, PivotParent, schema, adapter, db, schemaName, table: names.categories }
}

const relationNames = ['children', 'firstChild', 'parent', 'linked'] as const
const matchingReference = { children: 'children', firstChild: 'children', parent: 'parent', linked: 'linked' } as const

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('relation filters on self-referencing relations on %s', (driver) => {
  describe.each(relationNames)('through %s', (name) => {
    it('matches eager loading for has, whereHas and whereDoesntHave', async () => {
      const { Category } = await openSelfFixtures(driver)
      const loaded = await Category.with(name, matchingReference[name]).orderBy('id').get() as unknown as Category[]
      const all = sorted(loaded.map(id))
      const having = sorted(loaded.filter(entity => related(entity, name).length > 0).map(id))
      const havingBranch = sorted(loaded.filter(entity => related(entity, matchingReference[name]).some(item => item.get('name' as never) === 'branch')).map(id))

      const has = await Category.has(name).get() as unknown as Category[]
      const whereHas = await Category.whereHas(name, query => query.where('name', 'branch')).get() as unknown as Category[]
      const doesntHave = await Category.doesntHave(name).get() as unknown as Category[]
      const whereDoesntHave = await Category.whereDoesntHave(name, query => query.where('name', 'branch')).get() as unknown as Category[]

      expect(having.length).toBeGreaterThan(0)
      expect(havingBranch.length).toBeGreaterThan(0)
      expect(sorted(has.map(id))).toEqual(having)
      expect(sorted(whereHas.map(id))).toEqual(havingBranch)
      expect(sorted(doesntHave.map(id))).toEqual(all.filter(value => !having.includes(value)))
      expect(sorted(whereDoesntHave.map(id))).toEqual(all.filter(value => !havingBranch.includes(value)))
    })

    it('matches eager loading for withCount', async () => {
      const { Category } = await openSelfFixtures(driver)
      const reference = matchingReference[name]
      const loaded = await Category.with(reference).orderBy('id').get() as unknown as Category[]
      const counted = await Category.withCount(name).orderBy('id').get() as unknown as Category[]
      const leafCounted = await Category.withCount({ [name]: (query: { where(column: string, value: unknown): unknown }) => query.where('name', 'leaf') } as never).orderBy('id').get() as unknown as Category[]

      expect(counted.map(entity => Number(entity.get(`${name}_count` as never)))).toEqual(loaded.map(entity => related(entity, reference).length))
      expect(leafCounted.map(entity => Number(entity.get(`${name}_count` as never)))).toEqual(
        loaded.map(entity => related(entity, reference).filter(item => item.get('name' as never) === 'leaf').length),
      )
    })
  })

  it('matches eager loading for has, doesntHave and withCount through the same table', async () => {
    const { Category } = await openSelfFixtures(driver)
    const loaded = await Category.with('grandchildren').orderBy('id').get() as unknown as Category[]
    const having = sorted(loaded.filter(entity => related(entity, 'grandchildren').length > 0).map(id))

    const has = await Category.has('grandchildren').get() as unknown as Category[]
    const doesntHave = await Category.doesntHave('grandchildren').get() as unknown as Category[]
    const counted = await Category.withCount('grandchildren').orderBy('id').get() as unknown as Category[]

    expect(having).toEqual([1])
    expect(sorted(has.map(id))).toEqual(having)
    expect(sorted(doesntHave.map(id))).toEqual(loaded.map(id).filter(value => !having.includes(value)))
    expect(counted.map(entity => Number(entity.get('grandchildren_count' as never)))).toEqual(loaded.map(entity => related(entity, 'grandchildren').length))
  })

  it('matches eager loading through the parent table to another table', async () => {
    const { Category } = await openSelfFixtures(driver)
    const loaded = await Category.with('childPosts').orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'childPosts').length > 0).map(id)

    const has = await Category.has('childPosts').orderBy('id').get() as unknown as Category[]
    const doesntHave = await Category.doesntHave('childPosts').orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(has.map(id)).toEqual(expected)
    expect(doesntHave.map(id)).toEqual([2, 3, 4, 5])
  })

  it('correlates nested self-relation filters against their own parent level', async () => {
    const { Category } = await openSelfFixtures(driver)

    const grandparents = await Category.has('children.children').get() as unknown as Category[]
    const constrained = await Category.whereHas('children', query => query.whereHas('children', inner => inner.where('name', 'leaf'))).get() as unknown as Category[]
    const grandchildren = await Category.whereHas('parent.parent', query => query.where('name', 'root')).get() as unknown as Category[]
    const childOfLinked = await Category.whereHas('children', query => query.has('linked')).orderBy('id').get() as unknown as Category[]

    expect(grandparents.map(id)).toEqual([1])
    expect(constrained.map(id)).toEqual([1])
    expect(grandchildren.map(id)).toEqual([4])
    expect(childOfLinked.map(id)).toEqual([1, 2])
  })

  it('correlates other relations nested under a self-relation filter against the aliased level', async () => {
    const { Category } = await openSelfFixtures(driver)

    const childWithPosts = await Category.has('children.posts').get() as unknown as Category[]
    const grouped = await Category.whereHas('children', query => query.where(inner => inner.has('children').orWhere('name', 'leaf'))).orderBy('id').get() as unknown as Category[]
    const childWithoutPosts = await Category.whereHas('children', query => query.doesntHave('posts')).orderBy('id').get() as unknown as Category[]

    expect(childWithPosts.map(id)).toEqual([1])
    expect(grouped.map(id)).toEqual([1, 2])
    expect(childWithoutPosts.map(id)).toEqual([2])
  })

  it('applies the related model global scopes to the aliased self-relation row', async () => {
    const { ScopedParent } = await openSelfFixtures(driver)
    const loaded = await ScopedParent.with('children').orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const has = await ScopedParent.has('children').orderBy('id').get() as unknown as Category[]
    const doesntHave = await ScopedParent.doesntHave('children').orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(has.map(id)).toEqual(expected)
    expect(doesntHave.map(id)).toEqual([2, 3, 4, 5])
  })

  it('reads the table name in constraint joins and subqueries as the aliased row', async () => {
    const { Category, table } = await openSelfFixtures(driver)
    const postsTable = table.replace('sr_categories_', 'sr_posts_')
    const joined = (query: { join(...args: string[]): { where(column: string, value: unknown): unknown } }) => query
      .join(postsTable, `${postsTable}.category_id`, '=', `${table}.id`)
      .where(`${postsTable}.id`, 3)
    const loaded = await Category.with('children', joined as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const viaJoin = await Category.whereHas('children', joined as never).orderBy('id').get() as unknown as Category[]
    const viaExists = await Category.whereHas('children', query => query.whereExists(DB.table(postsTable).whereColumn(`${postsTable}.category_id`, '=', `${table}.id`).where('id', 3))).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(viaJoin.map(id)).toEqual(expected)
    expect(viaExists.map(id)).toEqual(expected)
  })

  it('keeps a nested query alias that reuses the table name bound to that query', async () => {
    const { Category, table } = await openSelfFixtures(driver)
    const postsTable = table.replace('sr_categories_', 'sr_posts_')
    const constraint = (query: { whereExists(subquery: unknown): unknown }) => query.whereExists(DB.table(`${postsTable} as ${table}`).where(`${table}.id`, 3))
    const loaded = await Category.with('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const filtered = await Category.whereHas('children', constraint as never).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1, 2])
    expect(filtered.map(id)).toEqual(expected)
  })

  it.each(['QualifiedParent', 'PlainParent'] as const)('aliases the same table named with and without its schema from %s', async (parentName) => {
    const fixtures = await openSelfFixtures(driver)
    const Parent = fixtures[parentName]

    const children = await Parent.has('children').orderBy('id').get() as unknown as Category[]
    const parents = await Parent.has('parent').orderBy('id').get() as unknown as Category[]

    expect(children.map(id)).toEqual([1, 2])
    expect(parents.map(id)).toEqual([2, 3, 4])
  })

  it('keeps a schema-qualified nested query on the table bound to that query', async () => {
    const { Category, table, schemaName } = await openSelfFixtures(driver)
    const constraint = (query: { whereExists(subquery: unknown): unknown }) => query.whereExists(DB.table(`${schemaName}.${table}`).where(`${table}.name`, 'root'))
    const loaded = await Category.with('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const filtered = await Category.whereHas('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const qualifiedNested = await Category.whereHas('children', query => query.whereExists(DB.table(`${schemaName}.${table}`).where(`${schemaName}.${table}.id`, 2))).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1, 2])
    expect(filtered.map(id)).toEqual(expected)
    expect(qualifiedNested.map(id)).toEqual([1, 2])
    const postsTable = table.replace('sr_categories_', 'sr_posts_')
    const unrelated = await Category.whereHas('children', query => query.whereExists(DB.table(postsTable).where(`${schemaName}.${postsTable}.id`, 3))).orderBy('id').get() as unknown as Category[]
    expect(unrelated.map(id)).toEqual([1, 2])
  })

  it('aliases a constraint that returns a fresh query on the same table', async () => {
    const { Category, Leaf } = await openSelfFixtures(driver)
    const constraint = () => Leaf.where('name', 'leaf')
    const loaded = await Category.with('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const filtered = await Category.whereHas('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const nested = await Category.whereHas('children', () => Category.has('children')).orderBy('id').get() as unknown as Category[]
    const nestedThrough = await Category.whereHas('grandchildren', () => Category.has('children')).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1, 2])
    expect(filtered.map(id)).toEqual(expected)
    expect(nested.map(id)).toEqual([1])
    expect(nestedThrough.map(id)).toEqual([])
  })

  it('reads the table name inside a related global scope subquery as the aliased row', async () => {
    const { GrantedParent } = await openSelfFixtures(driver)
    const loaded = await GrantedParent.with('children').orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const has = await GrantedParent.has('children').orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(has.map(id)).toEqual(expected)
  })

  it('correlates a belongsToMany whose pivot is the parent table against the outer row', async () => {
    const { Category } = await openSelfFixtures(driver)
    const loaded = await Category.with('pivotChildren').orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'pivotChildren').length > 0).map(id)

    const has = await Category.has('pivotChildren').orderBy('id').get() as unknown as Category[]
    const nested = await Category.has('pivotChildren.pivotChildren').orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1, 2])
    expect(has.map(id)).toEqual(expected)
    expect(nested.map(id)).toEqual([1])
  })

  it('reads table-qualified constraint columns from the related row, as eager loading does', async () => {
    const { Category, table } = await openSelfFixtures(driver)
    const loaded = await Category.with('children', query => query.where(`${table}.name` as never, 'branch')).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const filtered = await Category.whereHas('children', query => query.where(`${table}.name`, 'branch').whereColumn(`${table}.id`, '>', `${table}.parent_id`)).orderBy('id').get() as unknown as Category[]
    const grouped = await Category.whereHas('children', query => query.where(inner => inner.whereNull(`${table}.name`).orWhere(`${table}.name`, 'branch'))).orderBy('id').get() as unknown as Category[]
    const excluded = await Category.whereDoesntHave('parent', query => query.where(`${table}.name`, 'root')).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(filtered.map(id)).toEqual(expected)
    expect(grouped.map(id)).toEqual(expected)
    expect(excluded.map(id)).toEqual([1, 4, 5])
  })

  it('applies soft deletes of a self table joined as the through table', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const names = { nodes: `sr_nodes_${suffix}`, posts: `sr_node_posts_${suffix}` }
    await schema.createTable(names.nodes, (table) => {
      table.integer('id').primaryKey()
      table.integer('parent_id').nullable()
      table.timestamp('deleted_at').nullable()
    })
    onTestFinished(() => schema.dropTable(names.nodes))
    await schema.createTable(names.posts, (table) => {
      table.integer('id').primaryKey()
      table.integer('node_id')
    })
    onTestFinished(() => schema.dropTable(names.posts))
    const nodes = defineGeneratedTable(names.nodes, { id: column.integer().primaryKey(), parent_id: column.integer().nullable(), deleted_at: column.timestamp().nullable() })
    const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), node_id: column.integer() })
    const deletedAt = new Date('2026-01-01T00:00:00Z')
    await DB.table(nodes).insert([
      { id: 1, parent_id: null, deleted_at: null },
      { id: 2, parent_id: 1, deleted_at: null },
      { id: 3, parent_id: 2, deleted_at: null },
      { id: 7, parent_id: null, deleted_at: null },
      { id: 8, parent_id: 7, deleted_at: deletedAt },
      { id: 9, parent_id: 8, deleted_at: null },
    ])
    await DB.table(posts).insert([{ id: 1, node_id: 2 }, { id: 2, node_id: 8 }])
    const Post = defineModel(posts, { timestamps: false })
    const Leaf = defineModel(nodes, { timestamps: false, softDeletes: true })
    const Node = defineModel(nodes, {
      timestamps: false,
      softDeletes: true,
      relations: {
        grandchildren: hasManyThrough(() => Leaf, () => Leaf, 'parent_id', 'parent_id'),
        childPosts: hasManyThrough(() => Post, () => Leaf, 'parent_id', 'node_id'),
      },
    })

    for (const name of ['grandchildren', 'childPosts'] as const) {
      const loaded = await Node.with(name).orderBy('id').get() as unknown as Category[]
      const expected = loaded.filter(entity => related(entity, name).length > 0).map(id)
      const has = await Node.has(name).orderBy('id').get() as unknown as Category[]
      const doesntHave = await Node.doesntHave(name).orderBy('id').get() as unknown as Category[]

      expect(expected).toEqual([1])
      expect(has.map(id)).toEqual(expected)
      expect(doesntHave.map(id)).toEqual(loaded.map(id).filter(value => !expected.includes(value)))
    }
  })

  it('keeps deferred value conversions of nested queries on a table registered under another spelling', async () => {
    const { Category, table, schema, schemaName } = await openSelfFixtures(driver)
    const settingsName = table.replace('sr_categories_', 'sr_settings_')
    await schema.createTable(settingsName, (columns) => {
      columns.integer('id').primaryKey()
      columns.integer('category_id')
      columns.json('settings')
    })
    onTestFinished(() => schema.dropTable(settingsName))
    const settings = defineGeneratedTable(settingsName, { id: column.integer().primaryKey(), category_id: column.integer(), settings: column.json() })
    registerGeneratedTables({ settings })
    onTestFinished(() => clearGeneratedTables())
    await DB.table(settings).insert([{ id: 1, category_id: 2, settings: { theme: 'dark' } }])
    const constraint = (query: { whereExists(subquery: unknown): unknown }) => query.whereExists(DB.table(`${schemaName}.${settingsName}`)
      .where('settings', { theme: 'dark' })
      .whereColumn('category_id', '=', `${table}.id`))
    const filtered = await Category.whereHas('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const loaded = await Category.with('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    expect(expected).toEqual([1])
    expect(filtered.map(id)).toEqual(expected)
  })

  it('keeps same-named tables in different schemas apart', async () => {
    const { adapter, db, schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const name = `sr_tenants_${suffix}`
    const home = driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : mysqlTestConnection().database
    const audit = `sr_audit_${suffix}`
    const quote = (identifier: string) => driver === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`
    if (driver === 'sqlite') {
      await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS ${quote(audit)}`, source: 'schema' })
    }
    else {
      await adapter.execute(`${driver === 'postgres' ? 'CREATE SCHEMA' : 'CREATE DATABASE'} ${quote(audit)}`)
      onTestFinished(async () => {
        await adapter.execute(`${driver === 'postgres' ? 'DROP SCHEMA IF EXISTS' : 'DROP DATABASE IF EXISTS'} ${quote(audit)}${driver === 'postgres' ? ' CASCADE' : ''}`)
      })
    }
    await schema.createTable(`${home}.${name}`, (table) => {
      table.integer('id').primaryKey()
      table.integer('tenant_id')
    })
    onTestFinished(() => schema.dropTable(`${home}.${name}`))
    await schema.createTable(`${audit}.${name}`, (table) => {
      table.integer('id').primaryKey()
      table.integer('owner_id')
      table.integer('tenant_id')
    })
    const homeTable = defineGeneratedTable(`${home}.${name}`, { id: column.integer().primaryKey(), tenant_id: column.integer() })
    const auditTable = defineGeneratedTable(`${audit}.${name}`, { id: column.integer().primaryKey(), owner_id: column.integer(), tenant_id: column.integer() })
    await DB.table(homeTable).insert([{ id: 1, tenant_id: 1 }, { id: 2, tenant_id: 2 }])
    await DB.table(auditTable).insert([{ id: 10, owner_id: 1, tenant_id: 1 }, { id: 20, owner_id: 2, tenant_id: 9 }])
    const Audit = defineModel(auditTable, { name: `Audit${suffix}`, timestamps: false })
    const Home = defineModel(homeTable, { name: `Home${suffix}`, timestamps: false, relations: { audits: hasMany(() => Audit, 'owner_id') } })
    const BareHome = defineModel(defineGeneratedTable(name, { id: column.integer().primaryKey(), tenant_id: column.integer() }), { name: `BareHome${suffix}`, timestamps: false, relations: { audits: hasMany(() => Audit, 'owner_id') } })

    const sameTenant = await Home.whereHas('audits', query => query.whereColumn(`${audit}.${name}.tenant_id` as never, '=', `${home}.${name}.tenant_id`)).orderBy('id').get() as unknown as Category[]
    const bareSameTenant = await BareHome.whereHas('audits', query => query.whereColumn(`${audit}.${name}.tenant_id` as never, '=', `${name}.tenant_id`)).orderBy('id').get() as unknown as Category[]
    const scopedTenant = await BareHome.whereHas('audits', query => query.where(`${name}.tenant_id` as never, 9)).orderBy('id').get() as unknown as Category[]
    const has = await Home.has('audits').orderBy('id').get() as unknown as Category[]

    expect(has.map(id)).toEqual([1, 2])
    expect(sameTenant.map(id)).toEqual([1])
    expect(bareSameTenant.map(id)).toEqual([1, 2])
    expect(scopedTenant.map(id)).toEqual([2])
  })

  it('rewrites schema-qualified references next to a same-named table from another schema', async () => {
    const { QualifiedTree: Category, table, schemaName, adapter, db, schema } = await openSelfFixtures(driver)
    const audit = `sr_audit_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const quote = (identifier: string) => driver === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`
    if (driver === 'sqlite') {
      await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS ${quote(audit)}`, source: 'schema' })
    }
    else {
      await adapter.execute(`${driver === 'postgres' ? 'CREATE SCHEMA' : 'CREATE DATABASE'} ${quote(audit)}`)
      onTestFinished(async () => {
        await adapter.execute(`${driver === 'postgres' ? 'DROP SCHEMA IF EXISTS' : 'DROP DATABASE IF EXISTS'} ${quote(audit)}${driver === 'postgres' ? ' CASCADE' : ''}`)
      })
    }
    await schema.createTable(`${audit}.${table}`, (columns) => {
      columns.integer('id').primaryKey()
      columns.integer('owner_id')
    })
    await DB.table(defineGeneratedTable(`${audit}.${table}`, { id: column.integer().primaryKey(), owner_id: column.integer() })).insert([{ id: 1, owner_id: 2 }])
    const viaExists = (query: { whereExists(subquery: unknown): unknown }) => query.whereExists(DB.table(`${audit}.${table}`).whereColumn(`${audit}.${table}.owner_id`, '=', `${schemaName}.${table}.id`))

    const loaded = await Category.with('children', viaExists as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)
    const filtered = await Category.whereHas('children', viaExists as never).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(filtered.map(id)).toEqual(expected)
  })

  it('rewrites references in a union branch that does not list the table itself', async () => {
    const { Category, table } = await openSelfFixtures(driver)
    const postsTable = table.replace('sr_categories_', 'sr_posts_')
    const constraint = (query: { whereExists(subquery: unknown): unknown }) => query.whereExists(DB.table(table).select('id').where('id', -1)
      .unionAll(DB.table(postsTable).select('id').whereColumn(`${postsTable}.category_id`, '=', `${table}.id`).where('id', 3)))
    const loaded = await Category.with('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const filtered = await Category.whereHas('children', constraint as never).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(filtered.map(id)).toEqual(expected)
  })

  it('reads short and schema-qualified spellings of the related table from the related row when both models spell it alike', async () => {
    const { Category, QualifiedTree, table, schemaName } = await openSelfFixtures(driver)

    const shortOnQualified = await QualifiedTree.whereHas('children', query => query.where(`${table}.name` as never, 'branch')).orderBy('id').get() as unknown as Category[]
    const qualifiedOnShort = () => Category.whereHas('children', query => query.where(`${schemaName}.${table}.name`, 'branch'))

    expect(shortOnQualified.map(id)).toEqual([1])
    expect(qualifiedOnShort).toThrow(`Cannot tell whether "${schemaName}.${table}" names the table "${table}"`)
  })

  it('reads qualified pivot conditions from a pivot that is the parent table spelled with its schema', async () => {
    const { PivotParent } = await openSelfFixtures(driver)
    const loaded = await PivotParent.with('branchChildren').orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'branchChildren').length > 0).map(id)

    const has = await PivotParent.has('branchChildren').orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1])
    expect(has.map(id)).toEqual(expected)
  })

  it('rejects table aliases that use the reserved self-relation prefix', async () => {
    const { table } = await openSelfFixtures(driver)
    const grantsTable = table.replace('sr_categories_', 'sr_grants_')

    expect(() => DB.table(`${grantsTable} as holo_reserved_0`)).toThrow('Table alias "holo_reserved_0" is reserved')
    expect(() => DB.table(`${grantsTable} as HOLO_RESERVED_0`)).toThrow('Table alias "HOLO_RESERVED_0" is reserved')
    expect(() => DB.table(table).join(`${grantsTable} as holo_reserved_1`, 'holo_reserved_1.category_id', '=', `${table}.id`)).toThrow('is reserved')
    expect(() => DB.table(table).from(`${grantsTable} as Holo_Reserved_2`)).toThrow('is reserved')
    expect(() => DB.table(table).joinSub(DB.table(grantsTable), 'holo_reserved_3', 'holo_reserved_3.category_id', '=', `${table}.id`)).toThrow('is reserved')
  })

  it('keeps an ungrouped orWhere constraint inside the relation correlation', async () => {
    const { Category, table } = await openSelfFixtures(driver)
    const constraint = (query: { where(column: string, value: unknown): { orWhere(column: string, value: unknown): unknown } }) => query.where(`${table}.name`, 'leaf').orWhere(`${table}.name`, 'branch')
    const loaded = await Category.with('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const expected = loaded.filter(entity => related(entity, 'children').length > 0).map(id)

    const children = await Category.whereHas('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const posts = await Category.whereHas('posts', query => query.where('id', 1).orWhere('id', 3)).orderBy('id').get() as unknown as Category[]
    const grandchildren = await Category.whereHas('grandchildren', constraint as never).orderBy('id').get() as unknown as Category[]

    expect(expected).toEqual([1, 2])
    expect(children.map(id)).toEqual(expected)
    expect(posts.map(id)).toEqual([2, 3])
    expect(grandchildren.map(id)).toEqual([1])
  })

  it('correlates against a parent alias that reuses the related table name', async () => {
    const { Category, table } = await openSelfFixtures(driver)
    const postsTable = table.replace('sr_categories_', 'sr_posts_')

    const aliased = await Category.query().from(`${table} as ${postsTable}`).has('posts').get() as unknown as Category[]
    const upperCased = await Category.query().from(`${table} as ${postsTable.toUpperCase()}`).has('posts').get() as unknown as Category[]
    const constraintAliased = await Category.query().from(`${table} as ${postsTable}`).whereHas('posts', query => (query as unknown as { from(table: string): unknown }).from(`${postsTable} as ${postsTable}`) as never).get() as unknown as Category[]

    expect(aliased.map(id).sort((left, right) => left - right)).toEqual([1, 2, 3])
    expect(upperCased.map(id).sort((left, right) => left - right)).toEqual([1, 2, 3])
    expect(constraintAliased.map(id).sort((left, right) => left - right)).toEqual([1, 2, 3])
  })

  it('moves a constraint alias that hides the parent, ignoring case', async () => {
    const { Category, table } = await openSelfFixtures(driver)
    const postsTable = table.replace('sr_categories_', 'sr_posts_')
    const sorted = (entities: Category[]) => entities.map(id).sort((left, right) => left - right)
    const fromAlias = (alias: string) => (query: unknown) => (query as { from(source: string): unknown }).from(alias) as never

    const nonSelf = await Category.whereHas('posts', fromAlias(`${postsTable} as ${table}`)).get() as unknown as Category[]
    const parentAliased = await Category.query().from(`${table} as c`).whereHas('posts', fromAlias(`${postsTable} as c`)).get() as unknown as Category[]
    expect(sorted(nonSelf)).toEqual([1, 2, 3])
    expect(sorted(parentAliased)).toEqual([1, 2, 3])
    if (driver === 'sqlite') {
      const upperCased = await Category.whereHas('children', query => (query as unknown as { from(source: string): { where(column: string, value: unknown): unknown } }).from(`${table} as ${table}`).where(`${table.toUpperCase()}.id`, 2) as never).get() as unknown as Category[]
      expect(sorted(upperCased)).toEqual([1])
    }
  })

  it.skipIf(driver !== 'postgres')('keeps tables whose names differ only in case apart on PostgreSQL', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const lower = `sr_cased_${suffix}`
    const upper = `SR_Cased_${suffix}`
    await schema.createTable(upper, (table) => {
      table.integer('id').primaryKey()
      table.integer('tenant_id')
    })
    onTestFinished(() => schema.dropTable(upper))
    await schema.createTable(lower, (table) => {
      table.integer('id').primaryKey()
      table.integer('owner_id')
      table.integer('tenant_id')
    })
    onTestFinished(() => schema.dropTable(lower))
    const upperTable = defineGeneratedTable(upper, { id: column.integer().primaryKey(), tenant_id: column.integer() })
    const lowerTable = defineGeneratedTable(lower, { id: column.integer().primaryKey(), owner_id: column.integer(), tenant_id: column.integer() })
    await DB.table(upperTable).insert([{ id: 1, tenant_id: 1 }, { id: 2, tenant_id: 2 }])
    await DB.table(lowerTable).insert([{ id: 10, owner_id: 1, tenant_id: 1 }, { id: 20, owner_id: 2, tenant_id: 9 }])
    const Entry = defineModel(lowerTable, { name: `CasedEntry${suffix}`, timestamps: false })
    const Owner = defineModel(upperTable, { name: `CasedOwner${suffix}`, timestamps: false, relations: { entries: hasMany(() => Entry, 'owner_id') } })

    const sameTenant = await Owner.whereHas('entries', query => query.whereColumn(`${lower}.tenant_id` as never, '=', `${upper}.tenant_id`)).orderBy('id').get() as unknown as Category[]

    expect(sameTenant.map(id)).toEqual([1])
  })

  it.skipIf(driver !== 'postgres')('lets a nested query on a lowercase table refer back to a mixed-case self table on PostgreSQL', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const upper = `SR_Tree_${suffix}`
    const lower = `sr_tree_${suffix}`
    await schema.createTable(upper, (table) => {
      table.integer('id').primaryKey()
      table.integer('parent_id').nullable()
    })
    onTestFinished(() => schema.dropTable(upper))
    await schema.createTable(lower, (table) => {
      table.integer('id').primaryKey()
      table.integer('category_id')
    })
    onTestFinished(() => schema.dropTable(lower))
    const upperTable = defineGeneratedTable(upper, { id: column.integer().primaryKey(), parent_id: column.integer().nullable() })
    const lowerTable = defineGeneratedTable(lower, { id: column.integer().primaryKey(), category_id: column.integer() })
    await DB.table(upperTable).insert([{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }])
    await DB.table(lowerTable).insert([{ id: 10, category_id: 2 }])
    const Node = defineModel(upperTable, { name: `CasedNode${suffix}`, timestamps: false })
    const Tree = defineModel(upperTable, { name: `CasedTree${suffix}`, timestamps: false, relations: { children: hasMany(() => Node, 'parent_id') } })
    const constraint = (query: { whereExists(subquery: unknown): unknown }) => query.whereExists(DB.table(lower).whereColumn(`${lower}.category_id`, '=', `${upper}.id`))

    const loaded = await Tree.with('children', constraint as never).orderBy('id').get() as unknown as Category[]
    const filtered = await Tree.whereHas('children', constraint as never).orderBy('id').get() as unknown as Category[]

    expect(loaded.filter(entity => related(entity, 'children').length > 0).map(id)).toEqual([1])
    expect(filtered.map(id)).toEqual([1])
  })

  it('refuses schema-qualified references to a table that a nested query names without its schema', async () => {
    const { table, adapter, db, schema } = await openSelfFixtures(driver)
    const audit = `sr_audit_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const quote = (identifier: string) => driver === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`
    if (driver === 'sqlite') {
      await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS ${quote(audit)}`, source: 'schema' })
    }
    else {
      await adapter.execute(`${driver === 'postgres' ? 'CREATE SCHEMA' : 'CREATE DATABASE'} ${quote(audit)}`)
      onTestFinished(async () => {
        await adapter.execute(`${driver === 'postgres' ? 'DROP SCHEMA IF EXISTS' : 'DROP DATABASE IF EXISTS'} ${quote(audit)}${driver === 'postgres' ? ' CASCADE' : ''}`)
      })
    }
    await schema.createTable(`${audit}.${table}`, (columns) => {
      columns.integer('id').primaryKey()
      columns.integer('parent_id').nullable()
    })
    const auditTable = defineGeneratedTable(`${audit}.${table}`, { id: column.integer().primaryKey(), parent_id: column.integer().nullable() })
    await DB.table(auditTable).insert([{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: null }, { id: 4, parent_id: 3 }])
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const AuditLeaf = defineModel(auditTable, { name: `AuditLeaf${suffix}`, timestamps: false })
    const AuditTree = defineModel(auditTable, { name: `AuditTree${suffix}`, timestamps: false, relations: { children: hasMany(() => AuditLeaf, 'parent_id') } })
    const crossSchema = (query: { whereExists(subquery: unknown): unknown }) => query.whereExists(DB.table(table)
      .whereColumn(`${table}.id`, '=', `${audit}.${table}.id`)
      .where(`${table}.name`, 'branch'))

    expect(() => AuditTree.whereHas('children', crossSchema as never)).toThrow(`Cannot tell whether "${audit}.${table}" names the table "${table}"`)
  })
})
