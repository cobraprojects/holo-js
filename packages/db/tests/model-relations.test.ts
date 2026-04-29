import { beforeEach, describe, expect, it } from 'vitest'
import {
  DB,
  Entity,
  HydrationError,
  RelationError,
  SecurityError,
  belongsTo,
  belongsToMany,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  defineModel,
  hasMany,
  hasManyThrough,
  hasOne,
  hasOneThrough,
  latestOfMany,
  latestMorphOne,
  morphMany,
  morphOne,
  morphTo,
  morphToMany,
  morphedByMany,
  oldestOfMany,
  oldestMorphOne,
  resetDB,
  resetMorphRegistry,
  scopeRelation,
  registerGeneratedTables,
  clearGeneratedTables,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
  type TableDefinition } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

type Row = Record<string, unknown>
type TableStore = Record<string, Row[]>
type TestEntity = Entity<TableDefinition>
type DynamicEntity = TestEntity & Record<string, unknown>
type JsonRecord = Record<string, unknown>
type RelationFilterDescriptor = { relation: string, negate: boolean, boolean?: 'and' | 'or', morphTypes?: readonly string[] }
type RepositoryRelationHarness = {
  applyRelationExistenceFilter(
    query: { toSQL(): { sql: string } },
    filter: RelationFilterDescriptor,
  ): { toSQL(): { sql: string } }
  filterByRelations(entities: readonly unknown[], filters: readonly { relation: string, negate: boolean }[]): Promise<unknown[]>
  loadRelationAggregates(entities: readonly unknown[], aggregates: readonly Record<string, unknown>[]): Promise<void>
  getRelationDefinition(name: string): unknown
  getRelationAggregateValues(
    entities: readonly unknown[],
    relation: unknown,
    aggregate: Record<string, unknown>,
  ): Promise<unknown>
}

function asDynamicEntity(value: unknown): DynamicEntity {
  return value as DynamicEntity
}

function applyPredicate(row: Row, column: string, operator: string, value: unknown): boolean {
  const left = row[column]
  const normalizedLeft = typeof left === 'boolean' && typeof value === 'number'
    ? Number(left)
    : left
  const normalizedRight = typeof value === 'boolean' && typeof left === 'number'
    ? Number(value)
    : value

  switch (operator) {
    case '=':
      return normalizedLeft === normalizedRight
    case 'IN':
      return Array.isArray(value) && value.includes(normalizedLeft)
    default:
      return false
  }
}

function filterRows(sql: string, bindings: readonly unknown[], rows: Row[]): Row[] {
  if (sql.includes('EXISTS (SELECT')) {
    return rows
  }

  const whereMatch = sql.match(/ WHERE (.+?)( ORDER BY| LIMIT| OFFSET|$)/)
  if (!whereMatch) return rows

  const clauses = whereMatch[1]!.split(' AND ')
  return rows.filter(row => clauses.every((clause) => {
    const nullMatch = clause.match(/^"([^"]+)" IS( NOT)? NULL$/)
    if (nullMatch) {
      const [, column, negated] = nullMatch
      const isNull = row[column!] == null
      return negated ? !isNull : isNull
    }

    const inMatch = clause.match(/^"([^"]+)" IN \((.+)\)$/)
    if (inMatch) {
      const [, column, rawPlaceholders] = inMatch
      const indexes = rawPlaceholders!.split(', ').map(part => Number(part.replace('?', '')) - 1)
      return applyPredicate(row, column!, 'IN', indexes.map(index => bindings[index]))
    }

    const match = clause.match(/^"([^"]+)" ([A-Z!=<>]+) \?(\d+)$/)
    if (!match) return true
    const [, column, operator, index] = match
    return applyPredicate(row, column!, operator!, bindings[Number(index) - 1])
  }))
}

class RelationAdapter implements DriverAdapter {
  connected = false
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly executions: Array<{ sql: string, bindings: readonly unknown[] }> = []

  constructor(readonly tables: TableStore) {}

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    this.queries.push({ sql, bindings })

    const tableMatch = sql.match(/ FROM "([^"]+)"/)
    let rows = filterRows(sql, bindings, this.tables[tableMatch?.[1] ?? ''] ?? [])
    const orderMatch = sql.match(/ ORDER BY "([^"]+)" (ASC|DESC)/)
    if (orderMatch) {
      const [, column, direction] = orderMatch
      rows = [...rows].sort((left, right) => {
        const a = left[column!]
        const b = right[column!]
        if (a === b) return 0
        if (direction === 'ASC') return a! < b! ? -1 : 1
        return a! > b! ? -1 : 1
      })
    }
    return {
      rows: rows.map(row => ({ ...row })) as TRow[],
      rowCount: rows.length }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })

    const insertMatch = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES (.+)$/)
    if (insertMatch) {
      const [, tableName, rawColumns, rawValues] = insertMatch
      const columns = rawColumns!.split(', ').map(part => part.replace(/"/g, ''))
      const groups = [...rawValues!.matchAll(/\(([^)]+)\)/g)]
      const table = this.tables[tableName!] ?? (this.tables[tableName!] = [])

      for (const group of groups) {
        const placeholders = group[1]!.split(', ')
        const row: Row = {}
        for (let index = 0; index < columns.length; index += 1) {
          const bindingIndex = Number(placeholders[index]!.replace('?', '')) - 1
          row[columns[index]!] = bindings[bindingIndex]
        }

        if (!('id' in row)) {
          const nextId = table.reduce((max, current) => Math.max(max, Number(current.id ?? 0)), 0) + 1
          row.id = nextId
        }

        table.push(row)
      }

      return { affectedRows: groups.length, lastInsertId: table.at(-1)?.id as number | string | undefined }
    }

    const updateMatch = sql.match(/^UPDATE "([^"]+)" SET (.+?) WHERE /)
    if (updateMatch) {
      const [, tableName, rawAssignments] = updateMatch
      const table = this.tables[tableName!] ?? []
      const rows = filterRows(sql, bindings, table)
      const assignments = rawAssignments!.split(', ').map((assignment) => {
        const match = assignment.match(/^"([^"]+)" = \?(\d+)$/)
        return {
          column: match?.[1] ?? '',
          bindingIndex: Number(match?.[2] ?? '0') - 1 }
      })

      for (const row of rows) {
        for (const assignment of assignments) {
          row[assignment.column] = bindings[assignment.bindingIndex]
        }
      }

      return { affectedRows: rows.length }
    }

    const deleteMatch = sql.match(/^DELETE FROM "([^"]+)" WHERE /)
    if (deleteMatch) {
      const [, tableName] = deleteMatch
      const table = this.tables[tableName!] ?? []
      const rows = new Set(filterRows(sql, bindings, table))
      this.tables[tableName!] = table.filter(row => !rows.has(row))
      return { affectedRows: rows.size }
    }

    return { affectedRows: 0 }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

describe('relation helper option defaults', () => {
  it('uses default keys for object-style relation helpers', () => {
    const Target = defineTable('targets', {
      id: column.id() })

    const belongsToRelation = belongsTo(() => defineModelFromTable(Target, {}), { foreignKey: 'targetId' })
    const hasOneRelation = hasOne(() => defineModelFromTable(Target, {}), { foreignKey: 'targetId' })
    const manyToManyRelation = belongsToMany(() => defineModelFromTable(Target, {}), {
      pivotTable: 'target_user',
      foreignPivotKey: 'userId',
      relatedPivotKey: 'targetId' })

    expect(belongsToRelation).toMatchObject({
      kind: 'belongsTo',
      foreignKey: 'targetId',
      ownerKey: 'id' })
    expect(hasOneRelation).toMatchObject({
      kind: 'hasOne',
      foreignKey: 'targetId',
      localKey: 'id' })
    expect(manyToManyRelation).toMatchObject({
      kind: 'belongsToMany',
      pivotTable: 'target_user',
      foreignPivotKey: 'userId',
      relatedPivotKey: 'targetId',
      parentKey: 'id',
      relatedKey: 'id' })
  })
})

class NullAffectedDeleteAdapter extends RelationAdapter {
  override async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    const result = await super.execute(sql, bindings)
    if (sql.startsWith('DELETE FROM')) {
      return {}
    }

    return result
  }
}

function createDialect(): Dialect {
  return {
    name: 'sqlite',
    capabilities: {
      returning: false,
      savepoints: false,
      concurrentQueries: true,
      workerThreadExecution: false,
      lockForUpdate: false,
      sharedLock: false,
      jsonValueQuery: true,
      jsonContains: false,
      jsonLength: false,
      schemaQualifiedIdentifiers: false,
      nativeUpsert: false,
      ddlAlterSupport: false,
      introspection: true },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    } }
}

describe('model relation slice', () => {
  beforeEach(() => {
    resetDB()
    resetMorphRegistry()
  })

  it('compiles relation existence queries through SQL subqueries or joins', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      posts: [{ id: 10, userId: 1, title: 'Post A' }],
      tags: [{ id: 20, name: 'News' }],
      post_tags: [{ postId: 10, tagId: 20 }],
      images: [{ id: 30, imageableType: 'User', imageableId: 1, url: 'avatar.png' }],
      mechanics: [{ id: 40, name: 'Mechanic A' }],
      cars: [{ id: 50, mechanicId: 40 }],
      repairs: [{ id: 60, carId: 50 }] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })
    const tags = defineTable('tags', {
      id: column.id(),
      name: column.string() })
    const postTags = defineTable('post_tags', {
      postId: column.integer(),
      tagId: column.integer() })
    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string(),
      imageableId: column.integer(),
      url: column.string() })
    const mechanics = defineTable('mechanics', {
      id: column.id(),
      name: column.string() })
    const cars = defineTable('cars', {
      id: column.id(),
      mechanicId: column.integer() })
    const repairs = defineTable('repairs', {
      id: column.id(),
      carId: column.integer() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    let Tag: ReturnType<typeof defineModelFromTable<typeof tags>>
    let Image: ReturnType<typeof defineModelFromTable<typeof images>>
    let Car: ReturnType<typeof defineModelFromTable<typeof cars>>
    let Repair: ReturnType<typeof defineModelFromTable<typeof repairs>>
    let Mechanic: ReturnType<typeof defineModelFromTable<typeof mechanics>>

    User = defineModelFromTable(users, {
      morphClass: 'User',
      relations: {
        posts: hasMany(() => Post, 'userId'),
        images: morphMany(() => Image, 'imageable') } })
    Post = defineModelFromTable(posts, {
      morphClass: 'Post',
      relations: {
        author: belongsTo(() => User, 'userId'),
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId') } })
    Tag = defineModelFromTable(tags)
    Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable') } })
    Car = defineModelFromTable(cars)
    Repair = defineModelFromTable(repairs)
    Mechanic = defineModelFromTable(mechanics, {
      relations: {
        repairs: hasManyThrough(() => Repair, () => Car, 'mechanicId', 'carId', 'id', 'id') } })

    const hasManySql = User.has('posts').toSQL().sql
    const nestedHasSql = User.has('posts.tags').toSQL().sql
    const nestedWhereHasSql = User.whereHas('posts.tags', query => query.where('name', 'News')).toSQL().sql
    const belongsToManySql = Post.has('tags').toSQL().sql
    const morphToSql = Image.has('imageable').toSQL().sql
    const morphToOrSql = Image.where('id', 999).orHas('imageable').toSQL().sql
    const morphToOrDoesntHaveSql = Image.where('id', 999).orDoesntHave('imageable').toSQL().sql
    const throughSql = Mechanic.has('repairs').toSQL().sql

    expect(hasManySql).toContain('EXISTS (SELECT * FROM "posts"')
    expect(hasManySql).toContain('"userId" = "users"."id"')
    expect(nestedHasSql).toContain('EXISTS (SELECT * FROM "posts"')
    expect(nestedHasSql).toContain('EXISTS (SELECT * FROM "tags"')
    expect(nestedWhereHasSql).toContain('"name" =')
    expect(belongsToManySql).toContain('EXISTS (SELECT * FROM "tags"')
    expect(belongsToManySql).toContain('IN (SELECT "tagId" FROM "post_tags"')
    expect(morphToSql).toContain('EXISTS (SELECT * FROM "users"')
    expect(morphToSql).toContain('OR EXISTS (SELECT * FROM "posts"')
    expect(morphToOrSql).toContain(' OR (EXISTS (SELECT * FROM "users"')
    expect(morphToOrDoesntHaveSql).toContain(' OR NOT (EXISTS (SELECT * FROM "users"')
    expect(throughSql).toContain('EXISTS (SELECT * FROM "repairs"')
    expect(throughSql).toContain('JOIN "cars"')

    await User.has('posts').get()
    expect(adapter.queries[0]?.sql).toContain('EXISTS (SELECT * FROM "posts"')

    const repositorySql = (User.getRepository() as unknown as RepositoryRelationHarness)
      .applyRelationExistenceFilter(
        User.query().getTableQueryBuilder(),
        { relation: 'posts', negate: false },
      )
      .toSQL()
      .sql
    const morphRepositorySql = (Image.getRepository() as unknown as RepositoryRelationHarness)
      .applyRelationExistenceFilter(
        Image.query().getTableQueryBuilder(),
        { relation: 'imageable', negate: false },
      )
      .toSQL()
      .sql

    expect(repositorySql).toContain('EXISTS (SELECT * FROM "posts"')
    expect(morphRepositorySql).toContain('(EXISTS (SELECT * FROM "users"')
  })

  it('fails closed to an impossible predicate when morphTo existence has no registered targets and no-ops for negated checks', () => {
    const adapter = new RelationAdapter({
      images: [{ id: 1, imageableType: 'User', imageableId: 10, url: 'avatar.png' }] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string(),
      imageableId: column.integer(),
      url: column.string() })

    const Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable') } })
    resetMorphRegistry()

    expect(Image.has('imageable').toSQL().sql).toContain('"images"."id" IS NULL AND "images"."id" IS NOT NULL')
    expect(Image.where('id', 999).orHas('imageable').toSQL().sql).toContain(' OR ("images"."id" IS NULL AND "images"."id" IS NOT NULL)')
    expect(Image.orDoesntHave('imageable').toSQL().sql).toBe('SELECT * FROM "images"')
  })

  it('loads belongsTo, hasOne, and hasMany relations with eager loading and entity loaders', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Post A' },
        { id: 11, userId: 1, title: 'Post B' },
        { id: 12, userId: 2, title: 'Post C' },
        { id: 13, userId: null, title: 'Orphan' },
      ],
      profiles: [
        { id: 100, userId: 1, bio: 'Engineer' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().nullable(),
      title: column.string() })
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer(),
      bio: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    let Profile: ReturnType<typeof defineModelFromTable<typeof profiles>>

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
        profile: hasOne(() => Profile, 'userId') } })
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })
    Profile = defineModelFromTable(profiles, {
      relations: {
        user: belongsTo(() => User, 'userId') } })

    const loadedPosts = await Post.query().with('author').orderBy('id').get()
    expect(loadedPosts[0]?.getRelation<Entity<TableDefinition>>('author')?.get('name')).toBe('Mohamed')
    expect(loadedPosts[3]?.getRelation('author')).toBeNull()
    expect(adapter.queries[1]).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" IN (?1, ?2)',
      bindings: [1, 2] })

    const user = await User.findOrFail(1)
    await user.load('posts', 'profile')
    expect(user.getRelation<Entity<TableDefinition>[]>('posts').map(post => post.get('title'))).toEqual(['Post A', 'Post B'])
    expect(user.getRelation<Entity<TableDefinition>>('profile')?.get('bio')).toBe('Engineer')
    expect(user.toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      posts: [
        { id: 10, userId: 1, title: 'Post A' },
        { id: 11, userId: 1, title: 'Post B' },
      ],
      profile: { id: 100, userId: 1, bio: 'Engineer' } })

    const queryCount = adapter.queries.length
    await user.loadMissing('posts', 'profile')
    expect(adapter.queries).toHaveLength(queryCount)

    const collection = await User.query().orderBy('id').get()
    await collection.load('posts')
    await collection.loadMissing('profile')
    await collection.loadCount('posts')
    await collection.loadExists('posts')
    await collection.loadSum('posts', 'id')
    await collection.loadAvg('posts', 'id')
    await collection.loadMin('posts', 'id')
    await collection.loadMax('posts', 'id')
    expect(collection[0]?.getRelation<Entity<TableDefinition>[]>('posts').map(post => post.get('title'))).toEqual(['Post A', 'Post B'])
    expect((collection[0]?.toJSON() as Record<string, unknown>).posts_count).toBe(2)
    expect((collection[0]?.toJSON() as Record<string, unknown>).posts_exists).toBe(true)
    expect((collection[0]?.toJSON() as Record<string, unknown>).posts_sum_id).toBe(21)
    expect((collection[0]?.toJSON() as Record<string, unknown>).posts_avg_id).toBe(10.5)
    expect((collection[0]?.toJSON() as Record<string, unknown>).posts_min_id).toBe(10)
    expect((collection[0]?.toJSON() as Record<string, unknown>).posts_max_id).toBe(11)

    const userWithoutProfile = await User.findOrFail(2)
    await userWithoutProfile.load('profile', 'posts')
    expect(userWithoutProfile.getRelation('profile')).toBeNull()
    expect(userWithoutProfile.getRelation<Entity<TableDefinition>[]>('posts')).toHaveLength(1)

    const orphan = await Post.findOrFail(13)
    await orphan.load('author')
    expect(orphan.getRelation('author')).toBeNull()

    const detachedUser = User.getRepository().hydrate({ id: null as never, name: 'Detached' })
    await detachedUser.load('posts', 'profile')
    expect(detachedUser.getRelation<Entity<TableDefinition>[]>('posts')).toEqual([])
    expect(detachedUser.getRelation('profile')).toBeNull()
  })

  it('respects soft-delete scopes in relations and allows explicit withTrashed relation constraints', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Alive', deleted_at: null },
        { id: 2, name: 'Trashed', deleted_at: '2025-01-01T00:00:00.000Z' },
      ],
      posts: [
        { id: 1, userId: 1, title: 'Live Post' },
        { id: 2, userId: 2, title: 'Archived Post' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp().nullable() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    const User = defineModelFromTable(users, {
      softDeletes: true })
    const Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId'),
        authorWithTrashed: scopeRelation(
          belongsTo(() => User, 'userId'),
          query => query.withTrashed(),
        ) } })

    const loaded = await Post.query()
      .with('author', 'authorWithTrashed')
      .orderBy('id')
      .get()

    expect(loaded[0]?.getRelation<Entity<TableDefinition>>('author')?.get('name')).toBe('Alive')
    expect(loaded[0]?.getRelation<Entity<TableDefinition>>('authorWithTrashed')?.get('name')).toBe('Alive')
    expect(loaded[1]?.getRelation('author')).toBeNull()
    expect(loaded[1]?.getRelation<Entity<TableDefinition>>('authorWithTrashed')?.get('name')).toBe('Trashed')
  })

  it('supports nested eager loading and belongsToMany eager loading', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
        { id: 3, name: 'Salma' },
        { id: 4, name: 'Nora' },
        { id: 5, name: 'Youssef' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Post A' },
        { id: 11, userId: 1, title: 'Post B' },
        { id: 12, userId: 2, title: 'Post C' },
      ],
      roles: [
        { id: 100, name: 'Admin' },
        { id: 101, name: 'Editor' },
      ],
      role_users: [
        { id: 1000, userId: 1, roleId: 100, grantedAt: '2026-01-01', approved: true },
        { id: 1001, userId: 1, roleId: 101, grantedAt: '2026-02-01', approved: true },
        { id: 1002, userId: 2, roleId: 101, grantedAt: '2026-03-01', approved: false },
        { id: 1003, userId: 4, roleId: null, grantedAt: '2026-04-01', approved: true },
        { id: 1004, userId: 5, roleId: 999, grantedAt: '2026-05-01', approved: true },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().nullable(),
      title: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string(),
      weight: column.integer() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer().nullable(),
      grantedAt: column.string(),
      approved: column.boolean() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    let Role: ReturnType<typeof defineModelFromTable<typeof roles>>

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId')
          .withPivot('grantedAt', 'approved')
          .wherePivot('approved', true)
          .orderByPivot('grantedAt', 'desc')
          .as('membership') } })
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })
    Role = defineModelFromTable(roles)

    const loadedUsers = await User.query().with('posts.author', 'roles').orderBy('id').get()
    const firstUserPosts = loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('posts') ?? []
    const firstUserRoles = loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('roles') ?? []
    const secondUserRoles = loadedUsers[1]?.getRelation<Entity<TableDefinition>[]>('roles') ?? []
    const firstPostAuthor = firstUserPosts[0]
      ? firstUserPosts[0].getRelation<Entity<TableDefinition>>('author')
      : undefined

    expect(firstPostAuthor?.get('name')).toBe('Mohamed')
    expect(firstUserRoles.map(role => role.get('name'))).toEqual(['Editor', 'Admin'])
    expect(secondUserRoles.map(role => role.get('name'))).toEqual([])
    expect((firstUserRoles[0]?.getRelation('membership') as JsonRecord | undefined)).toEqual({
      userId: 1,
      roleId: 101,
      grantedAt: '2026-02-01',
      approved: true })
    expect((firstUserRoles[1]?.getRelation('membership') as JsonRecord | undefined)).toEqual({
      userId: 1,
      roleId: 100,
      grantedAt: '2026-01-01',
      approved: true })
    expect(loadedUsers[2]?.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])
    expect(loadedUsers[3]?.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])
    expect(loadedUsers[4]?.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])

    const BrokenPivotFilterUser = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId')
          .wherePivot('missing' as never, '=', true) } })
    const BrokenPivotOrderUser = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId')
          .orderByPivot('missing' as never) } })

    await expect(BrokenPivotFilterUser.query().with('roles').get()).rejects.toThrow(SecurityError)
    await expect(BrokenPivotOrderUser.query().with('roles').get()).rejects.toThrow(SecurityError)

    const detachedUser = User.getRepository().hydrate({ id: null as never, name: 'Detached' })
    await detachedUser.load('roles')
    expect(detachedUser.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])

    const userWithoutPivotRows = await User.findOrFail(3)
    await userWithoutPivotRows.load('roles')
    expect(userWithoutPivotRows.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])

    const userWithNullPivotKey = await User.findOrFail(4)
    await userWithNullPivotKey.load('roles')
    expect(userWithNullPivotKey.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])

    const userWithDanglingPivot = await User.findOrFail(5)
    await userWithDanglingPivot.load('roles')
    expect(userWithDanglingPivot.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])

    expect(adapter.queries).toContainEqual({
      sql: 'SELECT * FROM "role_users" WHERE "approved" = ?1 AND "userId" IN (?2, ?3, ?4, ?5, ?6) ORDER BY "grantedAt" DESC',
      bindings: [1, 1, 2, 3, 4, 5] })
    expect(adapter.queries).toContainEqual({
      sql: 'SELECT * FROM "roles" WHERE "id" IN (?1, ?2, ?3)',
      bindings: [999, 101, 100] })
    expect(adapter.queries).toContainEqual({
      sql: 'SELECT * FROM "users" WHERE "id" IN (?1, ?2)',
      bindings: [1, 2] })
  })

  it('supports custom pivot models on many-to-many relations', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      roles: [
        { id: 100, name: 'Admin' },
        { id: 101, name: 'Editor' },
      ],
      role_users: [
        { id: 900, userId: 1, roleId: 100, grantedAt: '2026-01-01', approved: true },
        { id: 901, userId: 1, roleId: 101, grantedAt: '2026-02-01', approved: false },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer(),
      grantedAt: column.string(),
      approved: column.boolean() })

    const Membership = defineModelFromTable(roleUsers, {
      casts: {
        approved: 'boolean' } })
    const Role = defineModelFromTable(roles)
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId')
          .using(() => Membership)
          .as('membership') } })

    const user = await User.query().with('roles').firstOrFail()
    const memberships = user.getRelation<Entity<TableDefinition>[]>('roles')
      .map(role => role.getRelation('membership') as Entity)

    expect(memberships[0]).toBeInstanceOf(Entity)
    expect(memberships[0]?.get('id')).toBe(900)
    expect(memberships[0]?.get('grantedAt')).toBe('2026-01-01')
    expect(memberships[0]?.get('approved')).toBe(true)
    expect(memberships[1]?.get('approved')).toBe(false)
  })

  it('supports belongsToMany pivot mutation helpers', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      roles: [
        { id: 100, name: 'Admin' },
        { id: 101, name: 'Editor' },
        { id: 102, name: 'Viewer' },
        { id: 103, name: 'Auditor' },
      ],
      role_users: [
        { id: 1, userId: 1, roleId: 100, grantedAt: '2026-01-01' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string(),
      weight: column.integer() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer(),
      grantedAt: column.string().nullable() })

    const Role = defineModelFromTable(roles)
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId')
          .withPivot('grantedAt') } })

    const user = await User.findOrFail(1)

    await user.attach('roles', null as never)
    await user.attach('roles', 101, { grantedAt: '2026-02-01' })
    await user.attach('roles', 100, { grantedAt: '2026-01-05' })
    expect(adapter.tables.role_users).toHaveLength(2)
    expect(adapter.tables.role_users!.find(row => row.roleId === 100)?.grantedAt).toBe('2026-01-05')

    expect(await user.updateExistingPivot('roles', 101, { grantedAt: '2026-03-01' })).toBe(1)
    expect(await user.updateExistingPivot('roles', 101, {})).toBe(0)
    expect(await user.updateExistingPivot('roles', 101, { grantedAt: '2026-03-01' })).toBe(0)
    expect(await user.updateExistingPivot('roles', 999, { grantedAt: 'missing' })).toBe(0)

    expect(await user.syncWithoutDetaching('roles', {
      101: { grantedAt: '2026-04-01' },
      102: { grantedAt: '2026-05-01' } })).toEqual({
      attached: [102],
      detached: [],
      updated: [101] })
    await expect(user.syncWithoutDetaching('roles', { 101: { userId: 999, roleId: 999 } })).rejects.toThrow(
      'Pivot attribute "userId" on relation "roles" is reserved and cannot be set explicitly.',
    )

    expect(await user.toggle('roles', [100, 103])).toEqual({
      attached: [103],
      detached: [100] })
    expect(await user.toggle('roles', [])).toEqual({
      attached: [],
      detached: [] })

    expect(await user.sync('roles', [101])).toEqual({
      attached: [],
      detached: [102, 103],
      updated: [] })

    expect(await user.detach('roles', [])).toBe(0)
    expect(await user.detach('roles', 101)).toBe(1)
    expect(await user.detach('roles')).toBe(0)
    await user.load('roles')
    expect(user.getRelation<Entity<TableDefinition>[]>('roles')).toEqual([])

    expect(adapter.tables.role_users).toEqual([])
  })

  it('supports dynamic relation method calls for belongsToMany attach, sync, and detach', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      roles: [
        { id: 100, name: 'Admin' },
        { id: 101, name: 'Editor' },
        { id: 102, name: 'Viewer' },
      ],
      role_users: [] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer() })

    const Role = defineModelFromTable(roles)
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })

    const user = await User.findOrFail(1)

    // Use the dynamic method call syntax: user.roles().attach(...)
    const userDynamic = user as typeof user & { roles: () => { attach: (ids: unknown, attrs?: Record<string, unknown>) => Promise<void>, sync: (ids: unknown) => Promise<{ attached: unknown[], detached: unknown[], updated: unknown[] }>, detach: (ids?: unknown) => Promise<number> } }
    await userDynamic.roles().attach([100, 101])
    expect(adapter.tables.role_users).toHaveLength(2)
    expect(adapter.tables.role_users).toContainEqual(expect.objectContaining({ userId: 1, roleId: 100 }))
    expect(adapter.tables.role_users).toContainEqual(expect.objectContaining({ userId: 1, roleId: 101 }))

    const syncResult = await userDynamic.roles().sync([101, 102])
    expect(syncResult.attached).toContain(102)
    expect(syncResult.detached).toContain(100)

    const detached = await userDynamic.roles().detach([101])
    expect(detached).toBe(1)
  })

  it('supports dynamic relation method calls on defineModel(tableName) models with generated schema', async () => {
    const adapter = new RelationAdapter({
      posts: [{ id: 1, title: 'Hello', user_id: 1, category_id: null, slug: 'hello', excerpt: null, body: 'content', status: 'published', published_at: null, created_at: '2026-01-01', updated_at: '2026-01-01' }],
      tags: [
        { id: 10, name: 'framework', slug: 'framework', created_at: '2026-01-01', updated_at: '2026-01-01' },
        { id: 11, name: 'release', slug: 'release', created_at: '2026-01-01', updated_at: '2026-01-01' },
      ],
      post_tags: [] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string(),
      user_id: column.integer(),
      category_id: column.integer().nullable(),
      slug: column.string(),
      excerpt: column.string().nullable(),
      body: column.text(),
      status: column.string(),
      published_at: column.timestamp().nullable(),
      created_at: column.timestamp().defaultNow(),
      updated_at: column.timestamp().defaultNow() })
    const tags = defineTable('tags', {
      id: column.id(),
      name: column.string(),
      slug: column.string(),
      created_at: column.timestamp().defaultNow(),
      updated_at: column.timestamp().defaultNow() })
    const postTags = defineTable('post_tags', {
      id: column.id(),
      post_id: column.integer(),
      tag_id: column.integer() })

    clearGeneratedTables()
    registerGeneratedTables({ posts, tags, post_tags: postTags })

    const Tag = defineModel('tags')
    const Post = defineModel('posts', {
      fillable: ['title', 'slug', 'excerpt', 'body', 'status', 'published_at', 'user_id', 'category_id'],
      relations: {
        tags: belongsToMany(() => Tag, {
          pivotTable: 'post_tags',
          foreignPivotKey: 'post_id',
          relatedPivotKey: 'tag_id',
        }),
      },
    })

    const post = await Post.findOrFail(1)
    const postDynamic = post as typeof post & { tags: () => { attach: (ids: unknown) => Promise<void>, sync: (ids: unknown) => Promise<{ attached: unknown[], detached: unknown[], updated: unknown[] }>, detach: (ids?: unknown) => Promise<number> } }

    await postDynamic.tags().attach([10, 11])
    expect(adapter.tables.post_tags).toHaveLength(2)
    expect(adapter.tables.post_tags).toContainEqual(expect.objectContaining({ post_id: 1, tag_id: 10 }))
    expect(adapter.tables.post_tags).toContainEqual(expect.objectContaining({ post_id: 1, tag_id: 11 }))

    const syncResult = await postDynamic.tags().sync([11])
    expect(syncResult.detached).toContain(10)

    clearGeneratedTables()
  })

  it('supports relation persistence helpers for belongsTo, hasMany, hasOne, and morphMany relations', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
      ],
      posts: [],
      profiles: [],
      images: [] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().nullable(),
      title: column.string() })
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer(),
      bio: column.string() })
    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string().nullable(),
      imageableId: column.integer().nullable(),
      url: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    let Profile: ReturnType<typeof defineModelFromTable<typeof profiles>>
    let Image: ReturnType<typeof defineModelFromTable<typeof images>>

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
        profile: hasOne(() => Profile, 'userId'),
        avatar: morphOne(() => Image, 'imageable', 'imageableType', 'imageableId'),
        images: morphMany(() => Image, 'imageable', 'imageableType', 'imageableId') } })
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })
    Profile = defineModelFromTable(profiles, {
      relations: {
        user: belongsTo(() => User, 'userId') } })
    Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable', 'imageableType', 'imageableId') } })

    const user = await User.findOrFail(1)

    const savedPost = await user.saveRelated('posts', Post.make({ title: 'Draft' }))
    expect(savedPost.get('userId')).toBe(1)
    expect(adapter.tables.posts).toEqual([
      { id: 1, userId: 1, title: 'Draft' },
    ])

    const createdPosts = await user.createManyRelated('posts', [
      { title: 'Second' },
      { title: 'Third' },
    ])
    expect(createdPosts.map(post => post.get('userId'))).toEqual([1, 1])
    expect(adapter.tables.posts?.map(row => row.title)).toEqual(['Draft', 'Second', 'Third'])

    const singleCreatedPost = await user.createManyRelated('posts', [
      { title: 'Fourth' },
    ])
    expect(singleCreatedPost).toHaveLength(1)
    expect(singleCreatedPost[0]?.get('title')).toBe('Fourth')

    const profile = await user.createRelated('profile', { bio: 'Engineer' })
    expect(profile.get('userId')).toBe(1)
    expect((user.getRelation('profile') as Entity | null)?.get('bio')).toBe('Engineer')

    const image = await user.createRelated('images', { url: 'avatar.png' })
    expect(image.get('imageableType')).toBe('User')
    expect(image.get('imageableId')).toBe(1)
    expect(adapter.tables.images).toEqual([
      { id: 1, imageableType: 'User', imageableId: 1, url: 'avatar.png' },
    ])

    const avatar = await user.createRelated('avatar', { url: 'portrait.png' })
    expect(avatar.get('imageableType')).toBe('User')
    expect(avatar.get('imageableId')).toBe(1)
    expect((user.getRelation('avatar') as Entity | null)?.get('url')).toBe('portrait.png')

    const savedImage = await user.saveRelated('images', Image.make({ url: 'banner.png' }))
    expect(savedImage.get('imageableType')).toBe('User')
    expect(savedImage.get('imageableId')).toBe(1)

    const savedAvatar = await user.saveRelated('avatar', Image.make({ url: 'portrait-2.png' }))
    expect(savedAvatar.get('imageableType')).toBe('User')
    expect(savedAvatar.get('imageableId')).toBe(1)

    const persistedImage = await Image.findOrFail(1)
    const morphOwner = await persistedImage.saveRelated('imageable', User.make({ name: 'Walid' }))
    expect(morphOwner.get('name')).toBe('Walid')
    expect(persistedImage.get('imageableType')).toBe('User')
    expect(persistedImage.get('imageableId')).toBe(2)
    persistedImage.dissociate('imageable')
    expect(persistedImage.get('imageableType')).toBeNull()
    expect(persistedImage.get('imageableId')).toBeNull()

    const unsavedPost = Post.make({ title: 'Linked Post' })
    unsavedPost.associate('author', user)
    expect(unsavedPost.get('userId')).toBe(1)
    await unsavedPost.save()
    expect(adapter.tables.posts?.at(-1)?.userId).toBe(1)
    expect(() => Post.make({ title: 'Broken Link' }).associate('author', User.make({ name: 'Unsaved Parent' })))
      .toThrow('Cannot associate relation "author" with an unsaved User.')

    const linkedProfile = await Profile.make({ bio: 'CTO' }).saveRelated('user', user)
    expect(linkedProfile.get('id')).toBe(1)
    const profileRowsForUser = adapter.tables.profiles?.filter(row => row.userId === 1) ?? []
    expect(profileRowsForUser).toEqual([
      { id: 1, userId: 1, bio: 'Engineer' },
      { id: 2, userId: 1, bio: 'CTO' },
    ])

    const savedPosts = await user.saveManyRelated('posts', [
      Post.make({ title: 'Bulk One' }),
      Post.make({ title: 'Bulk Two' }),
    ])
    expect(savedPosts.map(post => post.get('userId'))).toEqual([1, 1])

    const savedAuthor = await Post.make({ title: 'Created Via BelongsTo' }).saveRelated('author', User.make({ name: 'Amina' }))
    expect(savedAuthor.get('name')).toBe('Amina')
    expect(adapter.tables.users?.at(-1)?.name).toBe('Amina')
    expect(adapter.tables.posts?.at(-1)).toEqual({
      id: 8,
      userId: 3,
      title: 'Created Via BelongsTo' })

    const detachedProfile = Profile.make({ bio: 'Detached' })
    const createdOwner = await detachedProfile.createRelated('user', { name: 'Karim' })
    expect(createdOwner.get('name')).toBe('Karim')
    expect(detachedProfile.exists()).toBe(true)
    expect(detachedProfile.get('userId')).toBe(4)

    const persistedPost = await Post.findOrFail(1)
    persistedPost.dissociate('author')
    await persistedPost.save()
    expect(adapter.tables.posts?.find(row => row.id === 1)?.userId).toBeNull()

    await expect(User.make({ name: 'Unsaved' }).createRelated('posts', { title: 'Nope' }))
      .rejects.toThrow(HydrationError)
    expect(() => user.associate('posts', null)).toThrow('does not support association helpers')
    expect(() => persistedImage.associate('imageable', User.make({ name: 'Unsaved Morph' })))
      .toThrow('Cannot associate relation "imageable" with an unsaved User.')
    await expect(image.createRelated('imageable', { name: 'Nope' }))
      .rejects.toThrow('cannot create a morph target without an explicit related model type')
    await expect(user.saveManyRelated('profile', [Profile.make({ bio: 'One' }), Profile.make({ bio: 'Two' })]))
      .rejects.toThrow(SecurityError)
    await expect(user.saveRelated('posts', Profile.make({ bio: 'Mismatch' }) as unknown as TestEntity))
      .rejects.toThrow('Relation "posts" on model "User" expects related model "Post".')
  })

  it('supports pushing unsaved parent and child relations from an entity graph', async () => {
    const adapter = new RelationAdapter({
      users: [],
      posts: [],
      profiles: [] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().nullable(),
      title: column.string() })
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer().nullable(),
      bio: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    let Profile: ReturnType<typeof defineModelFromTable<typeof profiles>>

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
        profile: hasOne(() => Profile, 'userId') } })
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })
    Profile = defineModelFromTable(profiles, {
      relations: {
        user: belongsTo(() => User, 'userId') } })

    const pushedPost = Post.make({ title: 'BelongsTo Push' })
    pushedPost.setRelation('author', User.make({ name: 'Push Author' }))
    await pushedPost.push()

    expect(adapter.tables.users).toEqual([
      { id: 1, name: 'Push Author' },
    ])
    expect(adapter.tables.posts).toEqual([
      { id: 1, userId: 1, title: 'BelongsTo Push' },
    ])
    expect(pushedPost.get('userId')).toBe(1)
    expect((pushedPost.getRelation<Entity>('author')).exists()).toBe(true)

    const pushedUser = User.make({ name: 'Graph Owner' })
    pushedUser.setRelation('profile', Profile.make({ bio: 'Owner Bio' }))
    pushedUser.setRelation('posts', [
      Post.make({ title: 'Graph Child One' }),
      Post.make({ title: 'Graph Child Two' }),
    ])

    await pushedUser.push()

    expect(adapter.tables.users).toEqual([
      { id: 1, name: 'Push Author' },
      { id: 2, name: 'Graph Owner' },
    ])
    expect(adapter.tables.profiles).toEqual([
      { id: 1, userId: 2, bio: 'Owner Bio' },
    ])
    expect(adapter.tables.posts).toEqual([
      { id: 1, userId: 1, title: 'BelongsTo Push' },
      { id: 2, userId: 2, title: 'Graph Child One' },
      { id: 3, userId: 2, title: 'Graph Child Two' },
    ])
    expect((pushedUser.getRelation<Entity>('profile')).get('userId')).toBe(2)
    expect((pushedUser.getRelation<Entity[]>('posts')).map(post => post.get('userId'))).toEqual([2, 2])
  })

  it('supports relation persistence helpers for many-to-many and polymorphic pivot relations', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      roles: [],
      articles: [{ id: 1, title: 'News' }],
      tags: [{ id: 10, name: 'Existing' }],
      role_users: [],
      taggables: [] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer() })
    const articles = defineTable('articles', {
      id: column.id(),
      title: column.string() })
    const tags = defineTable('tags', {
      id: column.id(),
      name: column.string() })
    const taggables = defineTable('taggables', {
      id: column.id(),
      tagId: column.integer(),
      taggableType: column.string(),
      taggableId: column.integer(),
      note: column.string().nullable() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Role: ReturnType<typeof defineModelFromTable<typeof roles>>
    let Article: ReturnType<typeof defineModelFromTable<typeof articles>>
    let Tag: ReturnType<typeof defineModelFromTable<typeof tags>>

    Role = defineModelFromTable(roles)
    User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })
    Tag = defineModelFromTable(tags, {
      relations: {
        articles: morphedByMany(() => Article, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId')
          .withPivot('note') } })
    Article = defineModelFromTable(articles, {
      relations: {
        tags: morphToMany(() => Tag, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId')
          .withPivot('note') } })

    const user = await User.findOrFail(1)
    const savedRole = await user.saveRelated('roles', Role.make({ name: 'Admin' }))
    expect(savedRole.get('id')).toBe(1)
    expect(adapter.tables.roles).toEqual([
      { id: 1, name: 'Admin' },
    ])
    expect(adapter.tables.role_users).toEqual([
      { id: 1, userId: 1, roleId: 1 },
    ])

    const createdRole = await user.createRelated('roles', { name: 'Lead' })
    expect(createdRole.get('id')).toBe(2)
    expect(adapter.tables.role_users).toContainEqual({
      id: 2,
      userId: 1,
      roleId: 2 })

    const createdRoles = await user.createManyRelated('roles', [{ name: 'Editor' }])
    expect(createdRoles).toHaveLength(1)
    expect(adapter.tables.role_users).toContainEqual({
      id: 3,
      userId: 1,
      roleId: 3 })

    const article = await Article.findOrFail(1)
    const createdTag = await article.createRelated('tags', { name: 'Featured' })
    expect(createdTag.get('id')).toBe(11)
    expect(adapter.tables.tags).toEqual([
      { id: 10, name: 'Existing' },
      { id: 11, name: 'Featured' },
    ])
    expect(adapter.tables.taggables).toEqual([
      { id: 1, tagId: 11, taggableType: 'Article', taggableId: 1 },
    ])

    await article.attach('tags', 10, { note: 'manual' })
    expect(adapter.tables.taggables).toContainEqual({
      id: 2,
      tagId: 10,
      taggableType: 'Article',
      taggableId: 1,
      note: 'manual' })

    await article.attach('tags', 10, { note: 'updated' })
    expect(adapter.tables.taggables).toContainEqual({
      id: 2,
      tagId: 10,
      taggableType: 'Article',
      taggableId: 1,
      note: 'updated' })

    const tag = await Tag.findOrFail(10)
    const relatedArticle = await tag.saveRelated('articles', Article.make({ title: 'Analysis' }))
    expect(relatedArticle.get('id')).toBe(2)
    expect(adapter.tables.articles).toContainEqual({
      id: 2,
      title: 'Analysis' })
    expect(adapter.tables.taggables).toContainEqual({
      id: 3,
      tagId: 10,
      taggableType: 'Article',
      taggableId: 2 })

    await tag.attach('articles', 1, { note: 'tagged' })
    expect(adapter.tables.taggables).toContainEqual({
      id: 2,
      tagId: 10,
      taggableType: 'Article',
      taggableId: 1,
      note: 'tagged' })

    await tag.detach('articles', 2)
    expect(adapter.tables.taggables).not.toContainEqual({
      id: 3,
      tagId: 10,
      taggableType: 'Article',
      taggableId: 2 })

    await expect(Article.make({ title: 'Draft' }).attach('tags', 10)).rejects.toThrow(HydrationError)
  })

  it('supports string-key belongsToMany inputs and delete drivers without affected row counts', async () => {
    const adapter = new NullAffectedDeleteAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      roles: [{ id: 'admin', name: 'Admin' }],
      role_users: [{ id: 1, userId: 1, roleId: 'admin' }] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.string().primaryKey(),
      name: column.string() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.string() })

    const Role = defineModelFromTable(roles, {
      primaryKey: 'id' })
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })

    const user = await User.findOrFail(1)
    expect(await user.syncWithoutDetaching('roles', { admin: undefined as never })).toEqual({
      attached: [],
      detached: [],
      updated: [] })
    expect(await user.detach('roles')).toBe(0)
    expect(adapter.tables.role_users).toEqual([])
  })

  it('rejects create helpers on through relations', async () => {
    const adapter = new RelationAdapter({
      countries: [{ id: 1, name: 'Egypt' }],
      users: [{ id: 1, countryId: 1, name: 'Mohamed' }],
      posts: [{ id: 1, userId: 1, title: 'Post A' }] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const countries = defineTable('countries', {
      id: column.id(),
      name: column.string() })
    const users = defineTable('users', {
      id: column.id(),
      countryId: column.integer(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    let Country: ReturnType<typeof defineModelFromTable<typeof countries>>
    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>

    Post = defineModelFromTable(posts)
    User = defineModelFromTable(users)
    Country = defineModelFromTable(countries, {
      name: 'Country',
      relations: {
        posts: hasManyThrough(() => Post, () => User, 'countryId', 'userId') } })

    const country = await Country.findOrFail(1)
    await expect(country.saveRelated('posts', Post.make({ title: 'Nope' }) as unknown as TestEntity)).rejects.toThrow(
      'Relation "posts" on model "Country" does not support save helpers.',
    )
    await expect(country.createRelated('posts', { title: 'Nope' })).rejects.toThrow(
      'Relation "posts" on model "Country" does not support create helpers.',
    )
  })

  it('supports relation existence helpers on the model query builder', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
        { id: 3, name: 'Salma' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Post A' },
        { id: 11, userId: 1, title: 'Post B' },
        { id: 12, userId: 2, title: 'Post C' },
      ],
      profiles: [
        { id: 100, userId: 1, bio: 'Engineer' },
      ],
      roles: [
        { id: 200, name: 'Admin' },
        { id: 201, name: 'Editor' },
      ],
      role_users: [
        { id: 1, userId: 1, roleId: 200 },
        { id: 2, userId: 2, roleId: 201 },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().nullable(),
      title: column.string() })
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer(),
      bio: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string(),
      weight: column.integer() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    let Profile: ReturnType<typeof defineModelFromTable<typeof profiles>>
    const Role = defineModelFromTable(roles)

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
        profile: hasOne(() => Profile, 'userId'),
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })
    Profile = defineModelFromTable(profiles, {
      relations: {
        user: belongsTo(() => User, 'userId') } })

    expect((await User.has('posts').orderBy('id').get()).map(user => user.get('id'))).toEqual([1, 2])
    expect((await User.orHas('posts').orderBy('id').get()).map(user => user.get('id'))).toEqual([1, 2])
    expect((await User.doesntHave('profile').orderBy('id').get()).map(user => user.get('id'))).toEqual([2, 3])
    expect((await User.orDoesntHave('profile').orderBy('id').get()).map(user => user.get('id'))).toEqual([2, 3])
    expect((await User.whereHas('roles', query => query.where('name', 'Admin')).get()).map(user => user.get('id'))).toEqual([1])
    expect((await User.orWhereHas('roles', query => query.where('name', 'Admin')).get()).map(user => user.get('id'))).toEqual([1])
    expect((await User.whereHas('roles', () => {}).orderBy('id').get()).map(user => user.get('id'))).toEqual([1, 2])
    expect((await User.whereHas('roles', query => query.where('name', 'Admin')).orWhereHas(
      'posts',
      query => query.where('title', 'Post C'),
    ).orderBy('id').get()).map(user => user.get('id'))).toEqual([1, 2])
    expect((await User.whereDoesntHave('roles', query => query.where('name', 'Admin')).orderBy('id').get()).map(
      user => user.get('id'),
    )).toEqual([2, 3])
    expect((await User.orWhereDoesntHave('roles', query => query.where('name', 'Admin')).orderBy('id').get()).map(
      user => user.get('id'),
    )).toEqual([2, 3])
    expect((await User.whereHas('roles', query => query.where('name', 'Admin')).orWhereDoesntHave(
      'profile',
    ).orderBy('id').get()).map(user => user.get('id'))).toEqual([1, 2, 3])
    expect((await Post.whereRelation('author', 'name', 'Mohamed').orderBy('id').get()).map(post => post.get('id'))).toEqual([10, 11])
    expect((await Post.orWhereRelation('author', 'name', 'Mohamed').orderBy('id').get()).map(post => post.get('id'))).toEqual([10, 11])
    expect((await Post.whereRelation('author', 'name', 'Mohamed').orWhereRelation(
      'author',
      'name',
      'Amina',
    ).orderBy('id').get()).map(post => post.get('id'))).toEqual([10, 11, 12])
    const detachedUser = User.getRepository().hydrate({ id: null as never, name: 'Ghost' })
    const firstUser = await User.findOrFail(1)
    const secondUser = await User.findOrFail(2)
    expect((await Post.whereBelongsTo(firstUser).orderBy('id').get()).map(post => post.get('id'))).toEqual([10, 11])
    expect((await Post.whereBelongsTo(secondUser, 'author').orderBy('id').get()).map(post => post.get('id'))).toEqual([12])
    expect((await Post.whereBelongsTo(firstUser).orWhereBelongsTo(secondUser).orderBy('id').get()).map(post => post.get('id'))).toEqual([10, 11, 12])
    expect((await Post.orWhereBelongsTo(secondUser, 'author').orderBy('id').get()).map(post => post.get('id'))).toEqual([12])
    expect(await Post.whereBelongsTo(detachedUser as unknown as TestEntity, 'author').orderBy('id').get()).toEqual([])
    expect(await Post.orWhereBelongsTo(detachedUser as unknown as TestEntity, 'author').orderBy('id').get()).toEqual([])
    expect(() => User.whereBelongsTo(firstUser)).toThrow(
      'No belongs-to relation on model "User" matches related model "User".',
    )
    expect(() => User.whereBelongsTo(firstUser, 'posts')).toThrow(
      'Relation "posts" on model "User" is not a belongs-to relation.',
    )

    const auditPosts = defineTable('audit_posts', {
      id: column.id(),
      authorId: column.integer(),
      editorId: column.integer(),
      title: column.string() })
    const AuditPost = defineModelFromTable(auditPosts, {
      relations: {
        author: belongsTo(() => User, 'authorId'),
        editor: belongsTo(() => User, 'editorId') } })
    expect(() => AuditPost.whereBelongsTo(firstUser)).toThrow(
      'Multiple belongs-to relations on model "AuditPost" match related model "User". Specify the relation name explicitly.',
    )
    const auditAuthorQuery = AuditPost.whereBelongsTo(firstUser, 'author').toSQL()
    const auditEditorQuery = AuditPost.whereBelongsTo(secondUser, 'editor').toSQL()
    expect(auditAuthorQuery.sql).toContain('EXISTS (SELECT * FROM "users"')
    expect(auditAuthorQuery.sql).toContain('"id" = "audit_posts"."authorId"')
    expect(auditAuthorQuery.bindings).toEqual([1])
    expect(auditEditorQuery.sql).toContain('EXISTS (SELECT * FROM "users"')
    expect(auditEditorQuery.sql).toContain('"id" = "audit_posts"."editorId"')
    expect(auditEditorQuery.bindings).toEqual([2])
    const reviewPosts = defineTable('review_posts', {
      id: column.id(),
      reviewerId: column.integer(),
      title: column.string() })
    const ReviewPost = defineModelFromTable(reviewPosts, {
      relations: {
        reviewer: belongsTo(() => User.definition, 'reviewerId') } })
    expect((await ReviewPost.whereBelongsTo(firstUser).get())).toEqual([])

    const detachedPost = Post.getRepository().hydrate({ id: 99, userId: null as never, title: 'Orphan' })
    expect(await (Post.getRepository() as unknown as RepositoryRelationHarness).filterByRelations([detachedPost], [{ relation: 'author', negate: false }])).toEqual([])
    expect(await (User.getRepository() as unknown as RepositoryRelationHarness).filterByRelations([detachedUser], [{ relation: 'posts', negate: false }])).toEqual([])
  })

  it('supports eager loading across connections but rejects cross-connection existence filters', async () => {
    const authAdapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ] })
    const contentAdapter = new RelationAdapter({
      posts: [
        { id: 10, userId: 1, title: 'Post A' },
        { id: 11, userId: 1, title: 'Post B' },
        { id: 12, userId: 2, title: 'Post C' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'auth',
      connections: {
        auth: createDatabase({
          connectionName: 'auth',
          adapter: authAdapter,
          dialect: createDialect() }),
        content: createDatabase({
          connectionName: 'content',
          adapter: contentAdapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Post = defineModelFromTable(posts, {
      connectionName: 'content',
      relations: {
        author: belongsTo(() => User, 'userId') } })
    User = defineModelFromTable(users, {
      connectionName: 'auth',
      relations: {
        posts: hasMany(() => Post, 'userId') } })

    const loadedUsers = await User
      .with('posts')
      .withCount('posts')
      .withExists('posts')
      .orderBy('id')
      .get()

    expect(loadedUsers.map(user => user.get('name'))).toEqual(['Mohamed', 'Amina'])
    expect(loadedUsers.map(user => (user.getRelation<TestEntity[]>('posts') ?? []).map(post => post.get('title')))).toEqual([
      ['Post A', 'Post B'],
      ['Post C'],
    ])
    expect(loadedUsers.map(user => (user.toJSON() as JsonRecord).posts_count)).toEqual([2, 1])
    expect(loadedUsers.map(user => (user.toJSON() as JsonRecord).posts_exists)).toEqual([true, true])

    expect(() => User.has('posts')).toThrow(RelationError)
    expect(() => User.has('posts')).toThrow('Cross-connection relation existence queries are not supported')
    expect(() => User.whereHas('posts', query => query.where('title', 'Post A'))).toThrow(RelationError)
    expect(() => Post.whereRelation('author', 'name', 'Mohamed')).toThrow(RelationError)
  })

  it('supports scoped relationships across eager loading and relation existence queries', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
        { id: 3, name: 'Salma' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Published A', published: true },
        { id: 11, userId: 1, title: 'Draft A', published: false },
        { id: 12, userId: 2, title: 'Published B', published: true },
        { id: 13, userId: 3, title: 'Draft C', published: false },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      published: column.boolean() })

    const Post = defineModelFromTable(posts)
    const noopScopedHasMany = Object.freeze({
      ...hasMany(() => Post, 'userId'),
      constraint: () => undefined }) as ReturnType<typeof hasMany>
    const User = defineModelFromTable(users, {
      relations: {
        noopPosts: noopScopedHasMany,
        publishedPosts: scopeRelation(
          scopeRelation(
            hasMany(() => Post, 'userId'),
            () => undefined,
          ),
          query => query.where('published', true),
        ),
        manuallyPublishedPosts: scopeRelation(
          noopScopedHasMany,
          query => query.where('published', true),
        ),
        composedPublishedPosts: scopeRelation(
          scopeRelation(
            hasMany(() => Post, 'userId'),
            query => query.where('published', true),
          ),
          () => undefined,
        ) } })

    const loadedUsers = await User.query()
      .with('noopPosts', 'publishedPosts', 'manuallyPublishedPosts', 'composedPublishedPosts')
      .withCount('publishedPosts')
      .orderBy('id')
      .get()

    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('noopPosts').map(post => post.get('title'))).toEqual(['Published A', 'Draft A'])
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('publishedPosts').map(post => post.get('title'))).toEqual(['Published A'])
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('manuallyPublishedPosts').map(post => post.get('title'))).toEqual(['Published A'])
    expect(loadedUsers[1]?.getRelation<Entity<TableDefinition>[]>('publishedPosts').map(post => post.get('title'))).toEqual(['Published B'])
    expect(loadedUsers[2]?.getRelation<Entity<TableDefinition>[]>('publishedPosts')).toEqual([])
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('composedPublishedPosts').map(post => post.get('title'))).toEqual(['Published A'])
    expect(loadedUsers[0]?.get('publishedPosts_count' as never)).toBe(1)
    expect(loadedUsers[2]?.get('publishedPosts_count' as never)).toBe(0)

    const usersWithPublishedPosts = await User.has('publishedPosts').orderBy('id').pluck('id')
    expect(usersWithPublishedPosts).toEqual([1, 2])
    expect(adapter.queries).toContainEqual({
      sql: 'SELECT * FROM "posts" WHERE "published" = ?1 AND "userId" IN (?2, ?3, ?4)',
      bindings: [1, 1, 2, 3] })
  })

  it('supports dynamic relationships registered on the model statics', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Draft A', published: false },
        { id: 11, userId: 1, title: 'Published A', published: true },
        { id: 12, userId: 2, title: 'Draft B', published: false },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      published: column.boolean() })

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users)

    expect(User.resolveRelationUsing('draftPosts', () => scopeRelation(
      hasMany(() => Post, 'userId'),
      query => query.where('published', false),
    ))).toBe(User)
    User.resolveRelationUsing('allPosts', () => hasMany(() => Post, 'userId'))

    expect(User.getRepository().getRelationDefinition('draftPosts').kind).toBe('hasMany')
    expect(User.getRepository().getRelationDefinition('allPosts').kind).toBe('hasMany')

    User.resolveRelationUsing('allPostsScoped', () => scopeRelation(
      hasMany(() => Post, 'userId'),
      () => undefined,
    ))

    const loadedUsers = await User.query().with('draftPosts', 'allPostsScoped').orderBy('id').get()
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('draftPosts').map(post => post.get('title'))).toEqual(['Draft A'])
    expect(loadedUsers[1]?.getRelation<Entity<TableDefinition>[]>('draftPosts').map(post => post.get('title'))).toEqual(['Draft B'])
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('allPostsScoped').map(post => post.get('title'))).toEqual(['Draft A', 'Published A'])

    const usersWithDrafts = await User.has('draftPosts').orderBy('id').pluck('id')
    expect(usersWithDrafts).toEqual([1, 2])
  })

  it('supports hasOneThrough and hasManyThrough across eager loading, existence helpers, and aggregates', async () => {
    const adapter = new RelationAdapter({
      mechanics: [
        { id: 1, name: 'Mechanic A' },
        { id: 2, name: 'Mechanic B' },
        { id: 3, name: 'Mechanic C' },
        { id: 4, name: 'Mechanic D' },
      ],
      cars: [
        { id: 10, mechanicId: 1, vin: 'VIN-1' },
        { id: 11, mechanicId: 1, vin: 'VIN-2' },
        { id: 12, mechanicId: 2, vin: 'VIN-3' },
        { id: null, mechanicId: 4, vin: 'VIN-4' },
      ],
      owners: [
        { id: 100, carId: 10, name: 'Owner A' },
      ],
      repairs: [
        { id: 200, carId: 10, description: 'Brake job', cost: 100 },
        { id: 201, carId: 11, description: 'Tire swap', cost: 150 },
        { id: 202, carId: 12, description: 'Oil change', cost: 50 },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const mechanics = defineTable('mechanics', {
      id: column.id(),
      name: column.string() })
    const cars = defineTable('cars', {
      id: column.id(),
      mechanicId: column.integer(),
      vin: column.string() })
    const owners = defineTable('owners', {
      id: column.id(),
      carId: column.integer(),
      name: column.string() })
    const repairs = defineTable('repairs', {
      id: column.id(),
      carId: column.integer(),
      description: column.string(),
      cost: column.integer() })

    const Car = defineModelFromTable(cars)
    const Owner = defineModelFromTable(owners)
    const Repair = defineModelFromTable(repairs)
    const Mechanic = defineModelFromTable(mechanics, {
      relations: {
        owner: hasOneThrough(() => Owner, () => Car, 'mechanicId', 'carId'),
        repairs: hasManyThrough(() => Repair, () => Car, 'mechanicId', 'carId') } })

    const eagerLoaded = await Mechanic.with('owner', 'repairs').orderBy('id').get()
    expect(eagerLoaded[0]?.getRelation<Entity<TableDefinition>>('owner')?.get('name')).toBe('Owner A')
    expect((eagerLoaded[0]?.getRelation<Entity<TableDefinition>[]>('repairs') ?? []).map(repair => repair.get('description')).sort()).toEqual(['Brake job', 'Tire swap'])
    expect(eagerLoaded[1]?.getRelation('owner')).toBeNull()
    expect((eagerLoaded[1]?.getRelation<Entity<TableDefinition>[]>('repairs') ?? []).map(repair => repair.get('description'))).toEqual(['Oil change'])
    expect(eagerLoaded[2]?.getRelation('owner')).toBeNull()
    expect(eagerLoaded[2]?.getRelation('repairs')).toEqual([])
    expect(eagerLoaded[3]?.getRelation('owner')).toBeNull()
    expect(eagerLoaded[3]?.getRelation('repairs')).toEqual([])

    expect((await Mechanic.has('repairs').orderBy('id').get()).map(mechanic => mechanic.get('id'))).toEqual([1, 2])
    expect((await Mechanic.whereHas('owner', query => query.where('name', 'Owner A')).get()).map(mechanic => mechanic.get('id'))).toEqual([1])
    expect((await Mechanic.doesntHave('owner').orderBy('id').get()).map(mechanic => mechanic.get('id'))).toEqual([2, 3, 4])
    expect((await Mechanic.whereDoesntHave('repairs', query => query.where('description', 'Brake job')).orderBy('id').get()).map(
      mechanic => mechanic.get('id'),
    )).toEqual([2, 3, 4])

    const aggregated = await Mechanic.withCount('owner', 'repairs')
      .withExists('owner', 'repairs')
      .withSum('repairs', 'cost')
      .orderBy('id')
      .get()
    expect(aggregated.map(mechanic => (mechanic.toJSON() as Record<string, unknown>).owner_count)).toEqual([1, 0, 0, 0])
    expect(aggregated.map(mechanic => (mechanic.toJSON() as Record<string, unknown>).repairs_count)).toEqual([2, 1, 0, 0])
    expect(aggregated.map(mechanic => (mechanic.toJSON() as Record<string, unknown>).owner_exists)).toEqual([true, false, false, false])
    expect(aggregated.map(mechanic => (mechanic.toJSON() as Record<string, unknown>).repairs_exists)).toEqual([true, true, false, false])
    expect(aggregated.map(mechanic => (mechanic.toJSON() as Record<string, unknown>).repairs_sum_cost)).toEqual([250, 50, 0, 0])

    const groupedAggregate = await Mechanic.withCount('repairs').groupBy('id').orderBy('id').get()
    expect(groupedAggregate.map(mechanic => (mechanic.toJSON() as Record<string, unknown>).repairs_count)).toEqual([2, 1, 0, 0])

    const mechanic = await Mechanic.findOrFail(1)
    await mechanic.load('owner', 'repairs')
    await mechanic.loadCount('owner', 'repairs')
    await mechanic.loadExists('owner', 'repairs')
    await mechanic.loadMax('owner', 'id')
    await mechanic.loadSum('repairs', 'cost')
    expect(mechanic.getRelation<Entity<TableDefinition>>('owner')?.get('name')).toBe('Owner A')
    expect((mechanic.getRelation<Entity<TableDefinition>[]>('repairs') ?? []).length).toBe(2)
    expect((mechanic.toJSON() as Record<string, unknown>).owner_count).toBe(1)
    expect((mechanic.toJSON() as Record<string, unknown>).repairs_count).toBe(2)
    expect((mechanic.toJSON() as Record<string, unknown>).owner_exists).toBe(true)
    expect((mechanic.toJSON() as Record<string, unknown>).owner_max_id).toBe(100)
    expect((mechanic.toJSON() as Record<string, unknown>).repairs_exists).toBe(true)
    expect((mechanic.toJSON() as Record<string, unknown>).repairs_sum_cost).toBe(250)

    const detached = Mechanic.getRepository().hydrate({ id: null as never, name: 'Detached' })
    await detached.loadCount('owner', 'repairs')
    await detached.loadExists('owner', 'repairs')
    await detached.loadSum('repairs', 'cost')
    expect((detached.toJSON() as Record<string, unknown>).owner_count).toBe(0)
    expect((detached.toJSON() as Record<string, unknown>).repairs_count).toBe(0)
    expect((detached.toJSON() as Record<string, unknown>).owner_exists).toBe(false)
    expect((detached.toJSON() as Record<string, unknown>).repairs_exists).toBe(false)
    expect((detached.toJSON() as Record<string, unknown>).repairs_sum_cost).toBe(0)

    const noThroughRows = await Mechanic.findOrFail(3)
    await noThroughRows.loadCount('owner')
    expect((noThroughRows.toJSON() as Record<string, unknown>).owner_count).toBe(0)

    const nullSecondLocal = await Mechanic.findOrFail(4)
    await nullSecondLocal.loadCount('owner', 'repairs')
    await nullSecondLocal.loadExists('owner', 'repairs')
    await nullSecondLocal.loadSum('repairs', 'cost')
    expect((nullSecondLocal.toJSON() as Record<string, unknown>).owner_count).toBe(0)
    expect((nullSecondLocal.toJSON() as Record<string, unknown>).repairs_count).toBe(0)
    expect((nullSecondLocal.toJSON() as Record<string, unknown>).owner_exists).toBe(false)
    expect((nullSecondLocal.toJSON() as Record<string, unknown>).repairs_exists).toBe(false)
    expect((nullSecondLocal.toJSON() as Record<string, unknown>).repairs_sum_cost).toBe(0)
  })

  it('supports constrained eager loading and withWhereHas', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Post A' },
        { id: 11, userId: 1, title: 'Post B' },
        { id: 12, userId: 2, title: 'Post C' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Post = defineModelFromTable(posts)

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId') } })

    const usersWithFilteredPosts = await User.with('posts', query => query.where('title', 'Post A')).orderBy('id').get()
    expect(usersWithFilteredPosts[0]?.getRelation<Entity<TableDefinition>[]>('posts').map(post => post.get('title'))).toEqual(['Post A'])
    expect(usersWithFilteredPosts[1]?.getRelation<Entity<TableDefinition>[]>('posts')).toEqual([])

    const usersWithObjectWith = await (User.query().with({
      posts: query => query.where('title', 'Post B') }) as ReturnType<typeof User.query>).orderBy('id').get()
    const objectWithFirstPosts = usersWithObjectWith[0]?.getRelation<Entity<TableDefinition>[]>('posts')
    const objectWithSecondPosts = usersWithObjectWith[1]?.getRelation('posts')
    expect(objectWithFirstPosts?.map(post => post.get('title'))).toEqual(['Post B'])
    expect(objectWithSecondPosts).toEqual([])

    const usersWithStaticObjectWith = await User.with({
      posts: query => query.where('title', 'Post B') }).orderBy('id').get()
    expect(usersWithStaticObjectWith[0]?.getRelation<Entity<TableDefinition>[]>('posts').map(post => post.get('title'))).toEqual(['Post B'])
    expect(usersWithStaticObjectWith[1]?.getRelation('posts')).toEqual([])

    const usersWithWhereHas = await User.withWhereHas('posts', query => query.where('title', 'Post C')).get()
    expect(usersWithWhereHas.map(user => user.get('id'))).toEqual([2])
    expect(usersWithWhereHas[0]?.getRelation<Entity<TableDefinition>[]>('posts').map(post => post.get('title'))).toEqual(['Post C'])

    const usersWithWhereHasNoConstraint = await User.withWhereHas('posts').orderBy('id').get()
    expect(usersWithWhereHasNoConstraint.map(user => user.get('id'))).toEqual([1, 2])
  })

  it('supports one-of-many relations via latestOfMany and oldestOfMany', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
        { id: 3, name: 'Salma' },
        { id: 4, name: 'Youssef' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Post A', score: 1 },
        { id: 11, userId: 1, title: 'Post B', score: 5 },
        { id: 12, userId: 1, title: 'Post C', score: 3 },
        { id: 13, userId: 2, title: 'Post D', score: 2 },
        { id: 14, userId: 2, title: 'Post E', score: 7 },
        { id: 15, userId: 4, title: 'Post F', score: null },
        { id: 16, userId: 4, title: 'Post G', score: 4 },
        { id: 17, userId: 4, title: 'Post H', score: null },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      score: column.integer() })

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        latestPost: latestOfMany(() => Post, 'userId'),
        oldestPost: oldestOfMany(() => Post, 'userId'),
        topScoringPost: latestOfMany(() => Post, 'userId', 'id', 'score') } })

    const loaded = await User.with('latestPost', 'oldestPost', 'topScoringPost').orderBy('id').get()
    expect(loaded[0]?.getRelation<Entity<TableDefinition>>('latestPost')?.get('title')).toBe('Post C')
    expect(loaded[0]?.getRelation<Entity<TableDefinition>>('oldestPost')?.get('title')).toBe('Post A')
    expect(loaded[0]?.getRelation<Entity<TableDefinition>>('topScoringPost')?.get('title')).toBe('Post B')
    expect(loaded[1]?.getRelation<Entity<TableDefinition>>('latestPost')?.get('title')).toBe('Post E')
    expect(loaded[1]?.getRelation<Entity<TableDefinition>>('oldestPost')?.get('title')).toBe('Post D')
    expect(loaded[2]?.getRelation('latestPost')).toBeNull()
    expect(loaded[3]?.getRelation<Entity<TableDefinition>>('latestPost')?.get('title')).toBe('Post H')
    expect(loaded[3]?.getRelation<Entity<TableDefinition>>('oldestPost')?.get('title')).toBe('Post F')
    expect(loaded[3]?.getRelation<Entity<TableDefinition>>('topScoringPost')?.get('title')).toBe('Post G')

    expect((await User.has('latestPost').orderBy('id').get()).map(user => user.get('id'))).toEqual([1, 2, 4])
    expect((await User.whereHas('topScoringPost', query => query.where('id', 'in', [11, 14])).orderBy('id').get()).map(
      user => user.get('id'),
    )).toEqual([1, 2])

    const counted = await User.withCount('latestPost').withExists('latestPost').orderBy('id').get()
    expect(counted.map(user => (user.toJSON() as Record<string, unknown>).latestPost_count)).toEqual([1, 1, 0, 1])
    expect(counted.map(user => (user.toJSON() as Record<string, unknown>).latestPost_exists)).toEqual([true, true, false, true])
  })

  it('supports relation aggregate helpers', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
        { id: 3, name: 'Salma' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Post A', score: 5 },
        { id: 11, userId: 1, title: 'Post B', score: 3 },
        { id: 12, userId: 2, title: 'Post C', score: 4 },
        { id: 13, userId: null, title: 'Orphan', score: 8 },
      ],
      roles: [
        { id: 200, name: 'Admin', weight: 10 },
        { id: 201, name: 'Editor', weight: 20 },
      ],
      role_users: [
        { id: 1, userId: 1, roleId: 200 },
        { id: 2, userId: 1, roleId: 201 },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      score: column.integer() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string(),
      weight: column.integer() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    const Role = defineModelFromTable(roles)

    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })
    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })

    const loaded = await (User.withCount({
      posts: query => query.where('title', 'Post A') }) as ReturnType<typeof User.query>).withExists('roles').orderBy('id').get()

    expect(loaded.map(user => (user.toJSON() as Record<string, unknown>).posts_count)).toEqual([1, 0, 0])
    expect(loaded.map(user => (user.toJSON() as Record<string, unknown>).roles_exists)).toEqual([true, false, false])

    const user = await User.findOrFail(1)
    await user.loadCount('posts')
    await user.loadExists('roles')
    expect((user.toJSON() as Record<string, unknown>).posts_count).toBe(2)
    expect((user.toJSON() as Record<string, unknown>).roles_exists).toBe(true)

    const detachedUser = User.getRepository().hydrate({ id: null as never, name: 'Detached' })
    await detachedUser.loadCount('posts')
    await detachedUser.loadMax('posts', 'score')
    expect((detachedUser.toJSON() as Record<string, unknown>).posts_count).toBe(0)
    expect((detachedUser.toJSON() as Record<string, unknown>).posts_max_score).toBe(null)

    const orphanPost = await Post.findOrFail(13)
    await orphanPost.loadCount('author')
    await orphanPost.loadExists('author')
    expect((orphanPost.toJSON() as Record<string, unknown>).author_count).toBe(0)
    expect((orphanPost.toJSON() as Record<string, unknown>).author_exists).toBe(false)

    const loadedPosts = await Post.withCount('author').withExists('author').orderBy('id').get()
    expect(loadedPosts.map(post => (post.toJSON() as Record<string, unknown>).author_count)).toEqual([1, 1, 1, 0])
    expect(loadedPosts.map(post => (post.toJSON() as Record<string, unknown>).author_exists)).toEqual([true, true, true, false])

    const authorAggregates = await Post.withMin('author', 'id').withMax('author', 'id').orderBy('id').get()
    expect(authorAggregates.map(post => (post.toJSON() as Record<string, unknown>).author_min_id)).toEqual([1, 1, 2, null])
    expect(authorAggregates.map(post => (post.toJSON() as Record<string, unknown>).author_max_id)).toEqual([1, 1, 2, null])

    const existsOnly = await User.withExists('roles').orderBy('id').get()
    expect(existsOnly.map(user => (user.toJSON() as Record<string, unknown>).roles_exists)).toEqual([true, false, false])

    const constrainedExists = await (User.withExists({
      roles: query => query.where('weight', '>', 15) }) as ReturnType<typeof User.query>).orderBy('id').get()
    expect(constrainedExists.map(user => (user.toJSON() as Record<string, unknown>).roles_exists)).toEqual([false, false, false])

    const aggregated = await (User.withSum({
      posts: query => query.where('title', 'Post A') }, 'score') as ReturnType<typeof User.query>)
      .withAvg('posts', 'score')
      .withMin('posts as lowest_post_score', 'score')
      .withMax('roles as heaviest_role_weight', 'weight')
      .orderBy('id')
      .get()

    expect(aggregated.map(user => (user.toJSON() as Record<string, unknown>).posts_sum_score)).toEqual([5, 0, 0])
    expect(aggregated.map(user => (user.toJSON() as Record<string, unknown>).posts_avg_score)).toEqual([4, 4, null])
    expect(aggregated.map(user => (user.toJSON() as Record<string, unknown>).lowest_post_score)).toEqual([3, 4, null])
    expect(aggregated.map(user => (user.toJSON() as Record<string, unknown>).heaviest_role_weight)).toEqual([20, null, null])

    const avgOnly = await User.withAvg('posts', 'score').orderBy('id').get()
    const minOnly = await User.withMin('posts', 'score').orderBy('id').get()
    const maxOnly = await User.withMax('posts', 'score').orderBy('id').get()
    expect(avgOnly.map(user => (user.toJSON() as Record<string, unknown>).posts_avg_score)).toEqual([4, 4, null])
    expect(minOnly.map(user => (user.toJSON() as Record<string, unknown>).posts_min_score)).toEqual([3, 4, null])
    expect(maxOnly.map(user => (user.toJSON() as Record<string, unknown>).posts_max_score)).toEqual([5, 4, null])

    await user.loadSum('posts', 'score')
    await user.loadAvg('posts', 'score')
    await user.loadMin('posts', 'score')
    await user.loadMax('roles', 'weight')
    expect((user.toJSON() as Record<string, unknown>).posts_sum_score).toBe(8)
    expect((user.toJSON() as Record<string, unknown>).posts_avg_score).toBe(4)
    expect((user.toJSON() as Record<string, unknown>).posts_min_score).toBe(3)
    expect((user.toJSON() as Record<string, unknown>).roles_max_weight).toBe(20)

    await orphanPost.loadSum('author', 'id')
    await orphanPost.loadAvg('author', 'id')
    await orphanPost.loadMin('author', 'id')
    await orphanPost.loadMax('author', 'id')
    expect((orphanPost.toJSON() as Record<string, unknown>).author_sum_id).toBe(0)
    expect((orphanPost.toJSON() as Record<string, unknown>).author_avg_id).toBe(null)
    expect((orphanPost.toJSON() as Record<string, unknown>).author_min_id).toBe(null)
    expect((orphanPost.toJSON() as Record<string, unknown>).author_max_id).toBe(null)
  })

  it('handles relation aggregate edge cases for belongsToMany pivots', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      roles: [],
      role_users: [
        { id: 1, userId: 1, roleId: null },
        { id: 2, userId: 2, roleId: 999 },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string(),
      weight: column.integer() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer().nullable() })

    const Role = defineModelFromTable(roles)
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })

    const loaded = await User.withCount('roles').withExists('roles').orderBy('id').get()
    expect(loaded.map(user => (user.toJSON() as Record<string, unknown>).roles_count)).toEqual([0, 0])
    expect(loaded.map(user => (user.toJSON() as Record<string, unknown>).roles_exists)).toEqual([false, false])

    const loadedMax = await User.withMax('roles', 'weight').orderBy('id').get()
    expect(loadedMax.map(user => (user.toJSON() as Record<string, unknown>).roles_max_weight)).toEqual([null, null])

    const detached = User.getRepository().hydrate({ id: null as never, name: 'Detached' })
    await detached.loadCount('roles')
    await detached.loadExists('roles')
    await detached.loadMax('roles', 'weight')
    expect((detached.toJSON() as Record<string, unknown>).roles_count).toBe(0)
    expect((detached.toJSON() as Record<string, unknown>).roles_exists).toBe(false)
    expect((detached.toJSON() as Record<string, unknown>).roles_max_weight).toBe(null)
  })

  it('handles relation aggregate edge cases when belongsToMany pivots contain only null related ids', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      roles: [],
      role_users: [{ id: 1, userId: 1, roleId: null }] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string(),
      weight: column.integer() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer().nullable() })

    const Role = defineModelFromTable(roles)
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })

    const loaded = await User.withCount('roles').withExists('roles').get()
    expect((loaded[0]?.toJSON() as Record<string, unknown>).roles_count).toBe(0)
    expect((loaded[0]?.toJSON() as Record<string, unknown>).roles_exists).toBe(false)

    const loadedMax = await User.withMax('roles', 'weight').get()
    expect((loadedMax[0]?.toJSON() as Record<string, unknown>).roles_max_weight).toBe(null)
  })

  it('handles belongsToMany existence edge cases with null parent and null related IDs', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      roles: [
        { id: 200, name: 'Admin' },
      ],
      role_users: [
        { id: 1, userId: 1, roleId: null },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer().nullable() })

    const Role = defineModelFromTable(roles)
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })

    expect(await User.has('roles').get()).toEqual([])

    const detached = User.getRepository().hydrate({ id: null as never, name: 'Detached' })
    const filtered = await (User.getRepository() as unknown as RepositoryRelationHarness).filterByRelations(
      [detached],
      [{ relation: 'roles', negate: false }],
    )
    expect(filtered).toEqual([])
  })

  it('rejects malformed and unknown relation names', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      posts: [{ id: 10, userId: 1, title: 'Post A' }] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId') } })
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })

    const post = await Post.findOrFail(10)
    await expect(post.load('missing')).rejects.toThrow(SecurityError)
    await expect(post.load('')).rejects.toThrow('Relation names cannot be empty.')
    expect(() => User.withCount('')).toThrow('Aggregate relation names cannot be empty.')
    expect(() => User.withSum('posts as ', 'score')).toThrow('Aggregate relation aliases cannot be empty.')
    await expect(User.withCount('posts.author').get()).rejects.toThrow('Nested relation aggregates are not supported yet.')
    await expect(User.withSum('posts', 'missing').get()).rejects.toThrow(
      'Column "missing" is not defined on related model "Post".',
    )
    await expect(User.withSum('posts', 'title').get()).rejects.toThrow(
      'Relation aggregate "sum" requires numeric values for column "title".',
    )
    await expect(Post.whereRelation('author', 'missing' as never, 'Mohamed').get()).rejects.toThrow(
      'Column "missing" is not defined on table "users".',
    )
    await expect(Post.orWhereRelation('author', 'missing' as never, 'Mohamed').get()).rejects.toThrow(
      'Column "missing" is not defined on table "users".',
    )
    await expect((await User.findOrFail(1)).loadSum('posts', 'missing' as never)).rejects.toThrow(
      'Column "missing" is not defined on related model "Post".',
    )
    await expect((User.getRepository() as unknown as RepositoryRelationHarness).loadRelationAggregates(
      [await User.findOrFail(1)],
      [{ relation: 'posts', kind: 'sum' }],
    )).rejects.toThrow('Relation aggregate "sum" requires a target column.')
    const repo = User.getRepository() as unknown as RepositoryRelationHarness
    const relation = repo.getRelationDefinition('posts')
    const entity = await User.findOrFail(1)
    await expect(repo.getRelationAggregateValues(
      [entity],
      relation,
      { relation: 'posts', kind: 'count' },
    )).rejects.toThrow('Relation aggregate "count" does not require a value pipeline.')
    await expect(repo.getRelationAggregateValues(
      [entity],
      relation,
      { relation: 'posts', kind: 'sum' },
    )).rejects.toThrow('Relation aggregate "sum" requires a target column.')
    await expect(Post.query().with('author.missing').get()).rejects.toThrow(
      'Relation "missing" is not defined on model "User".',
    )
  })

  it('rejects load helpers when the bound repository does not support relation loading', async () => {
    const entity = new (await import('../src')).Entity({} as never, { id: 1 }, true)

    await expect(entity.load('posts')).rejects.toThrow('The bound repository cannot load relations.')
    await expect(entity.loadMissing('posts')).rejects.toThrow('The bound repository cannot load relations.')
    await expect(entity.loadCount('posts')).rejects.toThrow('The bound repository cannot load relation aggregates.')
    await expect(entity.loadExists('posts')).rejects.toThrow('The bound repository cannot load relation aggregates.')
    await expect(entity.loadSum('posts', 'score')).rejects.toThrow('The bound repository cannot load relation aggregates.')
    await expect(entity.loadAvg('posts', 'score')).rejects.toThrow('The bound repository cannot load relation aggregates.')
    await expect(entity.loadMin('posts', 'score')).rejects.toThrow('The bound repository cannot load relation aggregates.')
    await expect(entity.loadMax('posts', 'score')).rejects.toThrow('The bound repository cannot load relation aggregates.')
    expect(() => entity.associate('author', null)).toThrow('The bound repository cannot associate relations.')
    expect(() => entity.dissociate('author')).toThrow('The bound repository cannot dissociate relations.')
    await expect(entity.push()).rejects.toThrow('The bound repository cannot inspect relations for push().')
    await expect(entity.saveRelated('posts', entity as unknown as TestEntity)).rejects.toThrow('The bound repository cannot persist related models.')
    await expect(entity.saveManyRelated('posts', [entity as unknown as TestEntity])).rejects.toThrow('The bound repository cannot persist related models.')
    await expect(entity.createRelated('posts', { title: 'Nope' })).rejects.toThrow('The bound repository cannot create related models.')
    await expect(entity.createManyRelated('posts', [{ title: 'Nope' }])).rejects.toThrow('The bound repository cannot create related models.')
  })

  it('rejects pivot helpers when the bound repository cannot mutate many-to-many relations', async () => {
    const entity = new (await import('../src')).Entity({} as never, { id: 1 }, true)

    await expect(entity.attach('roles', 1)).rejects.toThrow('The bound repository cannot mutate many-to-many relations.')
    await expect(entity.detach('roles', 1)).rejects.toThrow('The bound repository cannot mutate many-to-many relations.')
    await expect(entity.sync('roles', [1])).rejects.toThrow('The bound repository cannot mutate many-to-many relations.')
    await expect(entity.syncWithoutDetaching('roles', [1])).rejects.toThrow(
      'The bound repository cannot mutate many-to-many relations.',
    )
    await expect(entity.updateExistingPivot('roles', 1, {})).rejects.toThrow(
      'The bound repository cannot mutate many-to-many relations.',
    )
    await expect(entity.toggle('roles', [1])).rejects.toThrow('The bound repository cannot mutate many-to-many relations.')
  })

  it('rejects invalid pivot mutation contexts', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      posts: [{ id: 10, userId: 1, title: 'Post A' }],
      roles: [{ id: 100, name: 'Admin' }],
      role_users: [] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    const roleUsers = defineTable('role_users', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer() })

    const Role = defineModelFromTable(roles)
    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>

    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId') } })
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })

    const unsavedUser = User.make({ name: 'Unsaved' })
    await expect(unsavedUser.attach('roles', 100)).rejects.toThrow(
      'Cannot mutate relation "roles" on an unsaved User.',
    )

    const userWithoutParentKey = User.getRepository().hydrate({ id: null as never, name: 'Broken' })
    await expect(userWithoutParentKey.attach('roles', 100)).rejects.toThrow(
      'Cannot mutate relation "roles" without a parent key value.',
    )

    const persistedUser = await User.findOrFail(1)
    await expect(persistedUser.attach('posts', 10)).rejects.toThrow(
      'Relation "posts" on model "User" does not support pivot mutations.',
    )
    await expect(persistedUser.attach('roles', 100, { grantedAt: '2026-01-01' })).rejects.toThrow(
      'Pivot attribute "grantedAt" on relation "roles" must be declared with withPivot(...) before it can be written.',
    )
    await expect(persistedUser.sync('roles', { 100: { userId: 1 } })).rejects.toThrow(
      'Pivot attribute "userId" on relation "roles" is reserved and cannot be set explicitly.',
    )
    await expect(persistedUser.updateExistingPivot('roles', 100, { approved: true })).rejects.toThrow(
      'Pivot attribute "approved" on relation "roles" must be declared with withPivot(...) before it can be written.',
    )
  })

  it('supports polymorphic one-to-one, one-to-many, and morph-to eager loading', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      posts: [
        { id: 10, title: 'Post A' },
      ],
      images: [
        { id: 100, imageableType: 'members', imageableId: 1, url: 'user-a.png' },
        { id: 101, imageableType: 'members', imageableId: 1, url: 'user-b.png' },
        { id: 102, imageableType: 'articles', imageableId: 10, url: 'post-a.png' },
        { id: 103, imageableType: null, imageableId: null, url: 'orphan.png' },
        { id: 104, imageableType: 'members', imageableId: 999, url: 'missing-ref.png' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string() })
    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string(),
      imageableId: column.integer(),
      url: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    const Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable', 'imageableType', 'imageableId') } })

    User = defineModelFromTable(users, {
      morphClass: 'members',
      relations: {
        images: morphMany(() => Image, 'imageable', 'imageableType', 'imageableId'),
        avatar: morphOne(() => Image, 'imageable', 'imageableType', 'imageableId'),
        latestImage: latestMorphOne(() => Image, 'imageable', 'id', 'imageableType', 'imageableId') } })

    Post = defineModelFromTable(posts, {
      morphClass: 'articles',
      relations: {
        images: morphMany(() => Image, 'imageable', 'imageableType', 'imageableId') } })

    const loadedUsers = await User.with('images', 'avatar').orderBy('id').get()
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>[]>('images').map(image => image.get('url'))).toEqual(['user-a.png', 'user-b.png'])
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>>('avatar')?.get('url')).toBe('user-a.png')
    await loadedUsers[0]?.load('latestImage')
    expect(loadedUsers[0]?.getRelation<Entity<TableDefinition>>('latestImage')?.get('url')).toBe('user-b.png')

    const amina = await User.findOrFail(2)
    await amina.load('images', 'avatar')
    expect(amina.getRelation<Entity<TableDefinition>[]>('images')).toEqual([])
    expect(amina.getRelation('avatar')).toBeNull()

    const loadedImages = await Image.with('imageable.images').orderBy('id').get()
    expect(loadedImages[0]?.getRelation<Entity<TableDefinition>>('imageable')?.get('name')).toBe('Mohamed')
    expect(loadedImages[1]?.getRelation<Entity<TableDefinition>>('imageable')?.get('name')).toBe('Mohamed')
    expect(loadedImages[2]?.getRelation<Entity<TableDefinition>>('imageable')?.get('title')).toBe('Post A')
    expect(loadedImages[3]?.getRelation('imageable')).toBeNull()
    expect(loadedImages[4]?.getRelation('imageable')).toBeNull()
    const firstImageableImages = loadedImages[0]?.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>[]>('images')
    const postImageableImages = loadedImages[2]?.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>[]>('images')
    expect(firstImageableImages?.map(image => image.get('url'))).toEqual(['user-a.png', 'user-b.png'])
    expect(postImageableImages?.map(image => image.get('url'))).toEqual(['post-a.png'])

    await loadedImages.loadMorph('imageable', {
      User: 'avatar',
      posts: 'images' })
    expect(loadedImages[0]?.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>>('avatar')?.get('url')).toBe('user-a.png')
    expect(loadedImages[2]?.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>[]>('images')?.map(image => image.get('id'))).toEqual([102])

    const countedUsers = await User
      .withCount('images')
      .withExists('images')
      .withCount('avatar')
      .withCount('latestImage')
      .withExists('avatar')
      .withExists('latestImage')
      .withMax('images', 'id')
      .withMax('avatar', 'id')
      .withMax('latestImage', 'id')
      .orderBy('id')
      .get()
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).images_count)).toEqual([2, 0])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).images_exists)).toEqual([true, false])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).images_max_id)).toEqual([101, null])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).avatar_count)).toEqual([1, 0])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).avatar_exists)).toEqual([true, false])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).avatar_max_id)).toEqual([101, null])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).latestImage_count)).toEqual([1, 0])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).latestImage_exists)).toEqual([true, false])
    expect(countedUsers.map(user => (user.toJSON() as Record<string, unknown>).latestImage_max_id)).toEqual([101, null])
    expect((await User.has('images').get()).map(user => user.get('id'))).toEqual([1])
    expect((await User.has('avatar').get()).map(user => user.get('id'))).toEqual([1])
    expect((await User.has('latestImage').get()).map(user => user.get('id'))).toEqual([1])

    const imageCounts = await Image.withCount('imageable').withExists('imageable').orderBy('id').get()
    expect(imageCounts.map(image => (image.toJSON() as Record<string, unknown>).imageable_count)).toEqual([1, 1, 1, 0, 0])
    expect(imageCounts.map(image => (image.toJSON() as Record<string, unknown>).imageable_exists)).toEqual([true, true, true, false, false])
    expect((await Image.has('imageable').orderBy('id').get()).map(image => image.get('id'))).toEqual([100, 101, 102])

    const unsavedUser = User.make({ name: 'Unsaved' })
    await unsavedUser.load('images')
    expect(unsavedUser.getRelation('images')).toEqual([])

    await expect(Image.withMax('imageable', 'id').get()).rejects.toThrow(
      'Column relation aggregates are not supported for morph-to relations.',
    )

    const memberImages = await Image.query()
      .whereMorphRelation('imageable', ['members', User], 'name', 'Mohamed')
      .orderBy('id')
      .get()
    expect(memberImages.map(image => image.get('id'))).toEqual([100, 101])

    const postImages = await Image.query()
      .whereMorphRelation('imageable', 'posts', 'title', 'Post A')
      .orderBy('id')
      .get()
    expect(postImages.map(image => image.get('id'))).toEqual([102])

    const morphedToString = await Image.query()
      .whereMorphedTo('imageable', 'posts')
      .orderBy('id')
      .get()
    expect(morphedToString.map(image => image.get('id'))).toEqual([102])

    const firstMemberImage = await Image.findOrFail(100)
    await expect(firstMemberImage.loadMorph('imageable', {
      User: 'images',
      posts: 'images' })).resolves.toBe(firstMemberImage)
    const firstMemberImageable = firstMemberImage.getRelation<Entity<TableDefinition>>('imageable')
    expect(firstMemberImageable?.getRelation<Entity<TableDefinition>[]>('images')?.map(image => image.get('id'))).toEqual([100, 101])

    const postImage = await Image.findOrFail(102)
    postImage.setRelation('imageable', [loadedImages[2]?.getRelation<Entity<TableDefinition>>('imageable')].filter(Boolean))
    await postImage.loadMorph('imageable', {
      posts: 'images' })
    const imageableArray = postImage.getRelation<Entity<TableDefinition>[]>('imageable')
    expect(Array.isArray(imageableArray)).toBe(true)
    expect(imageableArray[0]?.getRelation<Entity<TableDefinition>[]>('images')?.map(image => image.get('id'))).toEqual([102])

    const orphanImage = await Image.findOrFail(104)
    await expect(orphanImage.loadMorph('imageable', { posts: 'images' })).resolves.toBe(orphanImage)
    expect(orphanImage.getRelation('imageable')).toBeNull()

    const constrainedMemberImage = await Image.findOrFail(100)
    await constrainedMemberImage.loadMorph('imageable', {
      User: {
        images: query => query.where('id', 100) } })
    expect(constrainedMemberImage.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>[]>('images')?.map(image => image.get('id'))).toEqual([100])

    const arrayMappedImage = await Image.findOrFail(100)
    await arrayMappedImage.loadMorph('imageable', {
      User: ['images', ''] })
    expect(arrayMappedImage.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>[]>('images')?.map(image => image.get('id'))).toEqual([100, 101])

    const unconstrainedObjectImage = await Image.findOrFail(100)
    await unconstrainedObjectImage.loadMorph('imageable', {
      User: {
        images: undefined as never } })
    expect(unconstrainedObjectImage.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>[]>('images')?.map(image => image.get('id'))).toEqual([100, 101])

    const unmappedImage = await Image.findOrFail(100)
    await expect(unmappedImage.loadMorph('imageable', { Tag: 'posts' })).resolves.toBe(unmappedImage)
    expect(unmappedImage.getRelation<Entity<TableDefinition>>('imageable')?.getRelation<Entity<TableDefinition>[]>('posts') ?? []).toEqual([])

    const fallbackTypedImage = await Image.findOrFail(100)
    fallbackTypedImage.set('imageableType' as never, null as never)
    fallbackTypedImage.setRelation('imageable', loadedUsers[0])
    await expect(fallbackTypedImage.loadMorph('imageable', { User: '' })).resolves.toBe(fallbackTypedImage)
    expect(fallbackTypedImage.getRelation<Entity<TableDefinition>>('imageable')?.get('name')).toBe('Mohamed')

    expect(() => Image.query().whereMorphRelation('imageable', '', 'id', 1)).toThrow(
      'Morph type labels cannot be empty.',
    )
    expect(() => Image.query().whereMorphRelation('imageable', 'unknown-morph', 'id', 1)).toThrow(
      'Unknown morph type selector "unknown-morph" on model "Image".',
    )
    expect(() => Image.query().whereMorphRelation('imageable', [{ definition: {} } as unknown as { definition: { morphClass?: string } }], 'id', 1)).toThrow(
      'Morph type selectors on model "Image" must be strings or model references.',
    )

    const morphOrImages = await Image.query()
      .whereMorphRelation('imageable', 'members', 'name', 'Amina')
      .orWhereMorphRelation('imageable', 'posts', 'title', 'Post A')
      .orderBy('id')
      .get()
    expect(morphOrImages.map(image => image.get('id'))).toEqual([102])

    const userEntity = await User.findOrFail(1)
    const postEntity = await Post.findOrFail(10)

    const morphedToUser = await Image.query()
      .whereMorphedTo('imageable', userEntity)
      .orderBy('id')
      .get()
    expect(morphedToUser.map(image => image.get('id'))).toEqual([100, 101])

    const morphedToPostType = await Image.whereMorphedTo('imageable', Post)
      .orderBy('id')
      .get()
    expect(morphedToPostType.map(image => image.get('id'))).toEqual([102])

    const morphedToNull = await Image.query()
      .whereMorphedTo('imageable', null)
      .orderBy('id')
      .get()
    expect(morphedToNull.map(image => image.get('id'))).toEqual([103, 104])

    const notMorphedToUser = await Image.query()
      .whereNotMorphedTo('imageable', userEntity)
      .orderBy('id')
      .get()
    expect(notMorphedToUser.map(image => image.get('id'))).toEqual([102, 103, 104])

    const orMorphedTo = await Image.query()
      .whereMorphedTo('imageable', userEntity)
      .orWhereMorphedTo('imageable', postEntity)
      .orderBy('id')
      .get()
    expect(orMorphedTo.map(image => image.get('id'))).toEqual([100, 101, 102])

    const staticOrMorphedTo = await Image.orWhereMorphedTo('imageable', postEntity)
      .orderBy('id')
      .get()
    expect(staticOrMorphedTo.map(image => image.get('id'))).toEqual([102])

    const orNotMorphedTo = await Image.query()
      .whereMorphedTo('imageable', userEntity)
      .orWhereNotMorphedTo('imageable', userEntity)
      .orderBy('id')
      .get()
    expect(orNotMorphedTo.map(image => image.get('id'))).toEqual([100, 101, 102, 103, 104])

    const staticNotMorphedTo = await Image.whereNotMorphedTo('imageable', 'members')
      .orderBy('id')
      .get()
    expect(staticNotMorphedTo.map(image => image.get('id'))).toEqual([102, 103, 104])

    const staticOrNotMorphedTo = await Image.orWhereNotMorphedTo('imageable', 'members')
      .orderBy('id')
      .get()
    expect(staticOrNotMorphedTo.map(image => image.get('id'))).toEqual([102, 103, 104])

    expect(() => Image.query().whereMorphedTo('imageable', User.make({ name: 'Unsaved' }))).toThrow(
      'whereMorphedTo targets must be persisted entities.',
    )
    const brokenTarget = User.getRepository().hydrate({ id: 9, name: 'Broken' })
    brokenTarget.set('id', undefined as never)
    expect(() => Image.query().whereMorphedTo('imageable', brokenTarget)).toThrow(
      'whereMorphedTo targets must have a defined primary key value.',
    )
    expect(() => Image.query().whereMorphedTo('imageable', { definition: { morphClass: '   ' } })).toThrow(
      'Morph type selectors on model "Image" must be strings or model references.',
    )
    expect(() => Image.query().whereMorphedTo('imageable', 'unknown-morph')).toThrow(
      'Unknown morph type selector "unknown-morph" on model "Image".',
    )
  })

  it('supports polymorphic many-to-many relations', async () => {
    const adapter = new RelationAdapter({
      posts: [
        { id: 10, title: 'Post A' },
        { id: 11, title: 'Post B' },
        { id: 12, title: 'Post C' },
      ],
      tags: [
        { id: 200, name: 'Tech' },
        { id: 201, name: 'Featured' },
        { id: 202, name: 'Ghost' },
        { id: 204, name: 'NullLinked' },
      ],
      taggables: [
        { id: 1, taggableType: 'articles', taggableId: 10, tagId: 200 },
        { id: 2, taggableType: 'articles', taggableId: 10, tagId: 201 },
        { id: 3, taggableType: 'articles', taggableId: 11, tagId: 201 },
        { id: 4, taggableType: 'articles', taggableId: 11, tagId: 999 },
        { id: 5, taggableType: 'articles', taggableId: 999, tagId: 202 },
        { id: 6, taggableType: 'articles', taggableId: 12, tagId: null },
        { id: 4, taggableType: 'members', taggableId: 99, tagId: 200 },
        { id: 7, taggableType: 'articles', taggableId: null, tagId: 204 },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string() })
    const tags = defineTable('tags', {
      id: column.id(),
      name: column.string() })
    const taggables = defineTable('taggables', {
      id: column.id(),
      taggableType: column.string(),
      taggableId: column.integer(),
      tagId: column.integer() })

    let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
    let Tag: ReturnType<typeof defineModelFromTable<typeof tags>>

    Post = defineModelFromTable(posts, {
      morphClass: 'articles',
      relations: {
        tags: morphToMany(() => Tag, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId')
          .wherePivot('taggableType', '=', 'articles')
          .withPivot('id')
          .as('tagging') } })

    Tag = defineModelFromTable(tags, {
      relations: {
        posts: morphedByMany(() => Post, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId') } })

    const loadedPosts = await Post.with('tags').withCount('tags').withExists('tags').withMax('tags', 'id').orderBy('id').get()
    expect(loadedPosts[0]?.getRelation<Entity<TableDefinition>[]>('tags').map(tag => tag.get('name'))).toEqual(['Tech', 'Featured'])
    expect((loadedPosts[0]?.getRelation<Entity<TableDefinition>[]>('tags')[0]?.getRelation('tagging') as JsonRecord | undefined)).toEqual({
      taggableType: 'articles',
      taggableId: 10,
      tagId: 200,
      id: 1 })
    expect(loadedPosts[1]?.getRelation<Entity<TableDefinition>[]>('tags').map(tag => tag.get('name'))).toEqual(['Featured'])
    expect(loadedPosts[2]?.getRelation<Entity<TableDefinition>[]>('tags')).toEqual([])
    expect((loadedPosts[0]?.toJSON() as Record<string, unknown>).tags_count).toBe(2)
    expect((loadedPosts[1]?.toJSON() as Record<string, unknown>).tags_exists).toBe(true)
    expect((loadedPosts[2]?.toJSON() as Record<string, unknown>).tags_count).toBe(0)
    expect((loadedPosts[0]?.toJSON() as Record<string, unknown>).tags_max_id).toBe(201)

    const loadedTags = await Tag.with('posts').withCount('posts').withExists('posts').withMax('posts', 'id').orderBy('id').get()
    expect(loadedTags[0]?.getRelation<Entity<TableDefinition>[]>('posts').map(post => post.get('title'))).toEqual(['Post A'])
    expect(loadedTags[1]?.getRelation<Entity<TableDefinition>[]>('posts').map(post => post.get('title'))).toEqual(['Post A', 'Post B'])
    expect(loadedTags[2]?.getRelation<Entity<TableDefinition>[]>('posts')).toEqual([])
    expect(loadedTags[3]?.getRelation<Entity<TableDefinition>[]>('posts')).toEqual([])
    expect((loadedTags[0]?.toJSON() as Record<string, unknown>).posts_count).toBe(1)
    expect((loadedTags[1]?.toJSON() as Record<string, unknown>).posts_exists).toBe(true)
    expect((loadedTags[0]?.toJSON() as Record<string, unknown>).posts_max_id).toBe(10)
    expect((loadedTags[1]?.toJSON() as Record<string, unknown>).posts_max_id).toBe(11)
    expect((loadedTags[2]?.toJSON() as Record<string, unknown>).posts_max_id).toBeNull()

    expect((await Post.has('tags').orderBy('id').get()).map(post => post.get('id'))).toEqual([10, 11])
    expect((await Tag.has('posts').orderBy('id').get()).map(tag => tag.get('id'))).toEqual([200, 201])

    const nullLinkedPost = await Post.where('id', 12).with('tags').firstOrFail()
    expect(nullLinkedPost.getRelation('tags')).toEqual([])

    const nullLinkedTag = await Tag.where('id', 204).with('posts').firstOrFail()
    expect(nullLinkedTag.getRelation('posts')).toEqual([])

    const unsavedPost = Post.make({ title: 'Unsaved' })
    await unsavedPost.load('tags')
    expect(unsavedPost.getRelation('tags')).toEqual([])

    const unsavedTag = Tag.make({ name: 'Unsaved' })
    await unsavedTag.load('posts')
    expect(unsavedTag.getRelation('posts')).toEqual([])
  })

  it('rejects unknown morph types during morph-to loading', async () => {
    const adapter = new RelationAdapter({
      images: [
        { id: 100, imageableType: 'unknown-type', imageableId: 1, url: 'missing.png' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string(),
      imageableId: column.integer(),
      url: column.string() })

    const Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable', 'imageableType', 'imageableId') } })

    await expect(Image.with('imageable').get()).rejects.toThrow('Morph type "unknown-type" is not registered.')
  })

  it('supports polymorphic one-of-many selection helpers', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      images: [
        { id: 100, imageableType: 'members', imageableId: 1, url: 'rank-null-a.png', rank: null },
        { id: 101, imageableType: 'members', imageableId: 1, url: 'rank-five.png', rank: 5 },
        { id: 103, imageableType: 'members', imageableId: 1, url: 'rank-two.png', rank: 2 },
        { id: 102, imageableType: 'members', imageableId: 1, url: 'rank-null-b.png', rank: null },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string(),
      imageableId: column.integer(),
      url: column.string(),
      rank: column.integer().nullable() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Image = defineModelFromTable(images)

    User = defineModelFromTable(users, {
      morphClass: 'members',
      relations: {
        oldestRankedImage: oldestMorphOne(() => Image, 'imageable', 'rank', 'imageableType', 'imageableId') } })

    const usersWithRelation = await User.with('oldestRankedImage')
      .withCount('oldestRankedImage')
      .withExists('oldestRankedImage')
      .withMin('oldestRankedImage', 'id')
      .orderBy('id')
      .get()

    const user = usersWithRelation[0]!
    const emptyUser = usersWithRelation[1]!

    expect(user.getRelation<Entity<TableDefinition>>('oldestRankedImage')?.get('url')).toBe('rank-two.png')
    expect(emptyUser.getRelation('oldestRankedImage')).toBeNull()
    expect((user.toJSON() as Record<string, unknown>).oldestRankedImage_count).toBe(1)
    expect((user.toJSON() as Record<string, unknown>).oldestRankedImage_exists).toBe(true)
    expect((user.toJSON() as Record<string, unknown>).oldestRankedImage_min_id).toBe(103)
    expect((emptyUser.toJSON() as Record<string, unknown>).oldestRankedImage_count).toBe(0)
    expect((emptyUser.toJSON() as Record<string, unknown>).oldestRankedImage_exists).toBe(false)
    expect((emptyUser.toJSON() as Record<string, unknown>).oldestRankedImage_min_id).toBeNull()
    expect((await User.has('oldestRankedImage').get()).map(entity => entity.get('id'))).toEqual([1])
  })

  it('rejects morph-specific helpers on non-morph relations', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'Post A' },
      ] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, 'userId') } })
    User = defineModelFromTable(users, {})

    expect(() => Post.query().whereMorphRelation('author', 'User', 'name', 'Mohamed')).toThrow(
      'Relation "author" on model "Post" does not support morph relation queries.',
    )

    const post = await Post.findOrFail(10)
    await expect(post.loadMorph('author', { User: 'posts' })).rejects.toThrow(
      'Relation "author" does not support morph loading.',
    )
  })

  it('rejects loadMorph when the bound repository cannot morph-load relations', async () => {
    const entity = new Entity(
      {} as never,
      { id: 1 },
      true,
    )

    await expect(entity.loadMorph('imageable', { User: 'posts' })).rejects.toThrow(
      'The bound repository cannot load morph relations.',
    )
  })

  it('treats empty morph-load batches as a no-op', async () => {
    const adapter = new RelationAdapter({
      images: [] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string(),
      imageableId: column.integer(),
      url: column.string() })

    const Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable') } })

    await expect(Image.getRepository().loadMorphRelations([], 'imageable', { User: 'posts' })).resolves.toBeUndefined()
  })

  it('supports custom pivot models on many-to-many relations', async () => {
    const adapter = new RelationAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      roles: [{ id: 10, name: 'Admin' }],
      roleUsers: [{ id: 100, userId: 1, roleId: 10, approved: 1 }] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string() })
    const roleUsers = defineTable('roleUsers', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer(),
      approved: column.boolean() })

    const Membership = defineModelFromTable(roleUsers, {
      casts: {
        approved: 'boolean' } })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Role = defineModelFromTable(roles)
    User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUsers, 'userId', 'roleId')
          .using(() => Membership)
          .as('membership') } })

    const user = await User.with('roles').findOrFail(1)
    const [role] = user.getRelation<Entity[]>('roles')

    expect(role).toBeDefined()
    expect(role?.get('name')).toBe('Admin')
    expect(role?.getRelation<Entity>('membership')).toBeInstanceOf(Entity)
    expect(role?.getRelation<Entity>('membership').get('approved')).toBe(true)
  })

  it('supports direct entity properties, automatic eager loading, lazy-loading prevention, and quiet relation creation', async () => {
    const adapter = new RelationAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
        { id: 2, name: 'Amina' },
      ],
      posts: [
        { id: 10, userId: 1, title: 'First', published: 1 },
        { id: 11, userId: 1, title: 'Second', published: 0 },
        { id: 12, userId: 2, title: 'Third', published: 1 },
        { id: 13, userId: null, title: 'Orphan', published: 0 },
      ] })
    const calls: string[] = []

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      published: column.boolean() })

    let User: ReturnType<typeof defineModelFromTable<typeof users>>
    const Post = defineModelFromTable(posts, {
      fillable: ['userId', 'title', 'published'],
      casts: {
        published: 'boolean' },
      events: {
        creating: [entity => calls.push(`creating:${String((entity as TestEntity).get('title'))}`)] },
      relations: {
        author: belongsTo(() => User, 'userId') } })
    User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId') } })

    const user = await User.findOrFail(1)
    const dynamicUser = asDynamicEntity(user)
    expect(dynamicUser.name).toBe('Mohamed')
    dynamicUser.name = 'Moe'
    expect(user.get('name')).toBe('Moe')

    const lazyPosts = dynamicUser.posts
    expect(typeof lazyPosts).toBe('function')
    await expect(lazyPosts).resolves.toHaveLength(2)
    expect(Array.isArray(dynamicUser.posts)).toBe(true)
    expect((dynamicUser.posts as Entity<TableDefinition>[])[0]?.get('published')).toBe(true)
    dynamicUser.posts = ['manual']
    expect(user.getRelation('posts')).toEqual(['manual'])

    const post = await Post.findOrFail(10)
    await expect(asDynamicEntity(post).author).resolves.toBeInstanceOf(Entity)
    const orphanPost = await Post.findOrFail(13)
    await expect(asDynamicEntity(orphanPost).author).resolves.toBeNull()

    const StrictUser = defineModelFromTable(users, {
      name: 'StrictUser',
      preventLazyLoading: true,
      relations: {
        posts: hasMany(() => Post, 'userId') } })

    const strictUser = await StrictUser.findOrFail(1)
    await expect(Promise.resolve(asDynamicEntity(strictUser).posts)).rejects.toThrow(
      'Lazy loading relation "posts" is disabled on model "StrictUser".',
    )

    const AutomaticUser = defineModelFromTable(users, {
      name: 'AutomaticUser',
      automaticEagerLoading: true,
      relations: {
        posts: hasMany(() => Post, 'userId') } })
    AutomaticUser.preventLazyLoading(false)
    AutomaticUser.automaticallyEagerLoadRelationships(true)

    const automaticUsers = await AutomaticUser.get()
    const autoLoadA = asDynamicEntity(automaticUsers[0]).posts
    const autoLoadB = asDynamicEntity(automaticUsers[0]).posts
    await expect(autoLoadA).resolves.toHaveLength(2)
    await expect(autoLoadB).resolves.toHaveLength(2)
    expect(automaticUsers[1]?.hasRelation('posts')).toBe(true)
    expect(asDynamicEntity(automaticUsers[1]).posts).toHaveLength(1)

    const ToggledUser = defineModelFromTable(users, {
      name: 'ToggledUser',
      relations: {
        posts: hasMany(() => Post, 'userId') } })
    ToggledUser.automaticallyEagerLoadRelationships(true)
    const toggledUser = ToggledUser.getRepository().hydrate({ id: 2, name: 'Amina' } as never)
    await expect(asDynamicEntity(toggledUser).posts).resolves.toHaveLength(1)

    const parent = await User.findOrFail(1)
    const draft = Post.make({ title: 'Quiet Save', published: true })
    await parent.saveRelatedQuietly('posts', draft)
    await parent.saveManyRelatedQuietly('posts', [
      Post.make({ title: 'Quiet Save 2', published: false }),
    ])
    await parent.createRelatedQuietly('posts', { title: 'Quiet Create', published: true })
    await parent.createManyRelatedQuietly('posts', [
      { title: 'Quiet 1', published: true },
      { title: 'Quiet 2', published: false },
    ])

    expect(calls).toEqual([])
  })

  it('falls back to callable relation properties when the repository does not resolve them', () => {
    const entity = new Entity({
      definition: {
        table: { columns: { save: {}, nickname: {} } },
        relations: { get: { kind: 'hasOne' }, profile: { kind: 'hasOne' } } },
      getRelationNames() {
        return ['get', 'profile']
      } } as never, { id: 1 }, true)

    const dynamicEntity = asDynamicEntity(entity)
    expect(typeof dynamicEntity.save).toBe('function')
    dynamicEntity.nickname = 'Mo'
    expect(entity.get('nickname' as never)).toBe('Mo')
    expect(typeof dynamicEntity.get).toBe('function')
    expect(typeof dynamicEntity.profile).toBe('function')

    dynamicEntity.profile = { id: 9 }
    expect(entity.getRelation('profile')).toEqual({ id: 9 })
  })

  it('rejects quiet related-creation helpers when the repository does not support them', async () => {
    const entity = new Entity({} as never, { id: 1 }, true)
    const related = new Entity({} as never, { id: 2 }, true)

    await expect(entity.saveRelatedQuietly('posts', related)).rejects.toThrow(
      'The bound repository cannot persist related models quietly.',
    )
    await expect(entity.saveManyRelatedQuietly('posts', [related])).rejects.toThrow(
      'The bound repository cannot persist related models quietly.',
    )
    await expect(entity.createRelatedQuietly('posts', {})).rejects.toThrow(
      'The bound repository cannot create related models quietly.',
    )
    await expect(entity.createManyRelatedQuietly('posts', [{}])).rejects.toThrow(
      'The bound repository cannot create related models quietly.',
    )
  })

  it('rejects quiet force-delete helpers when the entity or repository is invalid', async () => {
    const unsaved = new Entity({} as never, { id: 1 }, false)
    await expect(unsaved.forceDeleteQuietly()).rejects.toThrow(
      'Cannot force-delete an entity that has not been persisted yet.',
    )

    const saved = new Entity({} as never, { id: 1 }, true)
    await expect(saved.forceDeleteQuietly()).rejects.toThrow(
      'The bound repository cannot force-delete entities quietly.',
    )
  })

  it('covers quiet delete and restore raw-entity branches', async () => {
    const missingSave = new Entity({} as never, { id: 1 }, true)
    await expect(missingSave.saveQuietly()).rejects.toThrow(
      'The bound repository cannot persist entities quietly.',
    )

    const unsavedDelete = new Entity({} as never, { id: 1 }, false)
    await expect(unsavedDelete.deleteQuietly()).rejects.toThrow(
      'Cannot delete an entity that has not been persisted yet.',
    )

    const missingDelete = new Entity({} as never, { id: 1 }, true)
    await expect(missingDelete.deleteQuietly()).rejects.toThrow(
      'The bound repository cannot delete entities quietly.',
    )

    const deleted = new Entity({
      async deleteEntityQuietly() {} } as never, { id: 1 }, true)
    await deleted.deleteQuietly()
    expect(deleted.exists()).toBe(false)

    const missingRestore = new Entity({} as never, { id: 1 }, true)
    await expect(missingRestore.restoreQuietly()).rejects.toThrow(
      'The bound repository cannot restore entities quietly.',
    )
  })
})
