import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { hydrateRecord } from '../src/model/ModelRepository'
import {
  ConfigurationError,
  DB,
  HydrationError,
  ModelNotFoundException,
  HasUuids,
  SecurityError,
  SchemaError,
  Entity,
  latestMorphOne,
  column,
  configureDB,
  createModelCollection,
  createModelRegistry,
  createSchemaService,
  createConnectionManager,
  createDatabase,
  createDialect as createDatabaseDialect,
  clearGeneratedTables,
  belongsTo,
  defineModel,
  hasOne,
  hasMany,
  morphMany,
  morphTo,
  morphToMany,
  morphedByMany,
  registerGeneratedTables,
  resetDB,
  uniqueSlug,
  type ModelCollection,
  type ModelQueryBuilder,
  type RelationMap,
  type TableDefinition } from '../src'
import { getGlobalModel } from '../src/model/ModelRegistry'
import { listMorphModels, registerMorphModel, resolveMorphModel, resolveMorphSelector } from '../src/model/morphRegistry'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'
import { openDatabase } from './support/database'

type Row = Record<string, unknown>
type TestEntity = Entity<TableDefinition>
type DynamicEntity = TestEntity & Record<string, unknown>

function asTestEntity(value: unknown): TestEntity {
  return value as TestEntity
}

function asDynamicEntity(value: unknown): DynamicEntity {
  return value as DynamicEntity
}

describe('model core slice', () => {
  beforeEach(() => {
    resetDB()
    clearGeneratedTables()
  })

  it('preserves the public defineModel(tableName, builder, options) authoring path', () => {
    const User = defineModel('users', table => table
      .id()
      .string('name')
      .timestamps(), {
      fillable: ['name'],
      timestamps: true,
    })

    expect(User.definition.table.tableName).toBe('users')
    expect(Object.keys(User.definition.table.columns)).toEqual(['id', 'name', 'created_at', 'updated_at'])
    expect(User.definition.fillable).toEqual(['name'])
    expect(User.definition.timestamps).toBe(true)
  })

  it('preserves the public defineModel(tableName, builder) authoring path without options', () => {
    const AuditLog = defineModel('audit_logs', table => table
      .id()
      .string('message'),
    )

    expect(AuditLog.definition.table.tableName).toBe('audit_logs')
    expect(Object.keys(AuditLog.definition.table.columns)).toEqual(['id', 'message'])
    expect(AuditLog.definition.name).toBe('AuditLog')
    expect(AuditLog.definition.createdAtColumn).toBeUndefined()
    expect(AuditLog.definition.updatedAtColumn).toBeUndefined()
  })

  it('supports the public defineModel(tableName, options) authoring path from generated schema', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp().defaultNow(),
      updated_at: column.timestamp().defaultNow(),
    })
    registerGeneratedTables({ users })

    const User = defineModel('users', {
      fillable: ['name'],
      timestamps: true,
    })

    expect(User.definition.table.tableName).toBe('users')
    expect(Object.keys(User.definition.table.columns)).toEqual(['id', 'name', 'created_at', 'updated_at'])
    expect(User.definition.fillable).toEqual(['name'])
    expect(User.definition.timestamps).toBe(true)
  })

  it('defers defineModel(tableName, options) generated schema lookups until the model is used', () => {
    const User = defineModel('users', {
      fillable: ['name'],
      timestamps: true,
    })

    expect(User.definition.name).toBe('User')
    expect(User.definition.fillable).toEqual(['name'])
    expect(() => User.getTableName()).toThrow(
      'Model "users" is not present in the generated schema registry. Run "holo migrate" to refresh the internal generated schema metadata.',
    )
  })

  it('allows repeated pending generated-schema model imports during dev startup', () => {
    const FirstUser = defineModel('users', {
      fillable: ['name'],
      timestamps: true,
    })
    const SecondUser = defineModel('users', {
      fillable: ['name'],
      timestamps: true,
    })

    expect(SecondUser.definition.name).toBe(FirstUser.definition.name)
    expect(() => SecondUser.getTableName()).toThrow(
      'Model "users" is not present in the generated schema registry. Run "holo migrate" to refresh the internal generated schema metadata.',
    )
  })

  it('supports the public defineModel(tableName) authoring path without options', () => {
    const auditLogs = defineTable('audit_logs', {
      id: column.id(),
      message: column.string(),
    })
    registerGeneratedTables({ auditLogs })

    const AuditLog = defineModel('audit_logs')

    expect(AuditLog.definition.table.tableName).toBe('audit_logs')
    expect(Object.keys(AuditLog.definition.table.columns)).toEqual(['id', 'message'])
    expect(AuditLog.definition.name).toBe('AuditLog')
    expect(AuditLog.definition.createdAtColumn).toBeUndefined()
    expect(AuditLog.definition.updatedAtColumn).toBeUndefined()
  })

  it('supports the public defineModel(tableDefinition, options) overload for internal/generated callers', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    const User = defineModel(users, {
      fillable: ['name'],
    })

    expect(User.definition.table).toBe(users)
    expect(User.definition.fillable).toEqual(['name'])
  })

  it('supports the public defineModel(tableDefinition) overload without options', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    const User = defineModel(users)

    expect(User.definition.table).toBe(users)
    expect(User.definition.name).toBe('User')
  })

  it('infers model names from regular, irregular, compound, and schema-qualified table names', () => {
    const people = defineTable('people', {
      id: column.id(),
    })
    const children = defineTable('children', {
      id: column.id(),
    })
    const blueLotOfThings = defineTable('blue_lot_of_things', {
      id: column.id(),
    })
    const auditLogs = defineTable('analytics.audit_logs', {
      id: column.id(),
    })

    expect(defineModel(people).definition.name).toBe('Person')
    expect(defineModel(children).definition.name).toBe('Child')
    expect(defineModel(blueLotOfThings).definition.name).toBe('BlueLotOfThing')
    expect(defineModel(auditLogs).definition.name).toBe('AuditLog')
  })

  it('uses irregular inferred model names anywhere model metadata is consumed', () => {
    const people = defineTable('people', {
      id: column.id(),
      name: column.string(),
    })
    const children = defineTable('children', {
      id: column.id(),
      person_id: column.foreignId(),
      name: column.string(),
    })

    const Person = defineModel(people)
    const Child = defineModel(children)

    expect(Person.definition.name).toBe('Person')
    expect(Person.definition.morphClass).toBe('Person')
    expect(Child.definition.name).toBe('Child')
    expect(Child.definition.morphClass).toBe('Child')
    expect(getGlobalModel('Person')).toBe(Person)
    expect(getGlobalModel('Child')).toBe(Child)
    expect(resolveMorphSelector('Person')).toBe(Person)
    expect(resolveMorphSelector('people')).toBe(Person)
    expect(resolveMorphSelector('Child')).toBe(Child)
    expect(resolveMorphSelector('children')).toBe(Child)
    expect(() => defineModel(people, {
      touches: ['children'],
    })).toThrow(
      'Touched relation "children" is not defined on model "Person".',
    )
    expect(() => defineModel(children, {
      touches: ['person'],
    })).toThrow(
      'Touched relation "person" is not defined on model "Child".',
    )
  })

  it('stores global relation registries on globalThis for bundled runtime module copies', () => {
    const people = defineTable('people', {
      id: column.id(),
      name: column.string(),
    })

    const Person = defineModel(people)
    const runtime = globalThis as typeof globalThis & {
      __holoDbGlobalModels__?: Map<string, NonNullable<ReturnType<typeof getGlobalModel>>>
      __holoDbMorphRegistry__?: Map<string, NonNullable<ReturnType<typeof resolveMorphModel>>>
    }

    expect(runtime.__holoDbGlobalModels__?.get('Person')).toBe(Person)
    expect(runtime.__holoDbMorphRegistry__?.get('Person')).toBe(Person)
    expect(listMorphModels()).toContain(Person)

    resetDB()
    runtime.__holoDbGlobalModels__?.set('Person', Person)
    runtime.__holoDbMorphRegistry__?.set('Person', Person)

    expect(getGlobalModel('Person')).toBe(Person)
    expect(resolveMorphModel('Person')).toBe(Person)
  })

  it('keeps standalone model registries isolated from the global relation registry', () => {
    const people = defineTable('people', {
      id: column.id(),
      name: column.string(),
    })
    const animals = defineTable('animals', {
      id: column.id(),
      name: column.string(),
    })

    const Person = defineModel(people)
    const Animal = defineModel(animals)
    const registry = createModelRegistry()

    expect(registry.has('Person')).toBe(false)
    expect(registry.register(Person)).toBe(Person.definition)
    expect(registry.register(Person.definition)).toBe(Person.definition)
    expect(registry.has('Person')).toBe(true)
    expect(registry.get('Person')).toBe(Person.definition)
    expect(registry.list()).toEqual([Person.definition])

    const conflictingPerson = Object.freeze({
      ...Animal.definition,
      name: 'Person',
      morphClass: 'Person',
    })
    expect(() => registry.register(conflictingPerson)).toThrow(
      'Model "Person" is already registered.',
    )

    const brokenPerson = Object.create(Person.definition, {
      table: {
        get() {
          throw new Error('broken table metadata')
        },
      },
    }) as typeof Person.definition
    expect(() => registry.register(brokenPerson)).toThrow('broken table metadata')

    registry.clear()
    expect(registry.list()).toEqual([])

    const missingTableRegistry = createModelRegistry()
    const missingGhost = Object.create(Person.definition, {
      name: { value: 'Ghost' },
      primaryKey: { value: 'id' },
      morphClass: { value: 'ghost' },
      table: {
        get() {
          throw new SchemaError('Model "ghosts" is not present in the generated schema registry.')
        },
      },
    }) as typeof Person.definition
    const conflictingGhost = Object.create(Person.definition, {
      name: { value: 'Ghost' },
      primaryKey: { value: 'id' },
      morphClass: { value: 'other-ghost' },
      table: {
        get() {
          throw new SchemaError('Model "ghosts" is not present in the generated schema registry.')
        },
      },
    }) as typeof Person.definition
    const matchingGhost = Object.create(Person.definition, {
      name: { value: 'Ghost' },
      primaryKey: { value: 'id' },
      morphClass: { value: 'ghost' },
      table: {
        get() {
          throw new SchemaError('Model "ghosts" is not present in the generated schema registry.')
        },
      },
    }) as typeof Person.definition
    const conflictingGhostKey = Object.create(Person.definition, {
      name: { value: 'Ghost' },
      primaryKey: { value: 'uuid' },
      morphClass: { value: 'ghost' },
      table: {
        get() {
          throw new SchemaError('Model "ghosts" is not present in the generated schema registry.')
        },
      },
    }) as typeof Person.definition

    expect(missingTableRegistry.register(missingGhost)).toBe(missingGhost)
    expect(missingTableRegistry.register(matchingGhost)).toBe(matchingGhost)
    expect(() => missingTableRegistry.register(conflictingGhostKey)).toThrow(
      'Model "Ghost" is already registered.',
    )
    expect(() => missingTableRegistry.register(conflictingGhost)).toThrow(
      'Model "Ghost" is already registered.',
    )
    const brokenGhostKey = Object.create(Person.definition, {
      name: { value: 'Ghost' },
      morphClass: { value: 'ghost' },
      primaryKey: {
        get() {
          throw new Error('broken primary key metadata')
        },
      },
      table: {
        get() {
          throw new SchemaError('Model "ghosts" is not present in the generated schema registry.')
        },
      },
    }) as typeof Person.definition
    expect(() => missingTableRegistry.register(brokenGhostKey)).toThrow('broken primary key metadata')
  })

  it('allows duplicate global registrations for the same model and rejects conflicting models', () => {
    const people = defineTable('people', {
      id: column.id(),
      name: column.string(),
    })
    const duplicatePeople = defineTable('people', {
      id: column.id(),
      name: column.string(),
    })
    const animals = defineTable('animals', {
      id: column.id(),
      name: column.string(),
    })

    const Person = defineModel(people)

    expect(defineModel(duplicatePeople, { name: 'Person' }).definition.name).toBe('Person')
    expect(getGlobalModel('Person')).toBe(Person)
    expect(() => defineModel(animals, { name: 'Person' })).toThrow(
      'Model "Person" is already registered globally.',
    )
  })

  it('compares pending generated-schema model metadata without resolving the table', () => {
    const Ghost = defineModel('ghosts', {
      name: 'Ghost',
      morphClass: 'ghost',
    })

    expect(defineModel('ghosts', {
      name: 'Ghost',
      morphClass: 'ghost',
    }).definition.name).toBe('Ghost')
    expect(() => defineModel('ghosts', {
      name: 'Ghost',
      morphClass: 'shadow',
    })).toThrow('Model "Ghost" is already registered globally.')
    expect(getGlobalModel('Ghost')).toBe(Ghost)
  })

  it('defers generated schema table resolution until the model is used', () => {
    const MissingUser = defineModel('missing_users')
    const Untimestamped = defineModel('untimestamped_records', { timestamps: false })

    expect(MissingUser.definition.name).toBe('MissingUser')
    expect(MissingUser.definition.morphClass).toBe('MissingUser')
    expect(() => MissingUser.getTableName()).toThrow(
      'Model "missing_users" is not present in the generated schema registry. Run "holo migrate" to refresh the internal generated schema metadata.',
    )
    expect(Untimestamped.definition.createdAtColumn).toBeUndefined()
    expect(Untimestamped.definition.updatedAtColumn).toBeUndefined()
    expect(() => Untimestamped.definition.uniqueIdConfig).toThrow('not present in the generated schema registry')
  })

  it('resolves deferred generated models from the configured runtime schema registry', () => {
    const admins = defineTable('admins', {
      id: column.id(),
      name: column.string(),
    })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter: createSQLiteAdapter({ filename: ':memory:' }),
          dialect: createDatabaseDialect('sqlite'),
        }),
      },
    }))
    DB.connection().getSchemaRegistry().replace(admins)

    const Admin = defineModel('admins')

    expect(Admin.getTableName()).toBe('admins')
    expect(Admin.definition.table.columns).toHaveProperty('name')
  })

  it('generates unique model slugs through the framework helper', async () => {
    const articles = defineTable('articles', {
      id: column.id(),
      title: column.string(),
      slug: column.string(),
      public_slug: column.string(),
    })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter: createSQLiteAdapter({ filename: ':memory:' }),
          dialect: createDatabaseDialect('sqlite'),
        }),
      },
    }))

    onTestFinished(() => DB.connection().disconnect())
    await createTestTable(DB.connection(), articles)

    const Article = defineModel(articles, {
      fillable: ['title', 'slug', 'public_slug'],
    })
    const existing = await Article.create({
      title: 'Existing',
      slug: 'hello-world',
      public_slug: 'public-entry',
    })

    await Article.create({
      title: 'Second',
      slug: 'hello-world-2',
      public_slug: 'other-entry',
    })

    await expect(uniqueSlug(Article, 'Hello World')).resolves.toBe('hello-world-3')
    await expect(uniqueSlug(Article, 'Hello World', { ignore: existing.id })).resolves.toBe('hello-world')
    await expect(uniqueSlug(Article, 'Public Entry', { column: 'public_slug' })).resolves.toBe('public-entry-2')
    await expect(uniqueSlug(Article, '!!!')).resolves.toBe('entry')
    await expect(uniqueSlug(Article, 'Hello World', { separator: '_' })).resolves.toBe('hello_world')
    await expect(Promise.all([
      uniqueSlug(Article, 'Concurrent Slug'),
      uniqueSlug(Article, 'Concurrent Slug'),
    ])).resolves.toEqual(['concurrent-slug', 'concurrent-slug-2'])
  })

  it('aligns default polymorphic relation columns with builder-generated morph columns', () => {
    const tags = defineTable('tags', { id: column.id() })
    const images = defineTable('images', {
      id: column.id(),
      imageable_type: column.string(),
      imageable_id: column.bigInteger(),
    }, {
      indexes: [{ columns: ['imageable_type', 'imageable_id'], unique: false }],
    })
    const posts = defineTable('posts', { id: column.id() })
    const users = defineTable('users', { id: column.id() })
    const activities = defineTable('activities', {
      id: column.id(),
      subject_type: column.string(),
      subject_id: column.bigInteger(),
    }, {
      indexes: [{ columns: ['subject_type', 'subject_id'], unique: false }],
    })
    registerGeneratedTables({ tags, images, posts, users, activities })

    const Tag = defineModel('tags')
    const Image = defineModel('images')
    const Post = defineModel('posts', {
      relations: {
        image: latestMorphOne(() => Image, 'imageable'),
        tags: morphToMany(() => Tag, 'taggable', 'taggables', 'tag_id'),
      },
    })
    const User = defineModel('users', {
      relations: {
        images: morphMany(() => Image, 'imageable'),
        tags: morphedByMany(() => Tag, 'taggable', 'taggables', 'tag_id'),
      },
    })
    const Activity = defineModel('activities', {
      relations: {
        subject: morphTo('subject'),
      },
    })

    expect(Image.definition.table.columns).toHaveProperty('imageable_type')
    expect(Image.definition.table.columns).toHaveProperty('imageable_id')
    expect(Activity.definition.relations.subject).toMatchObject({
      morphTypeColumn: 'subject_type',
      morphIdColumn: 'subject_id',
    })
    expect(User.definition.relations.images).toMatchObject({
      morphTypeColumn: 'imageable_type',
      morphIdColumn: 'imageable_id',
    })
    expect(Post.definition.relations.image).toMatchObject({
      morphTypeColumn: 'imageable_type',
      morphIdColumn: 'imageable_id',
    })
    expect(Post.definition.relations.tags).toMatchObject({
      morphTypeColumn: 'taggable_type',
      morphIdColumn: 'taggable_id',
    })
    expect(User.definition.relations.tags).toMatchObject({
      morphTypeColumn: 'taggable_type',
      morphIdColumn: 'taggable_id',
    })
  })

  it('applies model scopes and repository queries to persisted rows', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, connectionName: 'default', dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.string('email')
      table.string('status')
      table.string('nickname').nullable()
    })
    const users = defineTable('users', {
      id: column.id(), name: column.string(), email: column.string(), status: column.string(), nickname: column.string().nullable(),
    })
    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'],
      guarded: ['id'],
      globalScopes: { activeOnly: (query: ModelQueryBuilder<typeof users>) => query.where('status', 'active') },
      scopes: {
        active: (query: ModelQueryBuilder<typeof users>) => query.where('status', 'active'),
        named: (query: ModelQueryBuilder<typeof users>, value: string) => query.where('name', value),
      },
    })
    await User.create({ name: 'Mohamed', email: 'm@example.com', status: 'active' })
    await User.create({ name: 'Amina', email: 'a@example.com', status: 'inactive' })
    const names = async (query: ModelQueryBuilder<typeof users>) => (await query.orderBy('id').get()).map(user => user.get('name'))
    for (const query of [User.query(), User.newQuery(), User.newModelQuery(), User.newQueryWithoutRelationships(), User.active()]) {
      expect(await names(query)).toEqual(['Mohamed'])
    }
    for (const query of [
      User.newQueryWithoutScopes(), User.newQuery().withoutGlobalScope('activeOnly'), User.withoutGlobalScope('activeOnly'),
      User.newQuery().withoutGlobalScopes(), User.withoutGlobalScopes(),
      User.newQuery().withoutGlobalScopes(['activeOnly']), User.withoutGlobalScopes(['activeOnly']),
    ]) expect(await names(query)).toEqual(['Mohamed', 'Amina'])
    expect(await User.named('Amina').first()).toBeUndefined()
    expect((await User.withoutGlobalScope('activeOnly').where('name', 'Amina').firstOrFail()).get('email')).toBe('a@example.com')
    expect(await User.query().select('id').orderBy('id', 'desc').offset(0).limit(1).pluck('id')).toEqual([1])
    expect((await User.all()).map(user => user.get('name'))).toEqual(['Mohamed'])
    expect((await User.find(1))?.get('name')).toBe('Mohamed')
    expect(await User.findMany([])).toEqual([])
    expect((await User.findMany([1, 2])).map(user => user.get('name'))).toEqual(['Mohamed'])
    expect((await User.findOrFail(1)).get('name')).toBe('Mohamed')
    expect((await User.firstOrFail()).get('name')).toBe('Mohamed')
    expect((await User.sole()).get('name')).toBe('Mohamed')
    expect((await User.firstWhere('name', 'Mohamed'))?.get('email')).toBe('m@example.com')
    expect(await User.valueOrFail('name')).toBe('Mohamed')
    expect(await User.soleValue('name')).toBe('Mohamed')
    expect(await User.valueOrFail('nickname')).toBeNull()
    expect(await User.soleValue('nickname')).toBeNull()
    await expect(User.query().findOrFail('Ghost', 'name')).rejects.toThrow('User record not found for key "Ghost" via "name".')
    await expect(User.findOrFail(999)).rejects.toThrow(ModelNotFoundException)
    await expect(User.where('name', 'Nobody').sole()).rejects.toThrow('User query expected exactly one result but found 0.')
    await expect(User.where('name', 'Nobody').valueOrFail('name')).rejects.toThrow('User query returned no value for column "name".')
    for (const query of [User.query().withTrashed(), User.query().onlyTrashed(), User.query().withoutTrashed()]) {
      expect(await names(query)).toEqual(['Mohamed'])
    }
    const repo = DB.connection().model(User)
    expect((await repo.firstOrFail()).get('name')).toBe('Mohamed')
    await User.create({ name: 'Extra', email: 'e@example.com', status: 'active' })
    await expect(User.sole()).rejects.toThrow('User query expected exactly one result but found 2.')
  })

  it('filters persisted models by column comparisons, sets, and ranges', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.string('status')
      table.integer('minScore')
      table.integer('maxScore')
    })
    const User = defineModel('users', { fillable: ['name', 'status', 'minScore', 'maxScore'] })
    await User.createMany([
      { name: 'Mohamed', status: 'active', minScore: 1, maxScore: 2 },
      { name: 'Amina', status: 'active', minScore: 3, maxScore: 2 },
      { name: 'Layla', status: 'active', minScore: 1, maxScore: 2 },
      { name: 'Nada', status: 'inactive', minScore: 1, maxScore: 2 },
    ])
    expect(await User.distinct().whereIn('status', ['active']).whereNotIn('name', ['Layla'])
      .whereBetween('id', [1, 3]).whereNotBetween('id', [4, 8])
      .whereColumn('minScore', '<=', 'maxScore').pluck('name')).toEqual(['Mohamed'])
    expect(await User.distinct().orderBy('status').pluck('status')).toEqual(['active', 'inactive'])
  })

  it('supports conditional, ordering, date, JSON, and subquery helpers on native model queries', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, connectionName: 'default', dialect: createDatabaseDialect('sqlite'), security: { allowUnsafeRawSql: true } })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const schema = createSchemaService(db)
    await schema.createTable('users', table => {
      table.id()
      table.string('name')
      table.string('status')
      table.json('settings')
      table.timestamp('created_at')
    })
    await schema.createTable('posts', table => {
      table.id()
      table.integer('userId')
      table.string('title')
    })
    const User = defineModel('users', { fillable: ['name', 'status', 'settings', 'created_at'] })
    const Post = defineModel('posts', { fillable: ['userId', 'title'] })
    await User.create({ name: 'Mohamed', status: 'active', settings: { profile: { region: 'eu' }, tags: ['beta', 'web'] }, created_at: new Date('2024-01-02T00:00:00Z') })
    await User.create({ name: 'Amina', status: 'inactive', settings: { profile: { region: 'mena' }, tags: [] }, created_at: new Date('2024-01-01T00:00:00Z') })
    await Post.create({ userId: 1, title: 'Hello' })
    expect(await User.when(true, query => query.where('status', 'active')).latest().pluck('name')).toEqual(['Mohamed'])
    expect(await User.unless(true, query => query.where('status', 'active'), query => query.where('status', 'inactive')).oldest().pluck('name')).toEqual(['Amina'])
    expect(await User.unless(false, query => query.where('status', 'active')).pluck('name')).toEqual(['Mohamed'])
    expect(await User.latest().pluck('name')).toEqual(['Mohamed', 'Amina'])
    expect(await User.oldest().pluck('name')).toEqual(['Amina', 'Mohamed'])
    expect(await User.inRandomOrder().pluck('name')).toEqual(expect.arrayContaining(['Mohamed', 'Amina']))
    expect(await User.latest().reorder('name', 'asc').pluck('name')).toEqual(['Amina', 'Mohamed'])
    expect(await User.whereExists(Post.query().select('id').whereColumn('posts.userId', '=', 'users.id')).pluck('name')).toEqual(['Mohamed'])
    expect(await User.whereSub('id', 'in', Post.query().select('userId').where('title', 'like', 'Hello%')).pluck('name')).toEqual(['Mohamed'])
    expect(await User.whereAny(['name', 'status'], 'like', 'Mo%').pluck('name')).toEqual(['Mohamed'])
    expect(await User.whereAll(['name', 'status'], 'like', '%a%').orderBy('id').pluck('name')).toEqual(['Mohamed', 'Amina'])
    expect(await User.whereNone(['name', 'status'], 'like', 'Mo%').pluck('name')).toEqual(['Amina'])
    expect(await User.whereDate('created_at', '2024-01-02').whereMonth('created_at', 1).whereDay('created_at', 2).whereYear('created_at', 2024).whereTime('created_at', '00:00:00').pluck('name')).toEqual(['Mohamed'])
    expect(await User.whereJson('settings->profile->region', 'eu').whereJsonContains('settings->tags', 'beta').whereJsonLength('settings->tags', '>=', 2).pluck('name')).toEqual(['Mohamed'])
    expect(await User.unsafeWhere('"name" = ?1', ['Mohamed']).unsafeOrderBy('"name" DESC', []).pluck('name')).toEqual(['Mohamed'])
    await DB.transaction(async () => {
      expect(await User.lockForUpdate().pluck('name')).toEqual(['Mohamed', 'Amina'])
      expect(await User.sharedLock().pluck('name')).toEqual(['Mohamed', 'Amina'])
    })
  })

  it('aggregates native nullable model columns and retrieves scalar values', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, connectionName: 'default', dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.integer('score').nullable()
    })
    const User = defineModel('users', { fillable: ['name', 'score'] })
    await User.createMany([{ name: 'Mohamed', score: 10 }, { name: 'Amina', score: 20 }, { name: 'Salma', score: null }])
    expect(await User.count()).toBe(3)
    expect(await User.exists()).toBe(true)
    expect(await User.doesntExist()).toBe(false)
    expect(await User.orderBy('id').pluck('name')).toEqual(['Mohamed', 'Amina', 'Salma'])
    expect(await User.where('id', 1).value('name')).toBe('Mohamed')
    expect(await User.sum('score')).toBe(30)
    expect(await User.avg('score')).toBe(15)
    expect(await User.min('score')).toBe(10)
    expect(await User.max('score')).toBe(20)
    await expect(User.sum('name')).rejects.toThrow('requires numeric values')
    const nulls = User.whereNull('score')
    expect(await nulls.sum('score')).toBe(0)
    expect(await nulls.avg('score')).toBeNull()
    expect(await nulls.min('score')).toBeNull()
    expect(await nulls.max('score')).toBeNull()
    await User.query().delete()
    expect(await User.count()).toBe(0)
    expect(await User.exists()).toBe(false)
    expect(await User.doesntExist()).toBe(true)
    expect(await User.pluck('name')).toEqual([])
    expect(await User.value('name')).toBeUndefined()
    expect(await User.sum('score')).toBe(0)
    expect(await User.avg('score')).toBeNull()
    expect(await User.min('score')).toBeNull()
    expect(await User.max('score')).toBeNull()
  })

  it('exposes redacted debug helpers on model queries and statics', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createSQLiteAdapter({ filename: ':memory:' }),
          dialect: createDatabaseDialect('sqlite'),
          security: {
            redactBindingsInLogs: true } } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const User = defineModelFromTable(users)

    const debug = User.where('name', 'Mohamed').debug()
    expect(debug.sql).toBe('SELECT * FROM "users" WHERE "name" = ?')
    expect(debug.bindings).toEqual(['[REDACTED]'])
    expect(User.debug().bindings).toEqual([])
    expect(User.debug().sql).toBe('SELECT * FROM "users"')
  })

  it('persists nested JSON updates and rejects unwritable roots', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.json('settings')
    })
    const users = defineTable('users', { id: column.id(), name: column.string(), settings: column.json<{ profile: { region: string }, tags: string[] }>() })
    const User = defineModelFromTable(users, { fillable: ['settings'], guarded: ['id'] })
    await db.table(users).insert({ name: 'Mohamed', settings: { profile: { region: 'old' }, tags: ['retained'] } })
    expect((await User.where('id', 1).updateJson('settings->profile->region', 'eu')).affectedRows).toBe(1)
    expect((await User.findOrFail(1)).get('settings')).toEqual({ profile: { region: 'eu' }, tags: ['retained'] })
    await User.where('id', 1).updateJson('settings->profile->region', 'mena')
    expect((await User.findOrFail(1)).get('settings')).toEqual({ profile: { region: 'mena' }, tags: ['retained'] })
    await expect(User.where('id', 1).updateJson('name->profile', 'eu')).rejects.toThrow(SecurityError)
    const LockedUser = defineModelFromTable(users, { fillable: ['name'] })
    await expect(LockedUser.where('id', 1).updateJson('settings->profile->region', 'eu')).rejects.toThrow(SecurityError)
    expect((await User.findOrFail(1)).get('settings')).toEqual({ profile: { region: 'mena' }, tags: ['retained'] })
    expect((await User.findOrFail(1)).get('name')).toBe('Mohamed')
  })

  it('increments and decrements persisted models with extra writable attributes', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.integer('score')
      table.boolean('active')
    })
    const User = defineModel('users', { fillable: ['name', 'score', 'active'] })
    await User.createMany([
      { name: 'Mohamed', score: 10, active: true },
      { name: 'Amina', score: 20, active: true },
      { name: 'Layla', score: 30, active: false },
    ])
    expect((await User.where('active', true).increment('score', 5, { name: 'Boosted' })).affectedRows).toBe(2)
    expect((await User.orderBy('id').get()).toJSON()).toEqual([
      { id: 1, name: 'Boosted', score: 15, active: true },
      { id: 2, name: 'Boosted', score: 25, active: true },
      { id: 3, name: 'Layla', score: 30, active: false },
    ])
    expect((await User.decrement('score', 3, { name: 'Lowered' })).affectedRows).toBe(3)
    expect((await User.orderBy('id').get()).toJSON()).toEqual([
      { id: 1, name: 'Lowered', score: 12, active: true },
      { id: 2, name: 'Lowered', score: 22, active: true },
      { id: 3, name: 'Lowered', score: 27, active: false },
    ])
    await expect(User.increment('score', Number.NaN)).rejects.toThrow('valid number')
    expect(await User.orderBy('id').pluck('score')).toEqual([12, 22, 27])
    await adapter.execute('UPDATE users SET score = ? WHERE id = ?', ['ten', 1])
    await expect(User.increment('score', 1)).rejects.toThrow('non-numeric column')
    expect((await adapter.query('SELECT score FROM users WHERE id = 1')).rows).toEqual([{ score: 'ten' }])
  })

  it('upserts persisted models using a real unique constraint', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('email').unique()
      table.string('name')
    })
    const User = defineModel('users', { fillable: ['email', 'name'] })
    await User.query().upsert({ email: 'm@example.com', name: 'Mohamed' }, ['email'], ['name'])
    const id = (await User.firstOrFail()).get('id')
    await User.query().upsert({ email: 'm@example.com', name: 'Updated' }, ['email'], ['name'])
    expect((await User.sole()).toJSON()).toEqual({ id, email: 'm@example.com', name: 'Updated' })
    await User.query().upsert([
      { email: 'm@example.com', name: 'Batch update' },
      { email: 'a@example.com', name: 'Amina' },
    ], ['email'], ['name'])
    expect(await User.orderBy('email').pluck('name')).toEqual(['Amina', 'Batch update'])
    await User.query().upsert({ email: 'm@example.com', name: 'Ignored' }, ['email'])
    expect((await User.findOrFail(id)).get('name')).toBe('Batch update')
    await expect(User.create({ email: 'm@example.com', name: 'Duplicate' })).rejects.toThrow(/unique/i)
    expect(await User.count()).toBe(2)
  })

  it('paginates and chunks persisted models including duplicate and nullable sort keys', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string() })
    const User = defineModelFromTable(users, {
      fillable: ['name', 'email'] })

    const sqlite = createSQLiteAdapter({ filename: ':memory:' })
    await sqlite.initialize()
    onTestFinished(() => sqlite.disconnect())
    await sqlite.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)')
    await sqlite.execute("INSERT INTO users VALUES (1, 'Mohamed', 'm@example.com'), (2, 'Amina', 'a@example.com'), (3, 'Salma', 's@example.com'), (4, 'Youssef', 'y@example.com'), (5, 'Nada', 'n@example.com')")
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter: sqlite, dialect: createDatabaseDialect('sqlite') } } }))

    expect(await User.query().orderBy('id').forPage(2, 2).pluck('name')).toEqual(['Salma', 'Youssef'])
    expect(await User.query().orderBy('id').skip(1).take(2).pluck('name')).toEqual(['Amina', 'Salma'])

    const paginated = await User.query().orderBy('id').paginate(2, 2)
    expect(paginated.data.map(user => user.get('name'))).toEqual(['Salma', 'Youssef'])
    expect(paginated.meta).toEqual({
      total: 5,
      perPage: 2,
      pageName: 'page',
      currentPage: 2,
      lastPage: 3,
      from: 3,
      to: 4,
      hasMorePages: true })
    expect(paginated.items()).toEqual(paginated.data)
    expect(paginated.firstItem()).toBe(3)
    expect(paginated.lastItem()).toBe(4)
    expect(paginated.hasPages()).toBe(true)
    expect(paginated.getPageName()).toBe('page')

    const paginatedJson = await User.query().orderBy('id').paginateJson(2, 2)
    expect(paginatedJson).toEqual({
      data: [
        { id: 3, name: 'Salma', email: 's@example.com' },
        { id: 4, name: 'Youssef', email: 'y@example.com' },
      ],
      meta: {
        total: 5,
        perPage: 2,
        pageName: 'page',
        currentPage: 2,
        lastPage: 3,
        from: 3,
        to: 4,
        hasMorePages: true,
      },
    })
    expect(await User.with([]).orderBy('id').pluck('id')).toEqual([1, 2, 3, 4, 5])
    await expect(User.with(['missing' as never]).get()).rejects.toThrow(/relation/i)
    await expect(User.findOrFailJson(1)).resolves.toMatchObject({ id: 1 })
    await expect(User.firstJson()).resolves.toMatchObject({ id: 1 })
    await expect(User.soleJson()).rejects.toThrow('expected exactly one result')
    await expect(User.paginateJson(2, 1)).resolves.toMatchObject({ meta: { currentPage: 1 } })
    await expect(User.simplePaginateJson(2, 1)).resolves.toMatchObject({ meta: { currentPage: 1 } })
    await expect(User.cursorPaginateJson(2)).resolves.toMatchObject({ cursorName: 'cursor' })
    await expect(User.paginate(1, 0)).rejects.toThrow('Page must be a positive integer')
    await expect(User.paginateJson(0, 1)).rejects.toThrow('Per-page value must be a positive integer')
    await expect(User.paginateJson(1, 0)).rejects.toThrow('Page must be a positive integer')
    await expect(User.paginateJson(1, 1, { pageName: ' ' })).rejects.toThrow('parameter name')
    await expect(User.simplePaginate(0, 1)).rejects.toThrow('Per-page value must be a positive integer')
    await expect(User.simplePaginate(1, 1, { pageName: ' ' })).rejects.toThrow('parameter name')
    await expect(User.simplePaginateJson(0, 1)).rejects.toThrow('Per-page value must be a positive integer')
    await expect(User.simplePaginateJson(1, 0)).rejects.toThrow('Page must be a positive integer')
    await expect(User.simplePaginateJson(1, 1, { pageName: ' ' })).rejects.toThrow('parameter name')
    await expect(User.cursorPaginate(0)).rejects.toThrow('Per-page value must be a positive integer')
    await expect(User.cursorPaginateJson(0)).rejects.toThrow('Per-page value must be a positive integer')
    await expect(User.cursorPaginateJson(1, null, { cursorName: ' ' })).rejects.toThrow('parameter name')
    await expect(User.cursorPaginateJson(1, 'invalid')).rejects.toThrow('Cursor is malformed')
    await expect(User.unsafeOrderBy('"id" ASC', []).cursorPaginate()).rejects.toThrow(
      'Cursor pagination requires column orderBy clauses',
    )
    await expect(User.chunkByIdDesc(0, async () => {})).rejects.toThrow('Chunk size must be a positive integer')
    await expect(User.query().where('id', 999).soleJson()).rejects.toThrow(
      'User query expected exactly one result but found 0.',
    )
    await expect(User.query().where('id', '>', 0).soleJson()).rejects.toThrow(
      'User query expected exactly one result but found 2.',
    )
    await expect(User.query().where('id', 1).soleJson()).resolves.toEqual({
      id: 1,
      name: 'Mohamed',
      email: 'm@example.com',
    })

    const emptyPage = await User.query().orderBy('id').paginate(2, 4)
    expect(emptyPage.meta.from).toBeNull()
    expect(emptyPage.meta.to).toBeNull()

    const simple = await User.simplePaginate(2, 3)
    expect(simple.data.map(user => user.get('name'))).toEqual(['Nada'])
    expect(simple.meta.hasMorePages).toBe(false)
    expect(simple.items()).toEqual(simple.data)
    expect(simple.getPageName()).toBe('page')

    const firstSimple = await User.simplePaginate(2, 1)
    expect(firstSimple.data.map(user => user.get('name'))).toEqual(['Mohamed', 'Amina'])
    expect(firstSimple.meta.hasMorePages).toBe(true)

    const simpleJson = await User.query().orderBy('id').simplePaginateJson(2, 1)
    expect(simpleJson).toEqual({
      data: [
        { id: 1, name: 'Mohamed', email: 'm@example.com' },
        { id: 2, name: 'Amina', email: 'a@example.com' },
      ],
      meta: {
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        from: 1,
        to: 2,
        hasMorePages: true,
      },
    })

    const emptySimple = await User.simplePaginate(2, 4)
    expect(emptySimple.meta.from).toBeNull()
    expect(emptySimple.meta.to).toBeNull()

    const firstCursorPage = await User.query().orderBy('id').cursorPaginate(2)
    expect(firstCursorPage.data.map(user => user.get('name'))).toEqual(['Mohamed', 'Amina'])
    expect(firstCursorPage.cursorName).toBe('cursor')
    expect(firstCursorPage.nextCursor).toBeTruthy()
    expect(firstCursorPage.prevCursor).toBeNull()
    expect(firstCursorPage.items()).toEqual(firstCursorPage.data)
    expect(firstCursorPage.hasMorePages()).toBe(true)
    expect(firstCursorPage.getCursorName()).toBe('cursor')

    const lastCursorPage = await User.query().orderBy('id').cursorPaginate(10)
    expect(lastCursorPage.nextCursor).toBeNull()

    const customPaginated = await User.paginate(2, 1, { pageName: 'usersPage' })
    expect(customPaginated.meta.pageName).toBe('usersPage')
    const customSimple = await User.simplePaginate(2, 1, { pageName: 'usersPage' })
    expect(customSimple.meta.pageName).toBe('usersPage')
    const customCursor = await User.cursorPaginate(2, null, { cursorName: 'usersCursor' })
    expect(customCursor.cursorName).toBe('usersCursor')

    const chunked: string[][] = []
    await User.chunk(2, (rows) => {
      chunked.push(rows.map(user => user.get('name')))
    })
    expect(chunked).toEqual([['Mohamed', 'Amina'], ['Salma', 'Youssef'], ['Nada']])

    const chunkedById: string[][] = []
    await User.query().chunkById(2, (rows, page) => {
      chunkedById.push(rows.map(user => user.get('name')))
      return page < 2
    })
    expect(chunkedById).toEqual([['Mohamed', 'Amina'], ['Salma', 'Youssef']])

    const stoppedChunks: string[][] = []
    await User.chunk(2, (rows, page) => {
      stoppedChunks.push(rows.map(user => user.get('name')))
      return page < 2
    })
    expect(stoppedChunks).toEqual([['Mohamed', 'Amina'], ['Salma', 'Youssef']])

    await sqlite.execute('CREATE TABLE edge_users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, rank INTEGER)')
    const edgeUsers = defineTable('edge_users', {
      id: column.id(),
      name: column.string(),
      rank: column.integer().nullable() })
    const EdgeUser = defineModelFromTable(edgeUsers)
    await sqlite.execute("INSERT INTO edge_users VALUES (1, 'Equal A', 1), (2, 'Null', NULL), (3, 'Equal B', 1), (4, 'Other Null', NULL), (5, 'Two', 2)")

    const sortedEdgeChunks: string[][] = []
    await EdgeUser.query().chunkById(2, (rows) => {
      sortedEdgeChunks.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(sortedEdgeChunks).toEqual([['Null', 'Other Null'], ['Equal A', 'Equal B'], ['Two']])

    await sqlite.execute('DELETE FROM edge_users')
    await sqlite.execute("INSERT INTO edge_users VALUES (10, 'Two', 2), (11, 'One', 1)")
    const descendingInputSorted: string[][] = []
    await EdgeUser.query().chunkById(10, (rows) => {
      descendingInputSorted.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(descendingInputSorted).toEqual([['One', 'Two']])

    await sqlite.execute('DELETE FROM edge_users')
    await sqlite.execute("INSERT INTO edge_users VALUES (1, 'Equal A', 1), (2, 'Null', NULL), (3, 'Equal B', 1), (4, 'Other Null', NULL), (5, 'Two', 2)")
    const descendingChunks: string[][] = []
    await EdgeUser.query().chunkByIdDesc(10, (rows) => {
      descendingChunks.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(descendingChunks).toEqual([['Two', 'Equal A', 'Equal B', 'Null', 'Other Null']])

    const stoppedDescendingChunks: string[][] = []
    await EdgeUser.chunkByIdDesc(1, (rows, page) => {
      stoppedDescendingChunks.push(rows.map(user => user.get('name')))
      return page < 2
    }, 'rank')
    expect(stoppedDescendingChunks).toEqual([['Two'], ['Equal A']])

    await sqlite.execute('DELETE FROM edge_users')
    await sqlite.execute("INSERT INTO edge_users VALUES (20, 'Equal A', 1), (21, 'Equal B', 1), (22, 'Null', NULL), (23, 'Other Null', NULL)")
    const descendingBranchCoverage: string[][] = []
    await EdgeUser.query().chunkByIdDesc(10, (rows) => {
      descendingBranchCoverage.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(descendingBranchCoverage).toEqual([['Equal A', 'Equal B', 'Null', 'Other Null']])

    const collection = await User.query().orderBy('id').get()
    expect(collection.modelKeys()).toEqual([1, 2, 3, 4, 5])
    expect(await collection.toQuery().orderBy('id').pluck('id')).toEqual([1, 2, 3, 4, 5])
    expect(collection.makeHidden('email')[0]?.toJSON()).toEqual({
      id: 1,
      name: 'Mohamed' })
    const visibleCollection = await User.query().orderBy('id').get()
    expect(visibleCollection.makeVisible('email')[0]?.toJSON()).toMatchObject({
      email: 'm@example.com' })
    const visibleOnlyCollection = await User.query().orderBy('id').get()
    expect(visibleOnlyCollection.setVisible(['name']).withoutAppends()[0]?.toJSON()).toEqual({
      name: 'Mohamed' })
    const hiddenCollection = await User.query().orderBy('id').get()
    expect(hiddenCollection.setHidden(['email'])[0]?.toJSON()).toEqual({
      id: 1,
      name: 'Mohamed' })
    expect((await collection.fresh()).modelKeys()).toEqual([1, 2, 3, 4, 5])
  })

  it('persists first-or-create and batch helpers against real constraints', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.string('email').unique()
      table.string('status')
    })

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'] })

    const firstUnsaved = await User.firstOrNew({ email: 'm@example.com' }, { name: 'Mohamed' })
    expect(firstUnsaved.exists()).toBe(false)
    expect(firstUnsaved.get('email')).toBe('m@example.com')

    const firstCreated = await User.firstOrCreate({ email: 'm@example.com' }, { name: 'Mohamed', status: 'active' })
    expect(firstCreated.exists()).toBe(true)
    expect(firstCreated.get('id')).toBe(1)

    const firstExistingUnsaved = await User.getRepository().firstOrNew({ email: 'm@example.com' }, { name: 'Override' })
    expect(firstExistingUnsaved.exists()).toBe(true)
    expect(firstExistingUnsaved.get('name')).toBe('Mohamed')

    const firstExisting = await User.firstOrCreate({ email: 'm@example.com' }, { name: 'Changed' })
    expect(firstExisting.get('name')).toBe('Mohamed')

    const createdMany = await User.createMany([
      { name: 'Amina', email: 'a@example.com', status: 'active' },
      { name: 'Salma', email: 's@example.com', status: 'inactive' },
    ])
    expect(createdMany.map(user => user.get('id'))).toEqual([2, 3])

    const repo = User.getRepository()
    const pending = [
      User.make({ name: 'Youssef', email: 'y@example.com', status: 'active' }),
      User.make({ name: 'Nada', email: 'n@example.com', status: 'inactive' }),
    ]
    const savedMany = await repo.saveMany(pending)
    expect(savedMany.map(user => user.get('id'))).toEqual([4, 5])
    expect(savedMany.every(user => user.exists())).toBe(true)

    const staticSaved = await User.saveMany([
      User.make({ name: 'Omar', email: 'o@example.com', status: 'active' }),
    ])
    expect(staticSaved.map(user => user.get('id'))).toEqual([6])
    expect(await User.destroy([1, 999, 2])).toBe(2)
    expect(await User.orderBy('id').pluck('id')).toEqual([3, 4, 5, 6])
  })

  it('returns one persisted model across concurrent first-or-create calls', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.string('email').unique()
    })
    const User = defineModel('users', { fillable: ['name', 'email'] })
    const users = await Promise.all(Array.from({ length: 16 }, (_, index) => User.firstOrCreate(
      { email: 'race@example.com' }, { name: `Caller ${index}` },
    )))
    const persisted = (await User.sole()).toJSON()
    expect(users.map(user => user.toJSON())).toEqual(Array.from({ length: 16 }, () => persisted))
    expect(persisted).toMatchObject({ id: 1, email: 'race@example.com' })
    await expect(User.create({ name: 'Duplicate', email: 'race@example.com' })).rejects.toThrow(/unique/i)
    expect(await User.count()).toBe(1)
  })

  it('preserves real not-null and unresolved unique failures in first-or-create', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id()
      table.string('name')
      table.string('email').unique()
      table.string('status')
    })
    const User = defineModel('users', { fillable: ['name', 'email', 'status'] })
    await expect(User.firstOrCreate({ email: 'failure@example.com' })).rejects.toThrow(/not null/i)
    expect(await User.count()).toBe(0)
    await User.create({ name: 'Inactive', email: 'unique@example.com', status: 'inactive' })
    const ActiveUser = defineModel('users', {
      name: 'ActiveUser', fillable: ['name', 'email', 'status'],
      globalScopes: { active: query => query.where('status', 'active') },
    })
    await expect(ActiveUser.firstOrCreate({ email: 'unique@example.com' }, { name: 'Active', status: 'active' })).rejects.toThrow(/unique/i)
    expect((await User.sole()).toJSON()).toMatchObject({ name: 'Inactive', status: 'inactive' })
  })

  it('supports custom collections per model', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Mohamed', email: 'm@example.com' },
        { id: 2, name: 'Amina', email: 'a@example.com' },
      ])

    const User = defineModelFromTable(users, {
      collection<TItem extends Entity<typeof users>>(items: readonly TItem[]) {
        const collection = createModelCollection<typeof users, RelationMap, TItem>(items) as ModelCollection<typeof users, RelationMap, TItem> & {
          emails(): string[]
        }

        Object.defineProperty(collection, 'emails', {
          value: () => collection.map(user => String(user.get('email'))),
          enumerable: false,
          configurable: true })

        return collection
      } })

    const collection = await User.all() as ModelCollection<typeof users> & { emails(): string[] }
    expect(collection.emails()).toEqual(['m@example.com', 'a@example.com'])
    expect(collection.modelKeys()).toEqual([1, 2])
  })

  it('handles empty and unsupported model collection edge cases safely', async () => {
    const empty = createModelCollection([])

    expect(empty.modelKeys()).toEqual([])
    expect(() => empty.toQuery()).toThrow('Cannot create a query from an empty model collection.')
    await expect(empty.load('posts')).resolves.toBe(empty)
    await expect(empty.loadMissing('posts')).resolves.toBe(empty)
    await expect(empty.loadMorph('imageable', {})).resolves.toBe(empty)
    await expect(empty.loadCount('posts')).resolves.toBe(empty)
    await expect(empty.loadExists('posts')).resolves.toBe(empty)
    await expect(empty.loadSum('posts', 'id')).resolves.toBe(empty)
    await expect(empty.loadAvg('posts', 'id')).resolves.toBe(empty)
    await expect(empty.loadMin('posts', 'id')).resolves.toBe(empty)
    await expect(empty.loadMax('posts', 'id')).resolves.toBe(empty)
    expect((await empty.fresh()).modelKeys()).toEqual([])
    expect(empty.append('label')).toBe(empty)
    expect(empty.withoutAppends()).toBe(empty)
    expect(empty.makeVisible('name')).toBe(empty)
    expect(empty.makeHidden('name')).toBe(empty)
    expect(empty.setVisible(['name'])).toBe(empty)
    expect(empty.setHidden(['name'])).toBe(empty)

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const unsupportedEntity = new Entity({
      definition: {
        primaryKey: 'id',
        table: users } } as never, {
      id: 1,
      name: 'Mohamed' }, true)

    const unsupportedCollection = createModelCollection([unsupportedEntity])
    await expect(unsupportedCollection.loadMorph('imageable', { User: 'posts' })).rejects.toThrow(
      'The bound repository cannot load morph relations.',
    )

    const refreshableEntity = new Entity({
      definition: {
        primaryKey: 'id',
        table: users },
      async freshEntity(entity: Entity<TableDefinition>) {
        return new Entity(this as never, entity.toAttributes(), true)
      } } as never, {
      id: 2,
      name: 'Amina' }, true)

    const refreshableCollection = createModelCollection([refreshableEntity])
    expect(refreshableCollection.append('label')).toBe(refreshableCollection)
    expect((await refreshableCollection.fresh()).modelKeys()).toEqual([2])
  })

  it('refreshes model collections without serializing independent entity loads', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const started: number[] = []
    let releaseFresh!: () => void
    const freshGate = new Promise<void>((resolve) => {
      releaseFresh = resolve
    })

    const collection = createModelCollection([
      new Entity({
        definition: {
          primaryKey: 'id',
          table: users },
        async freshEntity(entity: Entity<TableDefinition>) {
          started.push(entity.get('id') as number)
          await freshGate
          return new Entity(this as never, entity.toAttributes(), true)
        } } as never, {
        id: 1,
        name: 'Mohamed' }, true),
      new Entity({
        definition: {
          primaryKey: 'id',
          table: users },
        async freshEntity(entity: Entity<TableDefinition>) {
          started.push(entity.get('id') as number)
          await freshGate
          return new Entity(this as never, entity.toAttributes(), true)
        } } as never, {
        id: 2,
        name: 'Amina' }, true),
      new Entity({
        definition: {
          primaryKey: 'id',
          table: users },
        async freshEntity(entity: Entity<TableDefinition>) {
          started.push(entity.get('id') as number)
          await freshGate
          return new Entity(this as never, entity.toAttributes(), true)
        } } as never, {
        id: 3,
        name: 'Salma' }, true),
    ])

    const pending = collection.fresh()
    await Promise.resolve()
    expect(started).toEqual([1, 2, 3])
    releaseFresh()
    expect((await pending).modelKeys()).toEqual([1, 2, 3])
  })

  it('treats empty whereNot and orWhereNot callbacks as no-ops', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    const User = defineModelFromTable(users, {})

    const base = User.query()
    expect(base.where(() => {}).toSQL()).toEqual(base.toSQL())
    expect(base.orWhere(() => {}).toSQL()).toEqual(base.toSQL())
    expect(base.whereNot(() => {}).toSQL()).toEqual(base.toSQL())
    expect(base.orWhereNot(() => {}).toSQL()).toEqual(base.toSQL())
  })

  it('supports array-form model upserts and relation date serialization', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      email: column.string().nullable().unique(),
      name: column.string(),
      seenAt: column.timestamp().nullable() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Mohamed' },
      ])
    const User = defineModelFromTable(users, {
      fillable: ['email', 'name', 'seenAt'],
      serializeDate: value => `date:${value.toISOString()}` })

    await User.query().upsert([
      { email: 'm@example.com', name: 'Updated' } as never,
      { email: 'a@example.com', name: 'Created' } as never,
    ], ['email'], ['name'])


    const user = await User.findOrFail(1)
    user.setRelation('lastSeenAt', new Date('2025-01-02T03:04:05.000Z') as never)
    expect(user.toJSON()).toMatchObject({
      lastSeenAt: 'date:2025-01-02T03:04:05.000Z' })
  })

  it('rejects nested JSON updates on non-JSON model columns', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    const User = defineModelFromTable(users, {
      fillable: ['name'] })

    await expect(User.query().update({ 'name->first': 'Mo' } as never)).rejects.toThrow(
      'Column "name" must be a JSON column to support nested JSON updates.',
    )
  })

  it('supports model pruning and mass pruning', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Mohamed', status: 'active' },
        { id: 2, name: 'Amina', status: 'inactive' },
        { id: 3, name: 'Salma', status: 'inactive' },
      ])
    const logs = defineTable('logs', {
      id: column.id(),
      level: column.string() })
    await createTestTable(db, logs)
    await db.table(logs).insert([
        { id: 1, level: 'info' },
        { id: 2, level: 'debug' },
        { id: 3, level: 'debug' },
      ])

    const deletedCalls: string[] = []
    const User = defineModelFromTable(users, {
      events: {
        deleted: [entity => deletedCalls.push(String(asTestEntity(entity).get('name')))] },
      prunable(query: ModelQueryBuilder<typeof users>) {
        return query.where('status', 'inactive')
      } })

    const Log = defineModelFromTable(logs, {
      massPrunable: true,
      prunable(query: ModelQueryBuilder<typeof logs>) {
        return query.where('level', 'debug')
      } })

    expect(await User.prune()).toBe(2)
    expect(deletedCalls).toEqual(['Amina', 'Salma'])
    expect((await db.table(users).get())!).toEqual([
      { id: 1, name: 'Mohamed', status: 'active' },
    ])

    expect(await Log.prune()).toBe(2)
    expect((await db.table(logs).get())!).toEqual([
      { id: 1, level: 'info' },
    ])
  })

  it('prunes already soft-deleted records permanently', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const logs = defineTable('logs', {
      id: column.id(),
      level: column.string(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, logs)
    await db.table(logs).insert([
        { id: 1, level: 'debug', deleted_at: new Date('2025-01-01T00:00:00.000Z') },
      ])

    const Log = defineModelFromTable(logs, {
      fillable: ['level', 'deleted_at'],
      softDeletes: true,
      prunable: query => query.where('level', 'debug'),
      serializeDate: value => `date:${value.toISOString()}` })

    expect(await Log.prune()).toBe(1)

    expect(await db.table(logs).count()).toBe(0)
  })

  it('mass prunes the complete query when no pruning constraint is supplied', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const logs = defineTable('logs', { id: column.id(), level: column.string() })
    await createTestTable(db, logs)
    await db.table(logs).insert([{ id: 1, level: 'debug' }, { id: 2, level: 'info' }])
    const Log = defineModelFromTable(logs, { massPrunable: true, prunable: () => undefined })
    expect(await Log.prune()).toBe(2)
    expect(await db.table(logs).count()).toBe(0)
    expect(await Log.prune()).toBe(0)
  })

  it('rejects prune calls when a model does not define a prunable query', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)

    const User = defineModelFromTable(users)
    await expect(User.prune()).rejects.toThrow('Model "User" does not define a prunable query.')
  })

  it('rejects malformed pagination inputs on model queries', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    const User = defineModelFromTable(users)

    await expect(User.paginate(0, 1)).rejects.toThrow('Per-page value must be a positive integer.')
    await expect(User.simplePaginate(1, 0)).rejects.toThrow('Page must be a positive integer.')
    await expect(User.cursorPaginate(2, 'broken')).rejects.toThrow('Cursor is malformed.')
    await expect(User.paginate(1, 1, { pageName: '' })).rejects.toThrow('Page parameter name must be a non-empty string.')
    await expect(User.cursorPaginate(1, null, { cursorName: '' })).rejects.toThrow('Cursor parameter name must be a non-empty string.')
    await expect(User.inRandomOrder().cursorPaginate(1)).rejects.toThrow('Cursor pagination cannot use random ordering.')
    const malformedCursor = Buffer.from(JSON.stringify({ offset: 'bad' }), 'utf8').toString('base64url')
    await expect(User.cursorPaginate(2, malformedCursor)).rejects.toThrow('Cursor is malformed.')
    await expect(User.chunk(0, () => undefined)).rejects.toThrow('Chunk size must be a positive integer.')
    await expect(User.chunkById(0, () => undefined)).rejects.toThrow('Chunk size must be a positive integer.')
  })

  it('supports explicit unsafe raw model-builder APIs with policy enforcement', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    const User = defineModelFromTable(users)

    await expect(
      User.unsafeWhere('"name" = ?1', ['Mohamed']).unsafeOrderBy('"name" DESC', []).get(),
    ).rejects.toThrow(
      'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().',
    )

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDatabaseDialect('sqlite'),
          security: { allowUnsafeRawSql: true } }) } }))

    const AllowedUser = defineModelFromTable(users)
    const result = await AllowedUser
      .unsafeWhere('"name" = ?1', ['Mohamed'])
      .unsafeOrderBy('"name" DESC', [])
      .get()
    expect(result.map(user => user.get('name'))).toEqual(['Mohamed'])

    const orResult = await AllowedUser
      .unsafeWhere('"name" = ?1', ['Nope'])
      .orUnsafeWhere('"name" = ?1', ['Mohamed'])
      .get()
    expect(orResult.map(user => user.get('name'))).toEqual(['Mohamed'])

    const staticOrResult = await AllowedUser
      .orUnsafeWhere('"name" = ?1', ['Mohamed'])
      .get()
    expect(staticOrResult.map(user => user.get('name'))).toEqual(['Mohamed'])

    await expect(AllowedUser.unsafeWhere('', []).get()).rejects.toThrow('Raw predicate SQL must be a non-empty string.')
    await expect(AllowedUser.unsafeOrderBy('"name" DESC', [undefined] as never).get()).rejects.toThrow('Raw ORDER BY bindings cannot contain undefined values.')
    await expect(AllowedUser.unsafeWhere('"name" = ?2', ['Mohamed', 'Amina']).get()).rejects.toThrow(
      'Raw predicate SQL must use contiguous numbered placeholders starting at 1.',
    )
  })

  it('supports connection overrides and async transaction rebinding for model statics', async () => {
    const defaultAdapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => defaultAdapter.disconnect())
    const analyticsAdapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => analyticsAdapter.disconnect())

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter: defaultAdapter,
          dialect: createDatabaseDialect('sqlite') }),
        analytics: createDatabase({
          connectionName: 'analytics',
          adapter: analyticsAdapter,
          dialect: createDatabaseDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(DB.connection('default'), users)
    await DB.connection('default').table(users).insert([{ id: 1, name: 'Default', email: 'd@example.com', status: 'active' }])
    await createTestTable(DB.connection('analytics'), users)
    await DB.connection('analytics').table(users).insert([{ id: 7, name: 'Analytics', email: 'a@example.com', status: 'active' }])

    const User = defineModelFromTable(users)
    const AnalyticsUser = defineModelFromTable(users, { connectionName: 'analytics' })
    const MissingUser = defineModelFromTable(users, { connectionName: 'missing' })

    expect((await User.find(1))?.get('name')).toBe('Default')
    expect((await AnalyticsUser.find(7))?.get('name')).toBe('Analytics')
    expect(() => MissingUser.getRepository()).toThrow(ConfigurationError)

    await DB.transaction(async (tx) => {
      expect(User.query().getConnection()).toBe(tx)
      expect(AnalyticsUser.query().getConnection()).not.toBe(tx)
      expect(AnalyticsUser.query().getConnectionName()).toBe('analytics')
    })
  })

  it('does not depend on DB configuration import order for table and model definitions', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer(),
      bio: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Profile = defineModelFromTable(profiles, {
      relations: {
        user: belongsTo(() => User, 'userId') } })
    User = defineModelFromTable(users, {
      relations: {
        profile: hasOne(() => Profile, 'userId') } })

    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    await createTestTable(db, profiles)
    await db.table(profiles).insert([{ id: 10, userId: 1, bio: 'Engineer' }])

    const user = await User.query().with('profile').findOrFail(1)
    expect(user.get('name')).toBe('Mohamed')
    expect(user.getRelation<Entity<TableDefinition>>('profile')?.get('bio')).toBe('Engineer')

    const profile = await Profile.query().with('user').findOrFail(10)
    expect(profile.getRelation<Entity<TableDefinition>>('user')?.get('name')).toBe('Mohamed')
  })

  it('binds repositories and entities created inside a transaction to the transaction context', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' }])

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'] })

    await DB.transaction(async (tx) => {
      const repository = User.getRepository()
      expect(repository.getConnection()).toBe(tx)
      expect(repository.getConnection().getScope()).toMatchObject({ kind: 'transaction', depth: 1 })

      const existing = await User.findOrFail(1)
      expect(existing.getRepository().getConnection()).toBe(tx)

      const collection = await User.get()
      expect(collection[0]?.getRepository().getConnection()).toBe(tx)

      const created = await User.create({
        name: 'Amina',
        email: 'a@example.com',
        status: 'active' })
      expect(created.getRepository().getConnection()).toBe(tx)

      created.set('status', 'inactive')
      await created.save()

      expect((await db.table('users').get())).toEqual([
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
        { id: 2, name: 'Amina', email: 'a@example.com', status: 'inactive' },
      ])
    })
  })

  it('reuses the active transaction for model writes inside DB.transaction', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

    await createTestTable(db, users)
    await db.table(users).insert({ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'] })

    await DB.transaction(async () => {
      await User.create({ name: 'Amina', email: 'a@example.com', status: 'active' })

      const existing = await User.findOrFail(1)
      existing.set('status', 'inactive')
      await existing.save()

      const doomed = await User.findOrFail(1)
      await doomed.delete()
    })

    expect(await db.table(users).get()).toEqual([
      { id: 2, name: 'Amina', email: 'a@example.com', status: 'active' },
    ])
  })

  it('runs model full-text searches on PostgreSQL', async () => {
    const { db, table } = await openDatabase('postgres')
    await db.table(table).insert([
      { id: 1, name: 'Database framework', active: true },
      { id: 2, name: 'Frontend application', active: false },
    ])
    const Record = defineModelFromTable(table)
    expect(await Record.whereFullText('name', 'framework').pluck('id')).toEqual([1])
    expect(await Record.whereFullText('name', 'absent').pluck('id')).toEqual([])
    expect(await Record.where('active', false).orWhereFullText('name', 'framework').orderBy('id').pluck('id')).toEqual([1, 2])
  })

  it('runs model vector similarity queries on PostgreSQL with pgvector', async () => {
    const { db, table, schema } = await openDatabase('postgres')
    await db.executeCompiled({ sql: 'CREATE EXTENSION IF NOT EXISTS vector', source: 'schema' })
    await schema.table(table.tableName, table => { table.vector('embedding', { dimensions: 3 }).nullable() })
    const documents = defineTable(table.tableName, { ...table.columns, embedding: column.vector({ dimensions: 3 }).nullable() })
    schema.register(documents)
    const Document = defineModelFromTable(documents)
    await db.table(table.tableName).insert([
      { id: 1, name: 'Nearest', active: true, embedding: [1, 0, 0] },
      { id: 2, name: 'Orthogonal', active: true, embedding: [0, 1, 0] },
      { id: 3, name: 'Opposite', active: true, embedding: [-1, 0, 0] },
    ])
    expect(await Document.whereVectorSimilarTo('embedding', [1, 0, 0], 0.9).pluck('name')).toEqual(['Nearest'])
    expect(await Document.whereVectorSimilarTo('embedding', [0, 1, 0], 0.9).pluck('name')).toEqual(['Orthogonal'])
  })

  it('enforces fillable and guarded rules during create and update flows', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string().nullable() })
    await createTestTable(db, users)

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email'],
      guarded: ['status'] })
    const OpenUser = defineModelFromTable(users, { guarded: [] })
    const WildcardUser = defineModelFromTable(users, {
      fillable: ['*'],
      guarded: ['status'] })
    const ExplicitlyEmptyUser = defineModelFromTable(users, {
      fillable: [] })
    const LockedUser = defineModelFromTable(users, {
      guarded: ['*'] })

    const created = await User.create({ name: 'Sara', email: 's@example.com' })
    expect(created.toJSON()).toEqual({ id: 1, name: 'Sara', email: 's@example.com' })
    await expect(User.query().orderBy('id').getJson()).resolves.toEqual([
      { id: 1, name: 'Sara', email: 's@example.com', status: null },
    ])
    await expect(User.query().where('id', 1).firstJson()).resolves.toEqual({
      id: 1,
      name: 'Sara',
      email: 's@example.com', status: null,
    })
    await expect(User.getJson()).resolves.toEqual([
      { id: 1, name: 'Sara', email: 's@example.com', status: null },
    ])
    expect((await OpenUser.create({ name: 'Open', email: 'o@example.com', status: 'active' })).get('id')).toBe(2)
    expect((await WildcardUser.create({ name: 'Wild', email: 'w@example.com' })).get('id')).toBe(3)

    await expect(User.create({ id: 99, name: 'Nope' } as never)).rejects.toThrow(
      'Column "id" is generated and cannot be written directly.',
    )
    await expect(User.create({ status: 'active' } as never)).rejects.toThrow(
      'Column "status" is not writable on model "User".',
    )
    await expect(User.query().where('id', 1).update({ status: 'inactive' } as never)).rejects.toThrow(
      'Column "status" is not writable on model "User".',
    )
    await expect(ExplicitlyEmptyUser.create({ name: 'Blocked' } as never)).rejects.toThrow(
      'Column "name" is not writable on model "User".',
    )
    await expect(ExplicitlyEmptyUser.query().where('id', 1).update({ email: 'blocked@example.com' } as never)).rejects.toThrow(
      'Column "email" is not writable on model "User".',
    )
    await expect(User.create({ nickname: 'ghost' } as never)).rejects.toThrow(
      'Column "nickname" is not defined on model "User".',
    )
    await expect(User.create({ name: undefined } as never)).rejects.toThrow(
      'Create value for column "name" cannot be undefined.',
    )
    await expect(User.query().where('id', 1).update({ email: undefined } as never)).rejects.toThrow(
      'Update value for column "email" cannot be undefined.',
    )
    await expect(LockedUser.create({ name: 'No access' } as never)).rejects.toThrow(
      'Column "name" is not writable on model "User".',
    )
  })

  it('supports forceFill and scoped unguarded writes for controlled scenarios', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(db, users)

    const User = defineModelFromTable(users, {
      fillable: ['name'],
      guarded: ['status'] })

    const draft = User.make({ name: 'Base' })
    draft.forceFill({ email: 'forced@example.com', status: 'queued' } as never)
    expect(draft.get('email')).toBe('forced@example.com')
    expect(draft.get('status')).toBe('queued')

    await expect(User.create({ email: 'blocked@example.com' } as never)).rejects.toThrow(
      'Column "email" is not writable on model "User".',
    )

    const created = await User.unguarded(() => User.create({
      name: 'Unguarded',
      email: 'open@example.com',
      status: 'active' } as never))

    expect(created.get('id')).toBe(1)
    expect(created.get('email')).toBe('open@example.com')
    expect(created.get('status')).toBe('active')

    await expect(User.create({ email: 'blocked-again@example.com' } as never)).rejects.toThrow(
      'Column "email" is not writable on model "User".',
    )

    await User.unguarded(async () => {
      await expect(User.create({ email: undefined } as never)).rejects.toThrow(
        'Create value for column "email" cannot be undefined.',
      )
    })
  })

  it('tracks entity dirtiness and delegates save and delete operations through the repository', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    let writes = 0
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite'), logger: { onQuerySuccess: event => { if (event.kind === 'execute') writes += 1 } } })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(db, users)

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'] })

    const user = User.make({ name: 'Zein', email: 'z@example.com', status: 'active' })
    expect(user.getRepository().definition).toBe(User.definition)
    expect(user.exists()).toBe(false)
    expect(user.trashed()).toBe(false)
    expect(user.isDirty()).toBe(true)
    expect(user.isClean()).toBe(false)
    expect(user.wasChanged()).toBe(true)
    expect(user.getChanges()).toEqual({ name: 'Zein', email: 'z@example.com', status: 'active' })
    expect(User.make().exists()).toBe(false)
    user.fill({ status: 'active' })
    user.syncOriginal()
    expect(user.isClean()).toBe(true)
    expect(user.wasChanged()).toBe(true)
    user.set('status', 'active')

    await user.save()
    expect(user.exists()).toBe(true)
    expect(user.get('id')).toBe(1)
    expect(user.isClean()).toBe(true)
    expect(user.wasChanged()).toBe(false)
    expect(user.wasChanged('name')).toBe(false)
    expect(user.getChanges()).toEqual({})
    expect((await user.fresh())?.get('status')).toBe('active')

    user.set('status', 'inactive')
    expect(user.isDirty('status')).toBe(true)
    expect(user.getDirty()).toEqual({ status: 'inactive' })
    user.syncChanges()
    expect(user.getChanges()).toEqual({ status: 'inactive' })

    await user.save()

    expect(user.wasChanged('status')).toBe(true)
    expect(user.getChanges()).toEqual({ status: 'inactive' })

    await user.update({ status: 'active' })

    expect(user.get('status')).toBe('active')
    expect(user.isClean()).toBe(true)
    expect(user.wasChanged('status')).toBe(true)
    expect(user.getChanges()).toEqual({ status: 'active' })

    const executionCount = writes
    await user.save()
    expect(writes).toBe(executionCount)
    expect(user.getChanges()).toEqual({})

    await db.table(users).where('id', 1).update({ status: 'server-updated' })
    await user.refresh()
    expect(user.get('status')).toBe('server-updated')
    expect(user.wasChanged()).toBe(false)

    await user.delete()
    expect(user.exists()).toBe(false)
    await expect(user.delete()).rejects.toThrow('Cannot delete an entity that has not been persisted yet.')

    const repo = User.getRepository()
    const brokenDelete = hydrateRecord(repo, { name: 'Ghost', email: 'g@example.com', status: 'active' })
    await expect(repo.deleteEntity(brokenDelete)).rejects.toThrow('Cannot delete User without a primary key value.')

    const orphan = new Entity({ definition: User.definition, getConnection: () => DB.connection() } as never, { id: 9 }, true)
    expect(orphan.trashed()).toBe(false)
    await expect(orphan.save()).rejects.toThrow('The bound repository cannot persist entities.')
    await expect(orphan.delete()).rejects.toThrow('The bound repository cannot delete entities.')
    await expect(orphan.fresh()).rejects.toThrow('The bound repository cannot refresh entities.')
    await expect(orphan.refresh()).rejects.toThrow('The bound repository cannot refresh entities.')
    await expect(User.make().refresh()).rejects.toThrow('Cannot refresh an entity that has not been persisted yet.')
    expect(await User.make().fresh()).toBeUndefined()
    await expect(User.getRepository().refreshEntity(User.make())).rejects.toThrow(
      'Cannot refresh User without a persisted primary key value.',
    )

    const softDeletes = defineTable('soft_users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, softDeletes)
    const SoftUser = defineModelFromTable(softDeletes, {
      fillable: ['name'],
      softDeletes: true })
    const softRepo = SoftUser.getRepository()
    const softEntity = hydrateRecord(softRepo, { id: 1, name: 'Soft', deleted_at: '2025-01-01T00:00:00.000Z' as never })
    await expect(softRepo.freshEntity(softEntity)).resolves.toBeUndefined()
  })

  it('supports soft deletes, trashed scopes, and restore flows', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Alive', deleted_at: null },
        { id: 2, name: 'Gone', deleted_at: new Date('2025-01-01T00:00:00.000Z') },
      ])

    const User = defineModelFromTable(users, {
      fillable: ['name'],
      softDeletes: true,
      casts: {
        deleted_at: 'date' } })

    expect((await User.get()).map(user => user.get('name'))).toEqual(['Alive'])
    expect((await User.withTrashed().get()).map(user => user.get('name'))).toEqual(['Alive', 'Gone'])
    expect((await User.onlyTrashed().get()).map(user => user.get('name'))).toEqual(['Gone'])
    expect((await User.withTrashed().whereNotNull('deleted_at').firstOrFail()).get('name')).toBe('Gone')
    await expect(User.withTrashed().whereNotNull('deleted_at').where('name', 'Missing').firstOrFail()).rejects.toThrow(
      'User not found.',
    )
    await expect(User.withTrashed().whereNull('deleted_at').findOrFail(999)).rejects.toThrow(
      'User record not found for key "999" via "id".',
    )
    await expect(User.restore(999)).rejects.toThrow('User record not found for key "999".')

    const alive = await User.findOrFail(1)
    expect(alive.trashed()).toBe(false)
    await alive.delete()
    expect(alive.exists()).toBe(true)
    expect(alive.trashed()).toBe(true)
    expect(alive.get('deleted_at')).toBeInstanceOf(Date)
    expect(await User.find(1)).toBeUndefined()
    expect((await User.withTrashed().findOrFail(1)).get('name')).toBe('Alive')

    await alive.restore()
    expect(alive.trashed()).toBe(false)
    expect(alive.get('deleted_at')).toBeNull()
    expect((await User.findOrFail(1)).get('name')).toBe('Alive')

    expect(await User.onlyTrashed().restore()).toBe(1)
    expect((await User.findOrFail(2)).get('name')).toBe('Gone')
    expect(User.onlyTrashed().withTrashed().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
    expect((await User.withTrashed().withoutTrashed().get()).map(user => user.get('name'))).toEqual(['Alive', 'Gone'])

    const gone = await User.findOrFail(2)
    await gone.delete()
    const restored = await User.restore(2)
    expect(restored.get('deleted_at')).toBeNull()
    expect((await User.findOrFail(2)).get('name')).toBe('Gone')
    expect(await User.onlyTrashed().restore()).toBe(0)
  })

  it('supports force-delete flows across model statics, entities, and query builders', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Already Trashed', deleted_at: new Date('2025-01-01T00:00:00.000Z') },
        { id: 2, name: 'Entity Victim', deleted_at: null },
        { id: 3, name: 'Builder Victim', deleted_at: null },
      ])

    const User = defineModelFromTable(users, {
      fillable: ['name'],
      softDeletes: true })

    await User.forceDelete(1)
    expect(await User.withTrashed().find(1)).toBeUndefined()

    const entityVictim = await User.findOrFail(2)
    await entityVictim.forceDelete()
    expect(entityVictim.exists()).toBe(false)
    expect(await User.withTrashed().find(2)).toBeUndefined()

    const builderVictim = await User.findOrFail(3)
    await builderVictim.delete()
    expect(await User.onlyTrashed().where('id', 3).forceDelete()).toBe(1)
    expect(await User.withTrashed().find(3)).toBeUndefined()

    await expect(User.forceDelete(999)).rejects.toThrow('User record not found for key "999".')
    await expect(User.make({ name: 'Temp' }).forceDelete()).rejects.toThrow(
      'Cannot force-delete an entity that has not been persisted yet.',
    )
    const orphan = new Entity({} as never, { id: 9 }, true)
    await expect(orphan.forceDelete()).rejects.toThrow('The bound repository cannot force-delete entities.')
  })

  it('replicates entities with default exclusions and custom replication exclusions', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const posts = defineTable('posts', {
      id: column.id(),
      publicId: column.uuid().unique(),
      name: column.string(),
      token: column.string().nullable(),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, posts)
    await db.table(posts).insert([{
        id: 1,
        publicId: 'public-old',
        name: 'Original',
        token: 'secret',
        created_at: new Date('2025-01-01T00:00:00.000Z'),
        updated_at: new Date('2025-01-02T00:00:00.000Z'),
        deleted_at: null }])

    const Post = defineModelFromTable(posts, {
      traits: [HasUuids({ columns: ['publicId'] })],
      fillable: ['name', 'token'],
      softDeletes: true,
      replicationExcludes: ['token'] })

    const original = await Post.findOrFail(1)
    const clone = original.replicate()
    const stripped = original.replicate(['name'])

    expect(clone.exists()).toBe(false)
    expect(clone.toAttributes()).toEqual({
      name: 'Original' })
    expect(stripped.toAttributes()).toEqual({})

    await clone.save()
    expect(clone.exists()).toBe(true)
    expect(clone.get('id')).toBe(2)
    expect(clone.get('publicId')).not.toBe('public-old')



    const notes = defineTable('notes', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, notes)
    const Note = defineModelFromTable(notes, {
      fillable: ['name'] })
    const noteClone = Note.getRepository().replicateEntity(hydrateRecord(Note.getRepository(), { id: 9, name: 'Note' }))
    expect(noteClone.toAttributes()).toEqual({ name: 'Note' })
  })

  it('supports convention-based, custom, and disabled timestamps', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp(),
      updated_at: column.timestamp() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Mohamed', created_at: new Date('2025-01-01T00:00:00.000Z'), updated_at: new Date('2025-01-01T00:00:00.000Z') },
      ])
    const auditPosts = defineTable('audit_posts', {
      id: column.id(),
      name: column.string(),
      insertedOn: column.timestamp(),
      refreshedOn: column.timestamp() })
    await createTestTable(db, auditPosts)
    const notes = defineTable('notes', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp().nullable(),
      updated_at: column.timestamp().nullable() })
    await createTestTable(db, notes)

    const User = defineModelFromTable(users, {
      fillable: ['name'] })
    const AuditPost = defineModelFromTable(auditPosts, {
      fillable: ['name'],
      createdAtColumn: 'insertedOn',
      updatedAtColumn: 'refreshedOn' })
    const Note = defineModelFromTable(notes, {
      fillable: ['name'],
      timestamps: false })

    const created = await User.create({ name: 'Amina' })
    expect(created.get('created_at')).toBeInstanceOf(Date)
    expect(created.get('updated_at')).toBeInstanceOf(Date)

    created.set('name', 'Amina 2')
    await created.save()



    const custom = await AuditPost.create({ name: 'Audit' })
    expect(custom.get('insertedOn')).toBeInstanceOf(Date)
    expect(custom.get('refreshedOn')).toBeInstanceOf(Date)

    const plain = await Note.create({ name: 'Plain' })
    expect(plain.get('created_at')).toBeUndefined()
    expect(plain.get('updated_at')).toBeUndefined()

  })

  it('serializes and hydrates schema-native JSON columns without manual casts', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const teams = defineTable('teams', {
      id: column.id(),
      name: column.string(),
      meta: column.json(),
      active: column.boolean(),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
    })
    await createTestTable(db, teams)

    const Team = defineModelFromTable(teams, {
      fillable: ['name', 'meta', 'active'],
    })

    const created = await Team.create({
      name: 'Matrix',
      meta: { source: 'test', enabled: true },
      active: true,
    })


    expect(created.get('meta')).toEqual({ source: 'test', enabled: true })
    expect(created.get('active')).toBe(true)
  })

  it('covers empty-result and broken-entity failure paths', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)

    const User = defineModelFromTable(users, {
      fillable: ['name'] })

    await expect(User.firstOrFail()).rejects.toThrow('User not found.')

    const broken = hydrateRecord(User.getRepository(), { name: 'Broken' })
    broken.set('name', 'Still broken')
    await expect(broken.save()).rejects.toThrow('Cannot persist User without a primary key value.')

    const orphan = new Entity({ definition: User.definition, getConnection: () => DB.connection() } as never, { id: 9 }, true)
    await expect(orphan.restore()).rejects.toThrow('The bound repository cannot restore entities.')
    expect(() => orphan.replicate()).toThrow('The bound repository cannot replicate entities.')

    const softTable = defineTable('soft_users', {
      id: column.id(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, softTable)
    const SoftUser = defineModelFromTable(softTable, {
      softDeletes: true })
    const repo = User.getRepository()
    const brokenRestore = hydrateRecord(SoftUser.getRepository(), { deleted_at: '2025-01-01T00:00:00.000Z' as never })
    await expect(SoftUser.getRepository().restoreEntity(brokenRestore)).rejects.toThrow(
      'Cannot restore SoftUser without a primary key value.',
    )
    await expect(SoftUser.getRepository().forceDeleteEntity(brokenRestore)).rejects.toThrow(
      'Cannot force-delete SoftUser without a primary key value.',
    )
    const plainRestorable = hydrateRecord(repo, { id: 3, name: 'Plain' })
    await expect(repo.restoreEntity(plainRestorable)).rejects.toThrow('User does not support soft deletes.')
  })

  it('rolls back failed writes so partial model mutations do not leak', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
      ])

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'],
      events: {
        created() {
          throw new Error('created event failed')
        },
        updated() {
          throw new Error('updated event failed')
        },
        deleted() {
          throw new Error('deleted event failed')
        } } })

    await expect(User.create({
      name: 'Amina',
      email: 'a@example.com',
      status: 'active' })).rejects.toThrow('created event failed')
    expect((await db.table('users').get())).toEqual([
      { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
    ])

    const user = await User.findOrFail(1)
    user.fill({ name: 'Changed' })
    await expect(user.save()).rejects.toThrow('updated event failed')
    expect((await db.table('users').get())).toEqual([
      { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
    ])

    const doomed = await User.findOrFail(1)
    await expect(doomed.delete()).rejects.toThrow('deleted event failed')
    expect((await db.table('users').get())).toEqual([
      { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
    ])
  })

  it('rejects model definitions that do not have an inferred primary key', () => {
    const keyless = defineTable('keyless', {
      name: column.string() })
    const profile = defineTable('profile', {
      id: column.id() })

    expect(() => defineModelFromTable(keyless)).toThrow(SchemaError)
    expect(defineModelFromTable(profile).definition.name).toBe('Profile')
    expect(() => defineModelFromTable(profile, { softDeletes: true })).toThrow(
      'Soft-deleting model "Profile" requires a "deleted_at" column.',
    )
  })

  it('supports explicit non-incrementing primary keys and custom key types end to end', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const apiKeys = defineTable('api_keys', {
      key: column.string().primaryKey(),
      label: column.string() })
    await createTestTable(db, apiKeys)

    const ApiKey = defineModelFromTable(apiKeys, {
      primaryKey: 'key',
      fillable: ['key', 'label'] })

    const created = await ApiKey.create({ key: 'public-key', label: 'Public' })
    expect(created.toJSON()).toEqual({ key: 'public-key', label: 'Public' })

    const found = await ApiKey.findOrFail('public-key')
    expect(found.get('label')).toBe('Public')

    const updated = await ApiKey.update('public-key', { label: 'Public v2' })
    expect(updated.get('label')).toBe('Public v2')

    const queried = await ApiKey.query().where('key', 'public-key').firstOrFail()
    expect(queried.get('key')).toBe('public-key')

    await ApiKey.delete('public-key')
    await expect(ApiKey.find('public-key')).resolves.toBeUndefined()
  })

  it('can fail fast when accessing missing attributes on partially selected models', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Mohamed', email: 'm@example.com' },
      ])

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email'],
      preventAccessingMissingAttributes: true,
      accessors: {
        label: (_value, entity) => `User:${entity.toAttributes().name}` } })

    const selected = await User.select('id', 'name').firstOrFail()
    expect(selected.get('name')).toBe('Mohamed')
    expect(() => asDynamicEntity(selected).email).toThrow(
      new HydrationError('Attribute "email" is missing from model "User".'),
    )

    User.preventAccessingMissingAttributes(false)
    expect(asDynamicEntity(selected).email).toBeUndefined()
  })

  it('supports repository and static update/delete/upsert flows', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
      ])

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'],
      guarded: ['id'] })

    expect((await User.update(1, { name: 'Mo' })).get('name')).toBe('Mo')
    await User.delete(1)
    expect(await User.find(1)).toBeUndefined()

    const created = await User.updateOrCreate(
      { email: 'new@example.com' },
      { name: 'New User', status: 'active' },
    )
    expect(created.get('id')).toBe(2)

    const updated = await User.upsert(
      { email: 'new@example.com' },
      { status: 'inactive' },
    )
    expect(updated.get('status')).toBe('inactive')
    expect((await User.get())).toHaveLength(1)
  })

  it('dispatches lifecycle events and observers, including cancellation', async () => {
    const calls: string[] = []

    class UserObserver {
      retrieved(entity: unknown) {
        calls.push(`observer:retrieved:${String(asTestEntity(entity).get('name'))}`)
      }

      created(entity: unknown) {
        calls.push(`observer:created:${String(asTestEntity(entity).get('name'))}`)
      }

      updated(entity: unknown) {
        calls.push(`observer:updated:${String(asTestEntity(entity).get('name'))}`)
      }

      deleted(entity: unknown) {
        calls.push(`observer:deleted:${String(asTestEntity(entity).get('name'))}`)
      }
    }

    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' }])

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'],
      events: {
        retrieved: [entity => calls.push(`event:retrieved:${String(asTestEntity(entity).get('name'))}`)],
        saving: [entity => calls.push(`event:saving:${String(asTestEntity(entity).get('name') ?? 'new')}`)],
        creating: [entity => calls.push(`event:creating:${String(asTestEntity(entity).get('name'))}`)],
        created: [entity => calls.push(`event:created:${String(asTestEntity(entity).get('name'))}`)],
        updating: [entity => calls.push(`event:updating:${String(asTestEntity(entity).get('name'))}`)],
        updated: [entity => calls.push(`event:updated:${String(asTestEntity(entity).get('name'))}`)],
        deleting: [entity => calls.push(`event:deleting:${String(asTestEntity(entity).get('name'))}`)],
        deleted: [entity => calls.push(`event:deleted:${String(asTestEntity(entity).get('name'))}`)] },
      observers: [UserObserver, {
        deleted(entity: unknown) {
          calls.push(`observer-object:deleted:${String(asTestEntity(entity).get('name'))}`)
        } }] })

    await User.find(1)
    const created = await User.create({ name: 'Amina', email: 'a@example.com', status: 'active' })
    created.set('name', 'Amina 2')
    await created.save()
    await created.delete()

    expect(calls).toEqual([
      'event:retrieved:Mohamed',
      'observer:retrieved:Mohamed',
      'event:saving:Amina',
      'event:creating:Amina',
      'event:created:Amina',
      'observer:created:Amina',
      'event:saving:Amina 2',
      'event:updating:Amina 2',
      'event:updated:Amina 2',
      'observer:updated:Amina 2',
      'event:deleting:Amina 2',
      'event:deleted:Amina 2',
      'observer:deleted:Amina 2',
      'observer-object:deleted:Amina 2',
    ])

    const Cancelled = defineModelFromTable(users, {
      fillable: ['name'],
      events: {
        creating: () => false } })

    await expect(Cancelled.create({ name: 'Blocked' })).rejects.toThrow('creating event cancelled')
  })

  it('preserves duplicate configured observers', async () => {
    const calls: string[] = []
    const observer = {
      retrieved() {
        calls.push('retrieved')
      },
    }

    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    const User = defineModelFromTable(users, {
      observers: [observer, observer],
    })

    await User.find(1)

    expect(calls).toEqual(['retrieved', 'retrieved'])
  })

  it('supports muting events and quiet create helpers', async () => {
    const calls: string[] = []

    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' }])

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'],
      events: {
        creating: [entity => calls.push(`event:creating:${String(asTestEntity(entity).get('name'))}`)],
        created: [entity => calls.push(`event:created:${String(asTestEntity(entity).get('name'))}`)],
        updating: [entity => calls.push(`event:updating:${String(asTestEntity(entity).get('name'))}`)],
        deleted: [entity => calls.push(`event:deleted:${String(asTestEntity(entity).get('name'))}`)] },
      observers: [{
        created(entity: unknown) {
          calls.push(`observer:created:${String(asTestEntity(entity).get('name'))}`)
        } }] })

    const quiet = await User.createQuietly({ name: 'Quiet', email: 'q@example.com', status: 'active' })
    await User.createManyQuietly([
      { name: 'Quiet 2', email: 'q2@example.com', status: 'active' },
      { name: 'Quiet 3', email: 'q3@example.com', status: 'active' },
    ])
    const drafted = User.make({ name: 'Quiet Draft', email: 'qd@example.com', status: 'active' })
    await drafted.saveQuietly()
    quiet.set('name', 'Quiet Updated')
    await quiet.saveQuietly()
    await quiet.deleteQuietly()

    await User.withoutEvents(async () => {
      await User.create({ name: 'Muted', email: 'm2@example.com', status: 'active' })
      const replica = (await User.findOrFail(1)).replicate()
      expect(replica.exists()).toBe(false)
    })
    await User.getRepository().saveManyQuietly([
      User.make({ name: 'Batch Quiet', email: 'bq@example.com', status: 'active' }),
    ])

    expect(calls).toEqual([])
  })

  it('applies pending attributes to new records while letting explicit values win', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      email: column.string(),
      name: column.string(),
      status: column.string(),
      role: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, email: 'existing@example.com', name: 'Existing', status: 'active', role: 'staff' }])

    const User = defineModelFromTable(users, {
      fillable: ['email', 'name', 'status', 'role'],
      pendingAttributes: {
        status: 'draft',
        role: 'member' } })

    const made = User.make({ email: 'new@example.com', name: 'New' })
    expect(made.get('status')).toBe('draft')
    expect(made.get('role')).toBe('member')

    const created = await User.create({
      email: 'created@example.com',
      name: 'Created',
      role: 'admin' })
    expect(created.get('status')).toBe('draft')
    expect(created.get('role')).toBe('admin')

    const firstOrNew = await User.firstOrNew(
      { email: 'missing@example.com' },
      { name: 'Missing' },
    )
    expect(firstOrNew.exists()).toBe(false)
    expect(firstOrNew.get('status')).toBe('draft')
    expect(firstOrNew.get('role')).toBe('member')

    const firstOrCreate = await User.firstOrCreate(
      { email: 'created-2@example.com' },
      { name: 'Created 2' },
    )
    expect(firstOrCreate.get('status')).toBe('draft')
    expect(firstOrCreate.get('role')).toBe('member')

    const existing = await User.firstOrNew(
      { email: 'existing@example.com' },
      { name: 'Ignored' },
    )
    expect(existing.exists()).toBe(true)
    expect(existing.get('status')).toBe('active')
    expect(existing.get('role')).toBe('staff')
  })

  it('compares models by key, table, and connection', async () => {
    const defaultAdapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => defaultAdapter.disconnect())
    const secondaryAdapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => secondaryAdapter.disconnect())

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter: defaultAdapter,
          dialect: createDatabaseDialect('sqlite') }),
        secondary: createDatabase({
          connectionName: 'secondary',
          adapter: secondaryAdapter,
          dialect: createDatabaseDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(DB.connection('default'), users)
    await DB.connection('default').table(users).insert([{ id: 1, name: 'Mohamed' }])
    await createTestTable(DB.connection('secondary'), users)
    await DB.connection('secondary').table(users).insert([{ id: 1, name: 'Mohamed Secondary' }])
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string() })
    await createTestTable(DB.connection('default'), posts)
    await DB.connection('default').table(posts).insert([{ id: 1, title: 'Post' }])

    const User = defineModelFromTable(users, { guarded: [] })
    const SecondaryUser = defineModelFromTable(users, {
      name: 'SecondaryUser',
      connectionName: 'secondary' })
    const Post = defineModelFromTable(posts)

    const one = await User.findOrFail(1)
    const two = await User.findOrFail(1)
    const secondary = await SecondaryUser.findOrFail(1)
    const post = await Post.findOrFail(1)
    const draft = User.make({ name: 'Draft' })

    expect(one.is(two)).toBe(true)
    expect(one.isNot(two)).toBe(false)
    expect(one.is(secondary)).toBe(false)
    expect(one.is(post)).toBe(false)
    expect(one.is(draft)).toBe(false)
    expect(one.is({})).toBe(false)
  })

  it('supports quiet restore and force delete helpers', async () => {
    const calls: string[] = []

    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Soft', deleted_at: null },
      ])

    const User = defineModelFromTable(users, {
      fillable: ['name'],
      softDeletes: true,
      events: {
        deleted: [entity => calls.push(`deleted:${String(asTestEntity(entity).get('name'))}`)],
        restored: [entity => calls.push(`restored:${String(asTestEntity(entity).get('name'))}`)],
        forceDeleted: [entity => calls.push(`forceDeleted:${String(asTestEntity(entity).get('name'))}`)] } })

    const user = await User.findOrFail(1)
    await user.deleteQuietly()
    expect(user.trashed()).toBe(true)
    await user.restoreQuietly()
    expect(user.trashed()).toBe(false)
    await user.forceDeleteQuietly()
    expect(calls).toEqual([])
  })

  it('supports default eager loads and lets newQueryWithoutRelationships skip them', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    await createTestTable(db, users)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer(),
      bio: column.string() })
    await createTestTable(db, profiles)
    await db.table(profiles).insert([{ id: 10, userId: 1, bio: 'Engineer' }])

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Profile = defineModelFromTable(profiles)

    User = defineModelFromTable(users, {
      with: ['profile'],
      relations: {
        profile: hasOne(() => Profile, 'userId') } })

    const loaded = await User.findOrFail(1)
    expect(loaded.getRelation<Entity<TableDefinition>>('profile')?.get('bio')).toBe('Engineer')

    const plain = await User.newQueryWithoutRelationships().findOrFail(1)
    expect(plain.hasRelation('profile')).toBe(false)
  })

  it('loads native relations through then, catch, and finally and caches explicit relation assignments', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const posts = defineTable('posts', { id: column.id(), user_id: column.integer(), title: column.string() })
    await createTestTable(db, users)
    await createTestTable(db, posts)
    await db.table(users).insert({ id: 1, name: 'Original' })
    await db.table(posts).insert({ id: 10, user_id: 1, title: 'Loaded' })
    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, { guarded: [], relations: { posts: hasMany(() => Post, 'user_id') } })
    const user = await User.findOrFail(1)
    user.name = 'Changed'
    await user.save()
    expect((await User.findOrFail(1)).get('name')).toBe('Changed')
    const relation = user.posts as typeof user.posts & Pick<Promise<readonly ReturnType<typeof Post.make>[]>, 'then' | 'catch' | 'finally'>
    expect((await relation.then(records => records))[0]?.get('title')).toBe('Loaded')
    expect((await relation.catch(() => []))[0]?.get('title')).toBe('Loaded')
    let finalized = false
    expect((await relation.finally(() => { finalized = true }))[0]?.get('title')).toBe('Loaded')
    expect(finalized).toBe(true)
    Reflect.set(user, 'posts', [])
    expect(await user.posts).toEqual([])
  })

  it('dispatches trashed, force delete, and replicating lifecycle hooks', async () => {
    const calls: string[] = []

    class UserObserver {
      trashed(entity: unknown) {
        calls.push(`observer:trashed:${String(asTestEntity(entity).get('name'))}`)
      }

      forceDeleted(entity: unknown) {
        calls.push(`observer:forceDeleted:${String(asTestEntity(entity).get('name'))}`)
      }

      replicating(entity: unknown) {
        calls.push(`observer:replicating:${String(asTestEntity(entity).get('name'))}`)
      }
    }

    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp().nullable() })
    await createTestTable(db, users)
    await db.table(users).insert([
        { id: 1, name: 'Alive', deleted_at: null },
        { id: 2, name: 'Trash Me', deleted_at: null },
      ])

    const User = defineModelFromTable(users, {
      fillable: ['name'],
      softDeletes: true,
      events: {
        trashed: [entity => calls.push(`event:trashed:${String(asTestEntity(entity).get('name'))}`)],
        forceDeleting: [entity => calls.push(`event:forceDeleting:${String(asTestEntity(entity).get('name'))}`)],
        forceDeleted: [entity => calls.push(`event:forceDeleted:${String(asTestEntity(entity).get('name'))}`)],
        replicating: [entity => calls.push(`event:replicating:${String(asTestEntity(entity).get('name'))}`)] },
      observers: [UserObserver] })

    const trashMe = await User.findOrFail(2)
    await trashMe.delete()
    await trashMe.forceDelete()

    const alive = await User.findOrFail(1)
    const replica = alive.replicate()
    expect(replica.exists()).toBe(false)
    expect(replica.get('name')).toBe('Alive')

    expect(calls).toEqual([
      'event:trashed:Trash Me',
      'observer:trashed:Trash Me',
      'event:forceDeleting:Trash Me',
      'event:forceDeleted:Trash Me',
      'observer:forceDeleted:Trash Me',
      'event:replicating:Alive',
      'observer:replicating:Alive',
    ])
  })

  it('resolves morph selectors across registered model references and bare definitions', () => {
    resetDB()

    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string() })

    const Post = defineModelFromTable(posts, {
      morphClass: 'articles' })

    expect(resolveMorphSelector('articles')).toBe(Post)
    expect(resolveMorphSelector('Post')).toBe(Post)
    expect(resolveMorphSelector('posts')).toBe(Post)

    resetDB()
    registerMorphModel('articles', Post.definition)

    expect(resolveMorphSelector('articles')).toBe(Post.definition)
    expect(resolveMorphSelector('Post')).toBe(Post.definition)
    expect(resolveMorphSelector('posts')).toBe(Post.definition)
    expect(resolveMorphSelector('missing')).toBeUndefined()
  })

  it('resolves string relation targets through the global model registry', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineTable('posts', {
      id: column.id(),
      user_id: column.integer(),
    })
    const User = defineModelFromTable(users)
    const Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo('User' as never, 'user_id'),
      },
    })

    const relation = Post.definition.relations.author
    expect(relation.related()).toBe(User)
    expect(belongsTo('MissingUser' as never, 'user_id').related).toThrow(
      'Relation target "MissingUser" is not registered.',
    )
  })
})
