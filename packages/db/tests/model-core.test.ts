import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  createConnectionManager,
  createDatabase,
  clearGeneratedTables,
  belongsTo,
  defineModel,
  hasOne,
  morphMany,
  morphTo,
  morphToMany,
  morphedByMany,
  registerGeneratedTables,
  resetDB,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
  type ModelCollection,
  type ModelQueryBuilder,
  type TableDefinition } from '../src'
import { registerMorphModel, resolveMorphSelector } from '../src/model/morphRegistry'
import { defineModelFromTable, defineTable } from './support/internal'

type Row = Record<string, unknown>
type TableStore = Record<string, Row[]>
type CounterStore = Record<string, number>
type TestEntity = Entity<TableDefinition>
type DynamicEntity = TestEntity & Record<string, unknown>

function asTestEntity(value: unknown): TestEntity {
  return value as TestEntity
}

function asDynamicEntity(value: unknown): DynamicEntity {
  return value as DynamicEntity
}

function cloneRow(row: Row): Row {
  return { ...row }
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
    case '!=':
      return normalizedLeft !== normalizedRight
    case '>':
      return (left as number | Date) > (value as number | Date)
    case '>=':
      return (left as number | Date) >= (value as number | Date)
    case '<':
      return (left as number | Date) < (value as number | Date)
    case '<=':
      return (left as number | Date) <= (value as number | Date)
    case 'LIKE': {
      const pattern = String(value)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
      return new RegExp(`^${pattern}$`).test(String(left ?? ''))
    }
    default:
      return false
  }
}

function filterRows(sql: string, bindings: readonly unknown[], rows: Row[]): Row[] {
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

    const columnMatch = clause.match(/^"([^"]+)" ([A-Z!=<>]+) "([^"]+)"$/)
    if (columnMatch) {
      const [, leftColumn, operator, rightColumn] = columnMatch
      return applyPredicate(row, leftColumn!, operator!, row[rightColumn!])
    }

    const inMatch = clause.match(/^"([^"]+)" (NOT IN|IN) \((.+)\)$/)
    if (inMatch) {
      const [, column, operator, placeholders] = inMatch
      const values = placeholders!
        .split(', ')
        .map(token => bindings[Number(token.replace('?', '')) - 1])
      const present = values.includes(row[column!])
      return operator === 'IN' ? present : !present
    }

    const betweenMatch = clause.match(/^"([^"]+)" (NOT BETWEEN|BETWEEN) \?(\d+) AND \?(\d+)$/)
    if (betweenMatch) {
      const [, column, operator, leftIndex, rightIndex] = betweenMatch
      const left = bindings[Number(leftIndex) - 1] as number | Date
      const right = bindings[Number(rightIndex) - 1] as number | Date
      const value = row[column!] as number | Date
      const within = value >= left && value <= right
      return operator === 'BETWEEN' ? within : !within
    }

    const match = clause.match(/^"([^"]+)" ([A-Z!=<>]+) \?(\d+)$/)
    if (!match) return true
    const [, column, operator, index] = match
    return applyPredicate(row, column!, operator!, bindings[Number(index) - 1])
  }))
}

function selectColumns(sql: string, rows: Row[]): Row[] {
  const match = sql.match(/^SELECT(?: DISTINCT)? (.+?) FROM /)
  if (!match || match[1] === '*') return rows.map(cloneRow)

  const columns = match[1]!.split(', ').map(part => part.replaceAll('"', ''))
  return rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])))
}

class InMemoryAdapter implements DriverAdapter {
  connected = false
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly executions: Array<{ sql: string, bindings: readonly unknown[] }> = []
  private transactionSnapshots: Array<{ tables: TableStore, counters: CounterStore }> = []

  constructor(
    readonly tables: TableStore,
    private readonly counters: CounterStore,
  ) {}

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
    const tableName = tableMatch?.[1]
    const sourceRows = tableName ? (this.tables[tableName] ?? []) : []
    let rows = filterRows(sql, bindings, sourceRows)

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

    const offsetMatch = sql.match(/ OFFSET (\d+)/)
    if (offsetMatch) {
      rows = rows.slice(Number(offsetMatch[1]))
    }

    const limitMatch = sql.match(/ LIMIT (\d+)/)
    if (limitMatch) {
      rows = rows.slice(0, Number(limitMatch[1]))
    }

    const selected = selectColumns(sql, rows)
    return {
      rows: selected.map(cloneRow) as TRow[],
      rowCount: selected.length }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })

    const insertMatch = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES (.+)$/)
    if (insertMatch) {
      const [, tableName, rawColumns] = insertMatch
      const columns = rawColumns!.split(', ').map(column => column.replaceAll('"', ''))
      const rowCount = (sql.match(/\(/g) ?? []).length - 1
      const rows = this.tables[tableName!] ?? (this.tables[tableName!] = [])
      let bindingIndex = 0
      let lastInsertId: number | undefined

      for (let index = 0; index < rowCount; index += 1) {
        const row = Object.fromEntries(columns.map(column => [column, bindings[bindingIndex++]]))
        if (!('id' in row)) {
          this.counters[tableName!] = (this.counters[tableName!] ?? 0) + 1
          row.id = this.counters[tableName!]
          lastInsertId = row.id as number
        }
        rows.push(row)
      }

      return { affectedRows: rowCount, lastInsertId }
    }

    const updateMatch = sql.match(/^UPDATE "([^"]+)" SET (.+?)( WHERE .+)?$/)
    if (updateMatch) {
      const [, tableName, assignments] = updateMatch
      const rows = filterRows(sql, bindings, this.tables[tableName!] ?? [])
      const columns = assignments!.split(', ').map(part => part.match(/^"([^"]+)"/)![1]!)
      const assignmentValues = bindings.slice(0, columns.length)

      for (const row of rows) {
        columns.forEach((column, index) => {
          row[column] = assignmentValues[index]
        })
      }

      return { affectedRows: rows.length }
    }

    const deleteMatch = sql.match(/^DELETE FROM "([^"]+)"( WHERE .+)?$/)
    if (deleteMatch) {
      const [, tableName] = deleteMatch
      const rows = this.tables[tableName!] ?? []
      const survivors = rows.filter(row => !filterRows(sql, bindings, [row]).length)
      const affectedRows = rows.length - survivors.length
      this.tables[tableName!] = survivors
      return { affectedRows }
    }

    return { affectedRows: 0 }
  }

  async beginTransaction(): Promise<void> {
    this.transactionSnapshots.push({
      tables: Object.fromEntries(
        Object.entries(this.tables).map(([name, rows]) => [name, rows.map(cloneRow)]),
      ),
      counters: { ...this.counters } })
  }

  async commit(): Promise<void> {
    this.transactionSnapshots.pop()
  }

  async rollback(): Promise<void> {
    const snapshot = this.transactionSnapshots.pop()
    if (!snapshot) {
      return
    }

    for (const key of Object.keys(this.tables)) {
      Reflect.deleteProperty(this.tables, key)
    }

    for (const [tableName, rows] of Object.entries(snapshot.tables)) {
      this.tables[tableName] = rows.map(cloneRow)
    }

    for (const key of Object.keys(this.counters)) {
      Reflect.deleteProperty(this.counters, key)
    }

    Object.assign(this.counters, snapshot.counters)
  }

  getTable(name: string): Row[] {
    return (this.tables[name] ?? []).map(cloneRow)
  }
}

class FailingInMemoryAdapter extends InMemoryAdapter {
  failOnExecution?: number
  private executionCount = 0

  override async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executionCount += 1

    if (this.failOnExecution === this.executionCount) {
      throw new Error(`execution failed at ${this.executionCount}`)
    }

    return super.execute(sql, bindings)
  }
}

class LoggingAdapter implements DriverAdapter {
  connected = false
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly executions: Array<{ sql: string, bindings: readonly unknown[] }> = []

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
    return { rows: [] as TRow[], rowCount: 0 }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })
    return { affectedRows: 1, lastInsertId: 9 }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

class NoInsertIdAdapter extends InMemoryAdapter {
  override async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    const result = await super.execute(sql, bindings)
    return { affectedRows: result.affectedRows }
  }
}

function createDialect(name: string): Dialect {
  return {
    name,
    capabilities: {
      returning: false,
      savepoints: true,
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

  it('fails fast when a generated-schema-backed model is defined before the generated schema is imported', () => {
    expect(() => defineModel('missing_users')).toThrow(
      'Model "missing_users" is not present in the generated schema registry. Import your generated schema module and run "holo migrate" to refresh it.',
    )
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

  it('provides model statics, inferred metadata, scopes, and explicit repositories', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
        { id: 2, name: 'Amina', email: 'a@example.com', status: 'inactive' },
      ] }, { users: 2 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'status'],
      guarded: ['id'],
      globalScopes: {
        activeOnly: (query: ModelQueryBuilder<typeof users>) => query.where('status', 'active') },
      scopes: {
        active: (query: ModelQueryBuilder<typeof users>) => query.where('status', 'active'),
        named: (query: ModelQueryBuilder<typeof users>, value: string) => query.where('name', value) } })

    expect(User.definition.name).toBe('User')
    expect(User.definition.primaryKey).toBe('id')
    expect(User.getTableName()).toBe('users')
    expect(User.getConnectionName()).toBeUndefined()
    expect(User.query().getConnectionName()).toBe('default')
    expect((await User.get()).map(user => user.get('name'))).toEqual(['Mohamed'])
    expect(User.newQuery().toSQL()).toEqual(User.query().toSQL())
    expect(User.newModelQuery().toSQL()).toEqual(User.query().toSQL())
    expect(User.newQueryWithoutRelationships().toSQL()).toEqual(User.query().toSQL())
    expect(User.newQueryWithoutScopes().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
    expect(User.newQuery().withoutGlobalScope('activeOnly').toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
    expect(User.newQuery().withoutGlobalScopes().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
    expect(User.newQuery().withoutGlobalScopes(['activeOnly']).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
    expect(User.query().select('id').orderBy('id', 'desc').offset(0).limit(1).toSQL()).toEqual({
      sql: 'SELECT "id" FROM "users" WHERE "status" = ?1 ORDER BY "id" DESC LIMIT 1 OFFSET 0',
      bindings: ['active'],
      source: 'query:select:users' })
    expect(User.newQuery().withoutGlobalScope('activeOnly').where('name', 'Amina').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1',
      bindings: ['Amina'],
      source: 'query:select:users' })

    const active = await User.active().get()
    expect(active).toHaveLength(1)
    expect(active[0]!.toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      email: 'm@example.com',
      status: 'active' })

    expect((await User.named('Amina').first())?.get('email')).toBeUndefined()
    expect((await User.where('name', 'Mohamed').first())?.get('email')).toBe('m@example.com')
    expect((await User.newQuery().withoutGlobalScope('activeOnly').get()).map(user => user.get('name'))).toEqual(['Mohamed', 'Amina'])
    expect((await User.newQuery().withoutGlobalScopes().get()).map(user => user.get('name'))).toEqual(['Mohamed', 'Amina'])
    expect((await User.newQuery().withoutGlobalScopes(['activeOnly']).get()).map(user => user.get('name'))).toEqual(['Mohamed', 'Amina'])
    expect((await User.all()).map(user => user.get('name'))).toEqual(['Mohamed'])
    expect((await User.find(1))?.get('name')).toBe('Mohamed')
    expect(await User.findMany([])).toEqual([])
    expect((await User.findMany([1, 2])).map(user => user.get('name'))).toEqual(['Mohamed'])
    expect((await User.findOrFail(1)).get('name')).toBe('Mohamed')
    expect((await User.first())?.get('name')).toBe('Mohamed')
    expect((await User.firstOrFail()).get('name')).toBe('Mohamed')
    expect((await User.sole()).get('name')).toBe('Mohamed')
    expect((await User.firstWhere('name', 'Mohamed'))?.get('email')).toBe('m@example.com')
    expect(await User.valueOrFail('name')).toBe('Mohamed')
    expect(await User.soleValue('name')).toBe('Mohamed')
    await expect(User.valueOrFail('nickname' as never)).rejects.toThrow('User query returned no value for column "nickname".')
    await expect(User.soleValue('nickname' as never)).rejects.toThrow('User query returned no value for column "nickname".')
    await expect(User.query().findOrFail('Ghost', 'name')).rejects.toThrow(
      'User record not found for key "Ghost" via "name".',
    )
    expect(User.query().withTrashed().toSQL()).toEqual(User.query().toSQL())
    expect(User.query().onlyTrashed().toSQL()).toEqual(User.query().toSQL())
    expect(User.query().withoutTrashed().toSQL()).toEqual(User.query().toSQL())
    await expect(User.findOrFail(999)).rejects.toThrow(ModelNotFoundException)
    await expect(User.where('name', 'Nobody').sole()).rejects.toThrow(
      'User query expected exactly one result but found 0.',
    )
    await expect(User.where('name', 'Nobody').valueOrFail('name')).rejects.toThrow(
      'User query returned no value for column "name".',
    )

    const repo = DB.connection().model(User)
    expect(repo.getConnectionName()).toBe('default')
    expect(repo.getConnection()).toBe(DB.connection())
    expect((await repo.firstOrFail()).get('name')).toBe('Mohamed')
    adapter.tables.users!.push({ id: 3, name: 'Extra', email: 'e@example.com', status: 'active' })
    await expect(User.sole()).rejects.toThrow('User query expected exactly one result but found 2.')
  })

  it('supports distinct, column-comparison, set, and range helpers through model statics', async () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string(),
      minScore: column.integer(),
      maxScore: column.integer() })

    const User = defineModelFromTable(users)

    expect(User
      .distinct()
      .whereIn('status', ['active'])
      .whereNotIn('name', ['Layla'])
      .whereBetween('id', [1, 3])
      .whereNotBetween('id', [4, 8])
      .whereColumn('minScore', '<=', 'maxScore')
      .toSQL()).toEqual({
      sql: 'SELECT DISTINCT * FROM "users" WHERE "status" IN (?1) AND "name" NOT IN (?2) AND "id" BETWEEN ?3 AND ?4 AND "id" NOT BETWEEN ?5 AND ?6 AND "minScore" <= "maxScore"',
      bindings: ['active', 'Layla', 1, 3, 4, 8],
      source: 'query:select:users' })
  })

  it('supports conditional and ordering helpers on model statics and builders', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active', created_at: '2024-01-02T00:00:00.000Z' },
        { id: 2, name: 'Amina', email: 'a@example.com', status: 'inactive', created_at: '2024-01-01T00:00:00.000Z' },
      ] }, { users: 2 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string(),
      bio: column.text(),
      settings: column.json(),
      created_at: column.timestamp() })

    const User = defineModelFromTable(users)

    expect(User.when(true, query => query.where('status', 'active')).latest().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "status" = ?1 ORDER BY "created_at" DESC',
      bindings: ['active'],
      source: 'query:select:users' })

    expect(User.latest().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "created_at" DESC',
      bindings: [],
      source: 'query:select:users' })

    expect(User.unless(true, query => query.where('status', 'active'), query => query.where('status', 'inactive')).oldest().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "status" = ?1 ORDER BY "created_at" ASC',
      bindings: ['inactive'],
      source: 'query:select:users' })

    expect(User.unless(false, query => query.where('status', 'active')).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "status" = ?1',
      bindings: ['active'],
      source: 'query:select:users' })

    expect(User.oldest().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "created_at" ASC',
      bindings: [],
      source: 'query:select:users' })

    expect(User.inRandomOrder().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY RANDOM()',
      bindings: [],
      source: 'query:select:users' })

    expect(User.lockForUpdate().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    const postTable = defineTable('posts', {
      id: column.id(),
      title: column.string(),
      userId: column.integer() })
    const Post = defineModelFromTable(postTable)

    expect(User.whereExists(Post.query().select('id').where('userId', 1)).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE EXISTS (SELECT "id" FROM "posts" WHERE "userId" = ?1)',
      bindings: [1],
      source: 'query:select:users' })

    expect(User.whereSub('id', 'in', Post.query().select('userId').where('title', 'like', 'Hello%')).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" IN (SELECT "userId" FROM "posts" WHERE "title" LIKE ?1)',
      bindings: ['Hello%'],
      source: 'query:select:users' })

    expect(User.join('posts', 'users.id', '=', 'posts.userId').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" INNER JOIN "posts" ON "users"."id" = "posts"."userId"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.query()
      .leftJoin('profiles', 'profiles.userId', '=', 'users.id')
      .rightJoin('teams', 'teams.ownerId', '=', 'users.id')
      .crossJoin('countries')
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" LEFT JOIN "profiles" ON "profiles"."userId" = "users"."id" RIGHT JOIN "teams" ON "teams"."ownerId" = "users"."id" CROSS JOIN "countries"',
      bindings: [],
      source: 'query:select:users' })

    await expect(
      User.join('bad table' as never, 'users.id', '=', 'posts.userId').get(),
    ).rejects.toThrow(SecurityError)

    expect(User
      .select('id', 'name')
      .where('status', 'active')
      .union(Post.select('id', 'title').where('title', 'like', 'Hello%'))
      .toSQL()).toEqual({
      sql: 'SELECT "id", "name" FROM "users" WHERE "status" = ?1 UNION SELECT "id", "title" FROM "posts" WHERE "title" LIKE ?2',
      bindings: ['active', 'Hello%'],
      source: 'query:select:users' })

    expect(User
      .joinSub(Post.select('userId').where('title', 'like', 'Hello%'), 'recent_posts', 'recent_posts.userId', '=', 'users.id')
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" INNER JOIN (SELECT "userId" FROM "posts" WHERE "title" LIKE ?1) AS "recent_posts" ON "recent_posts"."userId" = "users"."id"',
      bindings: ['Hello%'],
      source: 'query:select:users' })

    expect(User.select('name as displayName').toSQL()).toEqual({
      sql: 'SELECT "name" AS "displayName" FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.from('users as u').where('u.id', 1).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" AS "u" WHERE "u"."id" = ?1',
      bindings: [1],
      source: 'query:select:users' })

    expect(User.selectSub(Post.select('title').where('userId', 1).limit(1), 'latestTitle').toSQL()).toEqual({
      sql: 'SELECT (SELECT "title" FROM "posts" WHERE "userId" = ?1 LIMIT 1) AS "latestTitle" FROM "users"',
      bindings: [1],
      source: 'query:select:users' })

    expect(User.reorder('name', 'asc').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "name" ASC',
      bindings: [],
      source: 'query:select:users' })

    expect(User.when(true, () => {}).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.when(false, query => query.where('status', 'active')).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.when(false, query => query.where('status', 'active'), () => {}).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.when(false, query => query.where('status', 'active'), query => query.where('name', 'fallback')).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1',
      bindings: ['fallback'],
      source: 'query:select:users' })

    expect(User.unless(false, () => {}).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.unless(true, query => query.where('status', 'active')).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.where('status', 'active').orWhere('name', 'Amina').orWhereNull('created_at').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "status" = ?1 OR "name" = ?2 OR "created_at" IS NULL',
      bindings: ['active', 'Amina'],
      source: 'query:select:users' })

    expect(User.query()
      .where(query => query.where('status', 'active').orWhere('name', 'Amina'))
      .whereNotNull('created_at')
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("status" = ?1 OR "name" = ?2) AND "created_at" IS NOT NULL',
      bindings: ['active', 'Amina'],
      source: 'query:select:users' })

    expect(User.whereNot(query => query.where('status', 'active').orWhere('name', 'Amina'))
      .orWhereNot(query => query.whereNull('created_at'))
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE NOT ("status" = ?1 OR "name" = ?2) OR NOT ("created_at" IS NULL)',
      bindings: ['active', 'Amina'],
      source: 'query:select:users' })

    expect(User.whereLike('name', 'Mo%').orWhereLike('name', 'Am%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" LIKE ?1 OR "name" LIKE ?2',
      bindings: ['Mo%', 'Am%'],
      source: 'query:select:users' })

    expect(User.whereAny(['name', 'created_at'], 'like', 'Mo%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("name" LIKE ?1 OR "created_at" LIKE ?2)',
      bindings: ['Mo%', 'Mo%'],
      source: 'query:select:users' })

    expect(User.whereAll(['name', 'created_at'], 'like', 'Mo%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("name" LIKE ?1 AND "created_at" LIKE ?2)',
      bindings: ['Mo%', 'Mo%'],
      source: 'query:select:users' })

    expect(User.whereNone(['name', 'created_at'], 'like', 'Mo%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE NOT ("name" LIKE ?1 OR "created_at" LIKE ?2)',
      bindings: ['Mo%', 'Mo%'],
      source: 'query:select:users' })

    expect(User.select('name')
      .groupBy('name')
      .having('count(*)', '>=', 2)
      .havingBetween('count(*)', [2, 5])
      .toSQL()).toEqual({
      sql: 'SELECT "name" FROM "users" GROUP BY "name" HAVING COUNT(*) >= ?1 AND COUNT(*) BETWEEN ?2 AND ?3',
      bindings: [2, 2, 5],
      source: 'query:select:users' })

    expect(User.select('id').addSelect('name').toSQL()).toEqual({
      sql: 'SELECT "id", "name" FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(User.unsafeWhere('"name" = ?1', ['Mohamed']).unsafeOrderBy('"name" DESC', []).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1 ORDER BY "name" DESC',
      bindings: ['Mohamed'],
      source: 'query:select:users',
      unsafe: true })

    expect(User.whereDate('created_at', '2024-01-02')
      .whereMonth('created_at', 1)
      .whereDay('created_at', 2)
      .whereYear('created_at', 2024)
      .whereTime('created_at', '00:00:00')
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE date("created_at") = ?1 AND strftime('%m', "created_at") = ?2 AND strftime('%d', "created_at") = ?3 AND strftime('%Y', "created_at") = ?4 AND time("created_at") = ?5`,
      bindings: ['2024-01-02', 1, 2, 2024, '00:00:00'],
      source: 'query:select:users' })

    expect(User.whereJson('settings->profile->region', 'eu')
      .whereJsonContains('settings->tags', 'beta')
      .whereJsonLength('settings->tags', '>=', 2)
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE json_extract("settings", '$.profile.region') = ?1 AND EXISTS (SELECT 1 FROM json_each(json_extract("settings", '$.tags')) WHERE value = ?2) AND json_array_length(json_extract("settings", '$.tags')) >= ?3`,
      bindings: ['eu', 'beta', 2],
      source: 'query:select:users' })

    const reordered = await User.query()
      .latest()
      .reorder('name', 'desc')
      .get()
    expect(reordered.map(user => user.get('name'))).toEqual(['Mohamed', 'Amina'])
  })

  it('supports aggregate and scalar retrieval helpers on model queries', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', score: 10 },
        { id: 2, name: 'Amina', score: 20 },
        { id: 3, name: 'Salma', score: 30 },
      ] }, { users: 3 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer() })
    const User = defineModelFromTable(users)

    expect(await User.query().count()).toBe(3)
    expect(await User.count()).toBe(3)
    expect(await User.query().exists()).toBe(true)
    expect(await User.exists()).toBe(true)
    expect(await User.query().doesntExist()).toBe(false)
    expect(await User.doesntExist()).toBe(false)
    expect(await User.query().pluck('name')).toEqual(['Mohamed', 'Amina', 'Salma'])
    expect(await User.pluck('name')).toEqual(['Mohamed', 'Amina', 'Salma'])
    expect(await User.query().value('name')).toBe('Mohamed')
    expect(await User.value('name')).toBe('Mohamed')
    expect(await User.query().sum('score')).toBe(60)
    expect(await User.sum('score')).toBe(60)
    expect(await User.query().avg('score')).toBe(20)
    expect(await User.avg('score')).toBe(20)
    expect(await User.query().min('score')).toBe(10)
    expect(await User.min('score')).toBe(10)
    expect(await User.query().max('score')).toBe(30)
    expect(await User.max('score')).toBe(30)

    await expect(User.query().sum('name')).rejects.toThrow(
      'Model aggregate "sum" requires numeric values for column "name".',
    )

    adapter.tables.users = []
    expect(await User.query().count()).toBe(0)
    expect(await User.query().exists()).toBe(false)
    expect(await User.query().doesntExist()).toBe(true)
    expect(await User.query().pluck('name')).toEqual([])
    expect(await User.query().value('name')).toBeUndefined()
    expect(await User.query().sum('score')).toBe(0)
    expect(await User.query().avg('score')).toBeNull()
    expect(await User.query().min('score')).toBeNull()
    expect(await User.query().max('score')).toBeNull()
  })

  it('exposes redacted debug helpers on model queries and statics', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new LoggingAdapter(),
          dialect: createDialect('sqlite'),
          security: {
            redactBindingsInLogs: true } } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const User = defineModelFromTable(users)

    expect(User.where('name', 'Mohamed').debug()).toMatchObject({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1',
      bindings: ['[REDACTED]'],
      source: 'query:select:users',
      connectionName: 'default',
      scope: 'root',
      schedulingMode: 'concurrent',
      metadata: {
        kind: 'select',
        resultMode: 'rows',
        selectedShape: {
          mode: 'all',
          columns: [],
          aggregates: [],
          hasRawSelections: false,
          hasSubqueries: false },
        safety: {
          unsafe: false,
          containsRawSql: false },
        debug: {
          tableName: 'users',
          hasJoins: false,
          hasUnions: false,
          hasGrouping: false,
          hasHaving: false,
          complexity: 2,
          intent: 'read',
          transactionAffinity: 'optional',
          streaming: 'buffered',
          connectionName: 'default',
          scope: 'root',
          schedulingMode: 'concurrent' } } })

    expect(User.debug()).toMatchObject({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users',
      connectionName: 'default',
      scope: 'root',
      schedulingMode: 'concurrent',
      metadata: {
        kind: 'select',
        resultMode: 'rows',
        selectedShape: {
          mode: 'all',
          columns: [],
          aggregates: [],
          hasRawSelections: false,
          hasSubqueries: false },
        safety: {
          unsafe: false,
          containsRawSql: false },
        debug: {
          tableName: 'users',
          hasJoins: false,
          hasUnions: false,
          hasGrouping: false,
          hasHaving: false,
          complexity: 1,
          intent: 'read',
          transactionAffinity: 'optional',
          streaming: 'buffered',
          connectionName: 'default',
          scope: 'root',
          schedulingMode: 'concurrent' } } })
  })

  it('supports nested JSON updates through model queries while enforcing writable JSON roots', async () => {
    const adapter = new LoggingAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      settings: column.json() })

    const User = defineModelFromTable(users, {
      fillable: ['settings'],
      guarded: ['id'] })

    await User.where('id', 1).updateJson('settings->profile->region', 'eu')
    expect(adapter.executions.at(-1)).toEqual({
      sql: `UPDATE "users" SET "settings" = json_set(COALESCE("settings", json('{}')), '$.profile.region', json(?1)) WHERE "id" = ?2`,
      bindings: ['"eu"', 1] })

    await expect(User.where('id', 1).update({
      'settings->profile->region': 'mena' } as Record<string, unknown> as never)).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 9 })

    await expect(User.where('id', 1).updateJson('name->profile', 'eu')).rejects.toThrow(SecurityError)

    const LockedUser = defineModelFromTable(users, {
      fillable: ['name'] })

    await expect(LockedUser.where('id', 1).updateJson('settings->profile->region', 'eu')).rejects.toThrow(SecurityError)
  })

  it('supports model increment and decrement helpers with extra payloads', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', score: 10, active: true },
        { id: 2, name: 'Amina', score: 20, active: true },
        { id: 3, name: 'Layla', score: 30, active: false },
      ] }, { users: 3 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
      active: column.boolean() })
    const User = defineModelFromTable(users, {
      fillable: ['name', 'score', 'active'] })

    const incremented = await User.query().where('active', true).increment('score', 5, { name: 'Boosted' })
    expect(incremented.affectedRows).toBe(2)
    expect(adapter.getTable('users')).toEqual([
      { id: 1, name: 'Boosted', score: 15, active: true },
      { id: 2, name: 'Boosted', score: 25, active: true },
      { id: 3, name: 'Layla', score: 30, active: false },
    ])

    const decremented = await User.decrement('score', 3, { name: 'Lowered' })
    expect(decremented.affectedRows).toBe(3)
    expect(adapter.getTable('users')).toEqual([
      { id: 1, name: 'Lowered', score: 12, active: true },
      { id: 2, name: 'Lowered', score: 22, active: true },
      { id: 3, name: 'Lowered', score: 27, active: false },
    ])

    await expect(User.increment('score', Number.NaN)).rejects.toThrow('valid number')

    const nonNumericAdapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed', score: 'ten' }] }, { users: 1 })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter: nonNumericAdapter,
          dialect: createDialect('sqlite') }) } }))
    const BadUser = defineModelFromTable(users, {
      fillable: ['name', 'score', 'active'] })
    await expect(BadUser.increment('score', 1)).rejects.toThrow('non-numeric column')
  })

  it('supports builder-level upsert on model queries', async () => {
    const adapter = new InMemoryAdapter({
      users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      email: column.string(),
      name: column.string() })
    const User = defineModelFromTable(users, {
      fillable: ['email', 'name'] })

    await User.query().upsert(
      { email: 'm@example.com', name: 'Mohamed' },
      ['email'],
      ['name'],
    )

    expect(adapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "users" ("email", "name") VALUES (?1, ?2) ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"',
      bindings: ['m@example.com', 'Mohamed'] })
  })

  it('supports lazy and cursor iteration on model queries and statics', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', status: 'active' },
        { id: 2, name: 'Amina', status: 'active' },
        { id: 3, name: 'Layla', status: 'inactive' },
      ] }, { users: 3 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string() })

    const User = defineModelFromTable(users)

    const lazyNames: string[] = []
    for await (const user of User.query().orderBy('id').lazy(2)) {
      lazyNames.push(String(user.get('name')))
    }

    const cursorNames: string[] = []
    for await (const user of User.cursor()) {
      cursorNames.push(String(user.get('name')))
    }

    expect(lazyNames).toEqual(['Mohamed', 'Amina', 'Layla'])
    expect(cursorNames).toEqual(['Mohamed', 'Amina', 'Layla'])
    await expect((async () => {
      for await (const _user of User.lazy(0)) {
        void _user
      }
    })()).rejects.toThrow('Chunk size must be a positive integer.')
  })

  it('supports pagination and chunking on model queries and statics', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', email: 'm@example.com' },
        { id: 2, name: 'Amina', email: 'a@example.com' },
        { id: 3, name: 'Salma', email: 's@example.com' },
        { id: 4, name: 'Youssef', email: 'y@example.com' },
        { id: 5, name: 'Nada', email: 'n@example.com' },
      ] }, { users: 5 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string() })
    const User = defineModelFromTable(users, {
      fillable: ['name', 'email'] })

    expect(User.query().orderBy('id').forPage(2, 2).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "id" ASC LIMIT 2 OFFSET 2',
      bindings: [],
      source: 'query:select:users' })
    expect(User.query().orderBy('id').skip(1).take(2).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "id" ASC LIMIT 2 OFFSET 1',
      bindings: [],
      source: 'query:select:users' })

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

    const secondCursorPage = await User.query().orderBy('id').cursorPaginate(2, firstCursorPage.nextCursor)
    expect(secondCursorPage.data.map(user => user.get('name'))).toEqual(['Salma', 'Youssef'])
    expect(secondCursorPage.prevCursor).toBe(firstCursorPage.nextCursor)

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

    const edgeUsers = defineTable('edge_users', {
      id: column.id(),
      name: column.string(),
      rank: column.integer() })
    const EdgeUser = defineModelFromTable(edgeUsers)
    adapter.tables.edge_users = [
      { id: 1, name: 'Equal A', rank: 1 },
      { id: 2, name: 'Null', rank: null },
      { id: 3, name: 'Equal B', rank: 1 },
      { id: 4, name: 'Missing' },
      { id: 5, name: 'Two', rank: 2 },
    ]

    const sortedEdgeChunks: string[][] = []
    await EdgeUser.query().chunkById(10, (rows) => {
      sortedEdgeChunks.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(sortedEdgeChunks).toEqual([['Missing', 'Null', 'Equal A', 'Equal B', 'Two']])

    adapter.tables.edge_users = [
      { id: 10, name: 'Two', rank: 2 },
      { id: 11, name: 'One', rank: 1 },
    ]
    const descendingInputSorted: string[][] = []
    await EdgeUser.query().chunkById(10, (rows) => {
      descendingInputSorted.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(descendingInputSorted).toEqual([['One', 'Two']])

    adapter.tables.edge_users = [
      { id: 1, name: 'Equal A', rank: 1 },
      { id: 2, name: 'Null', rank: null },
      { id: 3, name: 'Equal B', rank: 1 },
      { id: 4, name: 'Missing' },
      { id: 5, name: 'Two', rank: 2 },
    ]
    const descendingChunks: string[][] = []
    await EdgeUser.query().chunkByIdDesc(10, (rows) => {
      descendingChunks.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(descendingChunks).toEqual([['Two', 'Equal A', 'Equal B', 'Null', 'Missing']])

    const stoppedDescendingChunks: string[][] = []
    await EdgeUser.chunkByIdDesc(1, (rows, page) => {
      stoppedDescendingChunks.push(rows.map(user => user.get('name')))
      return page < 2
    }, 'rank')
    expect(stoppedDescendingChunks).toEqual([['Two'], ['Equal A']])

    adapter.tables.edge_users = [
      { id: 20, name: 'Equal A', rank: 1 },
      { id: 21, name: 'Equal B', rank: 1 },
      { id: 22, name: 'Null', rank: null },
      { id: 23, name: 'Missing' },
    ]
    const descendingBranchCoverage: string[][] = []
    await EdgeUser.query().chunkByIdDesc(10, (rows) => {
      descendingBranchCoverage.push(rows.map(user => user.get('name')))
    }, 'rank')
    expect(descendingBranchCoverage).toEqual([['Equal A', 'Equal B', 'Null', 'Missing']])

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

  it('supports first-or-create and batch persistence helpers', async () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

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
    expect(adapter.tables.users!.map(user => user.id)).toEqual([3, 4, 5, 6])
  })

  it('supports custom collections per model', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', email: 'm@example.com' },
        { id: 2, name: 'Amina', email: 'a@example.com' },
      ] }, { users: 2 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string() })

    const User = defineModelFromTable(users, {
      collection(items) {
        const collection = createModelCollection(items) as ReturnType<typeof createModelCollection<typeof users>> & {
          emails(): string[]
        }

        Object.defineProperty(collection, 'emails', {
          value: () => collection.map(user => String(user.get('email'))),
          enumerable: false,
          configurable: true })

        return collection as ModelCollection<typeof users> & { emails(): string[] }
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

  it('forwards advanced static builder helpers through query()', async () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: {
            ...createDialect('postgres'),
            capabilities: {
              ...createDialect('postgres').capabilities,
              lockForUpdate: true,
              sharedLock: true,
              jsonContains: true,
              jsonLength: true } } }) } }))

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      meta: column.json<Record<string, unknown>>().nullable(),
      embedding: column.vector({ dimensions: 3 }).nullable() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer().nullable(),
      title: column.string().nullable(),
      score: column.integer().nullable() })
    const images = defineTable('images', {
      id: column.id(),
      imageableType: column.string().nullable(),
      imageableId: column.integer().nullable(),
      name: column.string().nullable() })

    let Post!: ReturnType<typeof defineModelFromTable<typeof posts>>
    let User!: ReturnType<typeof defineModelFromTable<typeof users>>
    Post = defineModelFromTable(posts, {
      relations: {
        author: belongsTo(() => User, { foreignKey: 'userId', ownerKey: 'id' }) } })

    User = defineModelFromTable(users, {
      relations: {
        posts: hasOne(() => Post, { foreignKey: 'userId', localKey: 'id' }) } })

    const Image = defineModelFromTable(images, {
      relations: {
        imageable: hasOne(() => User, { foreignKey: 'id', localKey: 'imageableId' }) } })

    expect(User.having('count(*)', '>', 1)).toBeTruthy()
    expect(User.havingBetween('sum(id)', [1, 3])).toBeTruthy()
    expect(User.whereDate('name', '2025-01-01')).toBeTruthy()
    expect(User.whereMonth('name', 1)).toBeTruthy()
    expect(User.whereDay('name', 2)).toBeTruthy()
    expect(User.whereYear('name', 2025)).toBeTruthy()
    expect(User.whereTime('name', '12:00:00')).toBeTruthy()
    expect(User.whereJson('meta->enabled', true)).toBeTruthy()
    expect(User.orWhereJson('meta->enabled', true)).toBeTruthy()
    expect(User.whereJsonContains('meta->roles', ['admin'])).toBeTruthy()
    expect(User.orWhereJsonContains('meta->roles', ['admin'])).toBeTruthy()
    expect(User.whereJsonLength('meta->roles', '>', 1)).toBeTruthy()
    expect(User.orWhereJsonLength('meta->roles', '>', 1)).toBeTruthy()
    expect(User.whereFullText('name', 'mohamed')).toBeTruthy()
    expect(User.orWhereFullText(['name'], 'mohamed', { mode: 'boolean' })).toBeTruthy()
    expect(User.whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.5)).toBeTruthy()
    expect(User.orWhereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.5)).toBeTruthy()
    expect(User.latest('id')).toBeTruthy()
    expect(User.oldest('id')).toBeTruthy()
    expect(User.inRandomOrder()).toBeTruthy()
    expect(User.reorder('name', 'desc')).toBeTruthy()
    expect(User.lock('update')).toBeTruthy()
    expect(User.lockForUpdate()).toBeTruthy()
    expect(User.sharedLock()).toBeTruthy()
    expect(User.with('posts')).toBeTruthy()
    expect(User.withCount('posts')).toBeTruthy()
    expect(User.withExists('posts')).toBeTruthy()
    expect(User.withSum('posts', 'score')).toBeTruthy()
    expect(User.withAvg('posts', 'score')).toBeTruthy()
    expect(User.withMin('posts', 'score')).toBeTruthy()
    expect(User.withMax('posts', 'score')).toBeTruthy()
    expect(User.has('posts')).toBeTruthy()
    expect(User.orHas('posts')).toBeTruthy()
    expect(User.whereHas('posts')).toBeTruthy()
    expect(User.orWhereHas('posts')).toBeTruthy()
    expect(User.doesntHave('posts')).toBeTruthy()
    expect(User.orDoesntHave('posts')).toBeTruthy()
    expect(User.whereDoesntHave('posts')).toBeTruthy()
    expect(User.orWhereDoesntHave('posts')).toBeTruthy()
    expect(User.whereRelation('posts', 'title', 'Post')).toBeTruthy()
    expect(User.orWhereRelation('posts', 'title', 'Post')).toBeTruthy()
    expect(User.withWhereHas('posts')).toBeTruthy()
    const relatedUser = new Entity(User.getRepository() as never, { id: 1, name: 'Mohamed' }, true)
    const subquery = User.query()
    const tableSubquery = DB.table(posts).select('userId')

    expect(User.dump()).toBeInstanceOf(Object)
    expect(log).toHaveBeenCalled()
    expect(User.preventLazyLoading()).toBe(User)
    expect(User.preventAccessingMissingAttributes()).toBe(User)
    expect(User.automaticallyEagerLoadRelationships()).toBe(User)
    expect(await User.withoutEvents(() => 'muted')).toBe('muted')
    expect(await User.unguarded(() => User.make({ name: 'unguarded' }).get('name'))).toBe('unguarded')
    expect(User.where((query: ModelQueryBuilder<typeof users>) => query.where('name', 'Mohamed'))).toBeTruthy()
    expect(User.orWhere('name', 'Amina')).toBeTruthy()
    expect(User.orWhere((query: ModelQueryBuilder<typeof users>) => query.where('name', 'Amina'))).toBeTruthy()
    expect(User.whereNot((query: ModelQueryBuilder<typeof users>) => query.where('name', 'Mohamed'))).toBeTruthy()
    expect(User.orWhereNot((query: ModelQueryBuilder<typeof users>) => query.where('name', 'Amina'))).toBeTruthy()
    expect(User.whereExists(subquery)).toBeTruthy()
    expect(User.orWhereExists(subquery)).toBeTruthy()
    expect(User.whereNotExists(subquery)).toBeTruthy()
    expect(User.orWhereNotExists(subquery)).toBeTruthy()
    expect(User.whereSub('id', 'in', subquery)).toBeTruthy()
    expect(User.orWhereSub('id', 'not in', subquery)).toBeTruthy()
    expect(User.whereInSub('id', subquery)).toBeTruthy()
    expect(User.whereNotInSub('id', subquery)).toBeTruthy()
    expect(User.select('id', 'name')).toBeTruthy()
    expect(User.addSelect('name')).toBeTruthy()
    expect(User.withCasts({ name: 'string' })).toBeTruthy()
    expect(User.selectSub(subquery, 'sub_name')).toBeTruthy()
    expect(User.addSelectSub(tableSubquery, 'sub_user_id')).toBeTruthy()
    expect(User.whereNull('meta')).toBeTruthy()
    expect(User.orWhereNull('meta')).toBeTruthy()
    expect(User.whereNotNull('name')).toBeTruthy()
    expect(User.orWhereNotNull('name')).toBeTruthy()
    expect(User.when(true, (query: ModelQueryBuilder<typeof users>) => query.where('name', 'Mohamed'))).toBeTruthy()
    expect(User.unless(false, (query: ModelQueryBuilder<typeof users>) => query.where('name', 'Mohamed'))).toBeTruthy()
    expect(User.distinct()).toBeTruthy()
    expect(User.whereColumn('id', '>=', 'id')).toBeTruthy()
    expect(User.whereIn('id', [1, 2])).toBeTruthy()
    expect(User.whereNotIn('id', [3, 4])).toBeTruthy()
    expect(User.whereBetween('id', [1, 2])).toBeTruthy()
    expect(User.whereNotBetween('id', [3, 4])).toBeTruthy()
    expect(User.whereLike('name', 'Mo%')).toBeTruthy()
    expect(User.orWhereLike('name', 'Am%')).toBeTruthy()
    expect(User.whereAny(['name'], 'like', 'Mo%')).toBeTruthy()
    expect(User.whereAll(['name'], 'like', 'Mo%')).toBeTruthy()
    expect(User.whereNone(['name'], 'like', 'Mo%')).toBeTruthy()
    expect(User.join('posts', 'users.id', '=', 'posts.userId')).toBeTruthy()
    expect(User.leftJoin('posts', 'users.id', '=', 'posts.userId')).toBeTruthy()
    expect(User.rightJoin('posts', 'users.id', '=', 'posts.userId')).toBeTruthy()
    expect(User.crossJoin('posts')).toBeTruthy()
    expect(User.joinSub(subquery, 'p', 'users.id', '=', 'p.id')).toBeTruthy()
    expect(User.leftJoinSub(subquery, 'p', 'users.id', '=', 'p.id')).toBeTruthy()
    expect(User.rightJoinSub(subquery, 'p', 'users.id', '=', 'p.id')).toBeTruthy()
    expect(User.joinLateral(subquery, 'lp')).toBeTruthy()
    expect(User.leftJoinLateral(subquery, 'lp')).toBeTruthy()
    expect(User.union(subquery)).toBeTruthy()
    expect(User.unionAll(subquery)).toBeTruthy()
    expect(User.groupBy('id')).toBeTruthy()
    expect(Post.whereBelongsTo(relatedUser as never, 'author')).toBeTruthy()
    expect(Post.orWhereBelongsTo(relatedUser as never, 'author')).toBeTruthy()
  })

  it('treats empty whereNot and orWhereNot callbacks as no-ops', () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const User = defineModelFromTable(users, {})

    const base = User.query()
    expect(base.where(() => {}).toSQL()).toEqual(base.toSQL())
    expect(base.orWhere(() => {}).toSQL()).toEqual(base.toSQL())
    expect(base.whereNot(() => {}).toSQL()).toEqual(base.toSQL())
    expect(base.orWhereNot(() => {}).toSQL()).toEqual(base.toSQL())
  })

  it('supports array-form model upserts and relation date serialization', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed' },
      ] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      email: column.string().unique(),
      name: column.string(),
      seenAt: column.timestamp().nullable() })
    const User = defineModelFromTable(users, {
      fillable: ['email', 'name', 'seenAt'],
      serializeDate: value => `date:${value.toISOString()}` })

    await User.query().upsert([
      { email: 'm@example.com', name: 'Updated' } as never,
      { email: 'a@example.com', name: 'Created' } as never,
    ], ['email'], ['name'])
    expect(adapter.executions.at(-1)?.sql).toContain('ON CONFLICT')

    const user = await User.findOrFail(1)
    user.setRelation('lastSeenAt', new Date('2025-01-02T03:04:05.000Z') as never)
    expect(user.toJSON()).toMatchObject({
      lastSeenAt: 'date:2025-01-02T03:04:05.000Z' })
  })

  it('rejects nested JSON updates on non-JSON model columns', async () => {
    const adapter = new InMemoryAdapter({ users: [{ id: 1, name: 'Mohamed' }] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const User = defineModelFromTable(users, {
      fillable: ['name'] })

    await expect(User.query().update({ 'name->first': 'Mo' } as never)).rejects.toThrow(
      'Column "name" must be a JSON column to support nested JSON updates.',
    )
  })

  it('supports model pruning and mass pruning', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', status: 'active' },
        { id: 2, name: 'Amina', status: 'inactive' },
        { id: 3, name: 'Salma', status: 'inactive' },
      ],
      logs: [
        { id: 1, level: 'info' },
        { id: 2, level: 'debug' },
        { id: 3, level: 'debug' },
      ] }, { users: 3, logs: 3 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string() })
    const logs = defineTable('logs', {
      id: column.id(),
      level: column.string() })

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
    expect(adapter.tables.users!).toEqual([
      { id: 1, name: 'Mohamed', status: 'active' },
    ])

    expect(await Log.prune()).toBe(2)
    expect(adapter.tables.logs!).toEqual([
      { id: 1, level: 'info' },
    ])
  })

  it('supports soft-delete pruning and raw serialization fallback entities', async () => {
    const adapter = new InMemoryAdapter({
      logs: [
        { id: 1, level: 'debug', deleted_at: '2025-01-01T00:00:00.000Z' },
      ] }, { logs: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const logs = defineTable('logs', {
      id: column.id(),
      level: column.string(),
      deleted_at: column.timestamp().nullable() })

    const Log = defineModelFromTable(logs, {
      fillable: ['level', 'deleted_at'],
      softDeletes: true,
      prunable: query => query.where('level', 'debug'),
      serializeDate: value => `date:${value.toISOString()}` })

    expect(await Log.prune()).toBe(1)

    const repo = Log.getRepository()
    const raw = repo.serializeEntity({
      toAttributes() {
        return { id: 7, level: 'info' }
      },
      getLoadedRelations() {
        return { touchedAt: new Date('2025-01-02T03:04:05.000Z') }
      } } as never)
    expect(raw).toEqual({
      id: 7,
      level: 'info',
      touchedAt: 'date:2025-01-02T03:04:05.000Z' })

    const hiddenVisible = repo.serializeEntity({
      getSerializationConfig() {
        return {
          hidden: new Set(['secretRelation']),
          visible: new Set<string>(),
          visibleOnly: ['id', 'visibleRelation'],
          appended: null }
      },
      toAttributes() {
        return { id: 8, level: 'warn' }
      },
      getLoadedRelations() {
        return {
          secretRelation: 'skip-hidden',
          visibleRelation: 'keep-visible',
          omittedRelation: 'skip-visible-only' }
      } } as never)
    expect(hiddenVisible).toEqual({
      id: 8,
      visibleRelation: 'keep-visible' })

    const visibleAppendedOnly = repo.serializeEntity({
      getSerializationConfig() {
        return {
          hidden: new Set<string>(),
          visible: new Set<string>(),
          visibleOnly: ['id'],
          appended: ['computed'] }
      },
      toAttributes() {
        return { id: 9, computed: 'skip-appended' }
      },
      getLoadedRelations() {
        return {}
      } } as never)
    expect(visibleAppendedOnly).toEqual({
      id: 9 })
  })

  it('falls back to the base prune query and rowCount return values for mass pruning', async () => {
    class RowCountAdapter extends InMemoryAdapter {
      override async execute(sql: string, bindings: readonly unknown[] = []): Promise<DriverExecutionResult> {
        await super.execute(sql, bindings)
        return { affectedRows: 2 } as DriverExecutionResult
      }
    }

    const adapter = new RowCountAdapter({
      logs: [
        { id: 1, level: 'debug' },
        { id: 2, level: 'debug' },
      ] }, { logs: 2 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const logs = defineTable('logs', {
      id: column.id(),
      level: column.string() })

    const Log = defineModelFromTable(logs, {
      massPrunable: true,
      prunable: () => undefined })

    expect(await Log.prune()).toBe(2)
  })

  it('falls back to zero when a mass prune delete result reports no counters', async () => {
    class EmptyDeleteAdapter extends InMemoryAdapter {
      override async execute(sql: string, bindings: readonly unknown[] = []): Promise<DriverExecutionResult> {
        await super.execute(sql, bindings)
        return {}
      }
    }

    const adapter = new EmptyDeleteAdapter({
      logs: [
        { id: 1, level: 'debug' },
      ] }, { logs: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const logs = defineTable('logs', {
      id: column.id(),
      level: column.string() })

    const Log = defineModelFromTable(logs, {
      massPrunable: true,
      prunable: query => query.where('level', 'debug') })

    expect(await Log.prune()).toBe(0)
  })

  it('rejects prune calls when a model does not define a prunable query', async () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const User = defineModelFromTable(users)
    await expect(User.prune()).rejects.toThrow('Model "User" does not define a prunable query.')
  })

  it('rejects malformed pagination inputs on model queries', async () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
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
    const adapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed' }] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
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
          dialect: createDialect('sqlite'),
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
    const defaultAdapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Default', email: 'd@example.com', status: 'active' }] }, { users: 1 })
    const analyticsAdapter = new InMemoryAdapter({
      users: [{ id: 7, name: 'Analytics', email: 'a@example.com', status: 'active' }] }, { users: 7 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter: defaultAdapter,
          dialect: createDialect('sqlite') }),
        analytics: createDatabase({
          connectionName: 'analytics',
          adapter: analyticsAdapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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

    const adapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      profiles: [{ id: 10, userId: 1, bio: 'Engineer' }] }, { users: 1, profiles: 10 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const user = await User.query().with('profile').findOrFail(1)
    expect(user.get('name')).toBe('Mohamed')
    expect(user.getRelation<Entity<TableDefinition>>('profile')?.get('bio')).toBe('Engineer')

    const profile = await Profile.query().with('user').findOrFail(10)
    expect(profile.getRelation<Entity<TableDefinition>>('user')?.get('name')).toBe('Mohamed')
  })

  it('binds repositories and entities created inside a transaction to the transaction context', async () => {
    const adapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' }] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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

      expect(adapter.getTable('users')).toEqual([
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
        { id: 2, name: 'Amina', email: 'a@example.com', status: 'inactive' },
      ])
    })
  })

  it('reuses the active transaction for model writes inside DB.transaction', async () => {
    class CountingTransactionAdapter extends InMemoryAdapter {
      beginCalls = 0
      commitCalls = 0
      rollbackCalls = 0

      override async beginTransaction(): Promise<void> {
        this.beginCalls += 1
        await super.beginTransaction()
      }

      override async commit(): Promise<void> {
        this.commitCalls += 1
        await super.commit()
      }

      override async rollback(): Promise<void> {
        this.rollbackCalls += 1
        await super.rollback()
      }
    }

    const adapter = new CountingTransactionAdapter({
      users: [{ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' }] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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

    expect(adapter.beginCalls).toBe(1)
    expect(adapter.commitCalls).toBe(1)
    expect(adapter.rollbackCalls).toBe(0)
    expect(adapter.getTable('users')).toEqual([
      { id: 2, name: 'Amina', email: 'a@example.com', status: 'active' },
    ])
  })

  it('mirrors full-text helpers on model statics for supporting dialects', () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', bio: 'Builder and architect' },
      ] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('postgres') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      bio: column.text() })

    const User = defineModelFromTable(users)

    expect(User.whereFullText(['name', 'bio'], 'mohamed').toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE to_tsvector(concat_ws(' ', "name", "bio")) @@ websearch_to_tsquery(?1)`,
      bindings: ['mohamed'],
      source: 'query:select:users' })
  })

  it('mirrors vector similarity helpers on model statics for supporting dialects', () => {
    const adapter = new InMemoryAdapter({
      documents: [
        { id: 1, title: 'Doc', embedding: [0.1, 0.2, 0.3] },
      ] }, { documents: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('postgres') }) } }))

    const documents = defineTable('documents', {
      id: column.id(),
      title: column.string(),
      embedding: column.vector({ dimensions: 3 }) })

    const Document = defineModelFromTable(documents)

    expect(Document.whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.4).toSQL()).toEqual({
      sql: 'SELECT * FROM "documents" WHERE "embedding" <=> CAST(?1 AS vector) <= ?2 ORDER BY "embedding" <=> CAST(?3 AS vector) ASC',
      bindings: ['[0.1,0.2,0.3]', 0.6, '[0.1,0.2,0.3]'],
      source: 'query:select:documents' })
  })

  it('enforces fillable and guarded rules during create and update flows', async () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email'],
      guarded: ['status'] })
    const OpenUser = defineModelFromTable(users)
    const WildcardUser = defineModelFromTable(users, {
      fillable: ['*'],
      guarded: ['status'] })
    const ExplicitlyEmptyUser = defineModelFromTable(users, {
      fillable: [] })
    const LockedUser = defineModelFromTable(users, {
      guarded: ['*'] })

    const created = await User.create({ name: 'Sara', email: 's@example.com' })
    expect(created.toJSON()).toEqual({ id: 1, name: 'Sara', email: 's@example.com' })
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
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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
    expect(user.wasChanged()).toBe(true)
    expect(user.wasChanged('name')).toBe(true)
    expect(user.getChanges()).toEqual({ name: 'Zein', email: 'z@example.com', status: 'active' })
    expect((await user.fresh())?.get('status')).toBe('active')

    user.set('status', 'inactive')
    expect(user.isDirty('status')).toBe(true)
    expect(user.getDirty()).toEqual({ status: 'inactive' })
    user.syncChanges()
    expect(user.getChanges()).toEqual({ status: 'inactive' })

    await user.save()
    expect(adapter.executions[1]).toEqual({
      sql: 'UPDATE "users" SET "status" = ?1 WHERE "id" = ?2',
      bindings: ['inactive', 1] })
    expect(user.wasChanged('status')).toBe(true)
    expect(user.getChanges()).toEqual({ status: 'inactive' })

    const executionCount = adapter.executions.length
    await user.save()
    expect(adapter.executions).toHaveLength(executionCount)
    expect(user.getChanges()).toEqual({})

    adapter.tables.users![0]!.status = 'server-updated'
    await user.refresh()
    expect(user.get('status')).toBe('server-updated')
    expect(user.wasChanged()).toBe(false)

    await user.delete()
    expect(user.exists()).toBe(false)
    await expect(user.delete()).rejects.toThrow('Cannot delete an entity that has not been persisted yet.')

    const repo = User.getRepository()
    const brokenDelete = repo.hydrate({ id: 2, name: 'Ghost', email: 'g@example.com', status: 'active' })
    brokenDelete.set('id', undefined as never)
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
      deleted_at: column.timestamp() })
    const SoftUser = defineModelFromTable(softDeletes, {
      fillable: ['name'],
      softDeletes: true })
    const softRepo = SoftUser.getRepository()
    const softEntity = softRepo.hydrate({ id: 1, name: 'Soft', deleted_at: '2025-01-01T00:00:00.000Z' as never })
    await expect(softRepo.freshEntity(softEntity)).resolves.toBeUndefined()
  })

  it('supports soft deletes, trashed scopes, and restore flows', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Alive', deleted_at: null },
        { id: 2, name: 'Gone', deleted_at: '2025-01-01T00:00:00.000Z' },
      ] }, { users: 2 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp() })

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
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Already Trashed', deleted_at: '2025-01-01T00:00:00.000Z' },
        { id: 2, name: 'Entity Victim', deleted_at: null },
        { id: 3, name: 'Builder Victim', deleted_at: null },
      ] }, { users: 3 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp() })

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
    const adapter = new InMemoryAdapter({
      posts: [{
        id: 1,
        publicId: 'public-old',
        name: 'Original',
        token: 'secret',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-02T00:00:00.000Z',
        deleted_at: null }] }, { posts: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const posts = defineTable('posts', {
      id: column.id(),
      publicId: column.uuid().unique(),
      name: column.string(),
      token: column.string(),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
      deleted_at: column.timestamp() })

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
    expect(adapter.executions.at(-1)?.sql).toBe(
      'INSERT INTO "posts" ("name", "publicId", "created_at", "updated_at") VALUES (?1, ?2, ?3, ?4)',
    )
    expect(adapter.executions.at(-1)?.bindings.slice(0, 2)).toEqual(['Original', clone.get('publicId')])

    const notes = defineTable('notes', {
      id: column.id(),
      name: column.string() })
    const Note = defineModelFromTable(notes, {
      fillable: ['name'] })
    const noteClone = Note.getRepository().replicateEntity(Note.getRepository().hydrate({ id: 9, name: 'Note' }))
    expect(noteClone.toAttributes()).toEqual({ name: 'Note' })
  })

  it('supports convention-based, custom, and disabled timestamps', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' },
      ],
      audit_posts: [],
      notes: [] }, { users: 1, audit_posts: 0, notes: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp(),
      updated_at: column.timestamp() })
    const auditPosts = defineTable('audit_posts', {
      id: column.id(),
      name: column.string(),
      insertedOn: column.timestamp(),
      refreshedOn: column.timestamp() })
    const notes = defineTable('notes', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp(),
      updated_at: column.timestamp() })

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
    expect(adapter.executions.at(-1)?.sql).toBe(
      'UPDATE "users" SET "name" = ?1, "updated_at" = ?2 WHERE "id" = ?3',
    )
    expect(adapter.executions.at(-1)?.bindings[1]).toBeTypeOf('string')

    const custom = await AuditPost.create({ name: 'Audit' })
    expect(custom.get('insertedOn')).toBeInstanceOf(Date)
    expect(custom.get('refreshedOn')).toBeInstanceOf(Date)

    const plain = await Note.create({ name: 'Plain' })
    expect(plain.get('created_at')).toBeUndefined()
    expect(plain.get('updated_at')).toBeUndefined()
    expect(adapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "notes" ("name") VALUES (?1)',
      bindings: ['Plain'] })
  })

  it('serializes and hydrates schema-native JSON columns without manual casts', async () => {
    const adapter = new InMemoryAdapter({
      teams: [],
    }, {
      teams: 0,
    })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite'),
        }),
      },
    }))

    const teams = defineTable('teams', {
      id: column.id(),
      name: column.string(),
      meta: column.json(),
      active: column.boolean(),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
    })

    const Team = defineModelFromTable(teams, {
      fillable: ['name', 'meta', 'active'],
    })

    const created = await Team.create({
      name: 'Matrix',
      meta: { source: 'test', enabled: true },
      active: true,
    })

    expect(adapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "teams" ("name", "meta", "active", "created_at", "updated_at") VALUES (?1, ?2, ?3, ?4, ?5)',
      bindings: [
        'Matrix',
        '{"source":"test","enabled":true}',
        1,
        expect.any(String),
        expect.any(String),
      ],
    })
    expect(created.get('meta')).toEqual({ source: 'test', enabled: true })
    expect(created.get('active')).toBe(true)
  })

  it('covers empty-result and broken-entity failure paths', async () => {
    const adapter = new InMemoryAdapter({ users: [] }, { users: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const User = defineModelFromTable(users, {
      fillable: ['name'] })

    await expect(User.firstOrFail()).rejects.toThrow('User not found.')

    const broken = User.make({ name: 'Broken' })
    await broken.save()
    broken.set('id', undefined as never)
    await expect(broken.save()).rejects.toThrow('Cannot persist User without a primary key value.')

    const orphan = new Entity({ definition: User.definition, getConnection: () => DB.connection() } as never, { id: 9 }, true)
    await expect(orphan.restore()).rejects.toThrow('The bound repository cannot restore entities.')
    expect(() => orphan.replicate()).toThrow('The bound repository cannot replicate entities.')

    const fakeDelete = new Entity({ deleteEntity: async () => {} } as never, { id: 10 }, true)
    await fakeDelete.delete()
    expect(fakeDelete.exists()).toBe(false)

    const softTable = defineTable('soft_users', {
      id: column.id(),
      deleted_at: column.timestamp() })
    const SoftUser = defineModelFromTable(softTable, {
      softDeletes: true })
    const repo = User.getRepository()
    const brokenRestore = SoftUser.getRepository().hydrate({ id: 1, deleted_at: '2025-01-01T00:00:00.000Z' as never })
    brokenRestore.set('id', undefined as never)
    await expect(SoftUser.getRepository().restoreEntity(brokenRestore)).rejects.toThrow(
      'Cannot restore SoftUser without a primary key value.',
    )
    await expect(SoftUser.getRepository().forceDeleteEntity(brokenRestore)).rejects.toThrow(
      'Cannot force-delete SoftUser without a primary key value.',
    )
    const plainRestorable = repo.hydrate({ id: 3, name: 'Plain' })
    await expect(repo.restoreEntity(plainRestorable)).rejects.toThrow('User does not support soft deletes.')
  })

  it('rolls back failed writes so partial model mutations do not leak', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
      ] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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
    expect(adapter.getTable('users')).toEqual([
      { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
    ])

    const user = await User.findOrFail(1)
    user.fill({ name: 'Changed' })
    await expect(user.save()).rejects.toThrow('updated event failed')
    expect(adapter.getTable('users')).toEqual([
      { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
    ])

    const doomed = await User.findOrFail(1)
    await expect(doomed.delete()).rejects.toThrow('deleted event failed')
    expect(adapter.getTable('users')).toEqual([
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
    const adapter = new NoInsertIdAdapter({
      api_keys: [] }, { api_keys: 0 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const apiKeys = defineTable('api_keys', {
      key: column.string().primaryKey(),
      label: column.string() })

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
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', email: 'm@example.com' },
      ] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string() })

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
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' },
      ] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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
    const adapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' }] }, { users: 1 })
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

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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

  it('supports muting events and quiet create helpers', async () => {
    const adapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed', email: 'm@example.com', status: 'active' }] }, { users: 1 })
    const calls: string[] = []

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      email: column.string(),
      status: column.string() })

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
    const adapter = new InMemoryAdapter({
      users: [{ id: 1, email: 'existing@example.com', name: 'Existing', status: 'active', role: 'staff' }] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      email: column.string(),
      name: column.string(),
      status: column.string(),
      role: column.string() })

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
    const defaultAdapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      posts: [{ id: 1, title: 'Post' }] }, { users: 1, posts: 1 })
    const secondaryAdapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed Secondary' }] }, { users: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter: defaultAdapter,
          dialect: createDialect('sqlite') }),
        secondary: createDatabase({
          connectionName: 'secondary',
          adapter: secondaryAdapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string() })

    const User = defineModelFromTable(users)
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
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Soft', deleted_at: null },
      ] }, { users: 1 })
    const calls: string[] = []

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp().nullable() })

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
    const adapter = new InMemoryAdapter({
      users: [{ id: 1, name: 'Mohamed' }],
      profiles: [{ id: 10, userId: 1, bio: 'Engineer' }] }, { users: 1, profiles: 1 })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const profiles = defineTable('profiles', {
      id: column.id(),
      userId: column.integer(),
      bio: column.string() })

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

  it('dispatches trashed, force delete, and replicating lifecycle hooks', async () => {
    const adapter = new InMemoryAdapter({
      users: [
        { id: 1, name: 'Alive', deleted_at: null },
        { id: 2, name: 'Trash Me', deleted_at: null },
      ] }, { users: 2 })
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

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect('sqlite') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      deleted_at: column.timestamp() })

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
})
