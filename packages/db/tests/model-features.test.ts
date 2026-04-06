import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DB,
  Entity,
  HasSnowflakes,
  HasUlids,
  HasUniqueIds,
  HasUuids,
  SchemaError,
  binaryCast,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  defineModel,
  encryptedCast,
  enumCast,
  hasMany,
  belongsTo,
  morphTo,
  generateSnowflake,
  resetDB,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

type Row = Record<string, unknown>

function applyPredicate(left: unknown, operator: string, value: unknown): boolean {
  switch (operator) {
    case '=':
      return left === value
    case '!=':
    case '<>':
      return left !== value
    case '>':
      return Number(left) > Number(value)
    case '>=':
      return Number(left) >= Number(value)
    case '<':
      return Number(left) < Number(value)
    case '<=':
      return Number(left) <= Number(value)
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
      return applyPredicate(row[leftColumn!], operator!, row[rightColumn!])
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
    return applyPredicate(row[column!], operator!, bindings[Number(index) - 1])
  }))
}

class FeatureAdapter implements DriverAdapter {
  connected = false
  readonly rows: Record<string, Row[]> = {}
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
    const table = sql.match(/ FROM "([^"]+)"/)?.[1] ?? 'users'
    const rows = filterRows(sql, bindings, [...(this.rows[table] ?? [])])
    return {
      rows: rows as TRow[],
      rowCount: rows.length }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })

    const insert = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES \((.+)\)$/)
    if (insert) {
      const [, table, rawColumns] = insert
      const columns = rawColumns!.split(', ').map(part => part.replaceAll('"', ''))
      const row = Object.fromEntries(columns.map((column, index) => [column, bindings[index]]))
      const target = this.rows[table!] ?? (this.rows[table!] = [])
      const id = target.length + 1
      target.push({ id, ...row })
      return { affectedRows: 1, lastInsertId: id }
    }

    const update = sql.match(/^UPDATE "([^"]+)" SET (.+?)( WHERE .+)?$/)
    if (update) {
      const [, table, assignments] = update
      const target = this.rows[table!] ?? []
      const rows = filterRows(sql, bindings, target)
      const columns = assignments!.split(', ').map(part => part.match(/^"([^"]+)"/)?.[1] ?? '')
      const assignmentValues = bindings.slice(0, columns.length)
      for (const row of rows) {
        columns.forEach((column, index) => {
          row[column] = assignmentValues[index]
        })
      }
      return { affectedRows: rows.length }
    }

    return { affectedRows: 0 }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
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

function createDialectWithName(name: Dialect['name']): Dialect {
  return {
    ...createDialect(),
    name,
  }
}

describe('model feature slice', () => {
  beforeEach(() => {
    resetDB()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('applies casts, mutators, accessors, hidden fields, and appended attributes', async () => {
    const adapter = new FeatureAdapter()

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
      nickname: column.string(),
      meta: column.json<Record<string, unknown>>(),
      isActive: column.boolean(),
      bornAt: column.timestamp(),
      score: column.integer(),
      secret: column.string() })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'nickname', 'meta', 'isActive', 'bornAt', 'score', 'secret'],
      casts: {
        nickname: 'string',
        meta: 'json',
        isActive: 'boolean',
        bornAt: 'date',
        score: 'number',
        secret: {
          get: value => `secret:${String(value)}`,
          set: value => String(value).toUpperCase() } },
      mutators: {
        name: value => String(value).trim() },
      accessors: {
        name: value => String(value).toUpperCase(),
        displayName: (_value, entity) => `User:${entity.toAttributes().name}` },
      hidden: ['secret'],
      appended: ['displayName', 'secret'] })

    const bornAt = new Date('2025-01-02T03:04:05.000Z')
    const created = await User.create({
      name: '  mohamed  ',
      nickname: 55 as never,
      meta: { enabled: true },
      isActive: 1 as never,
      bornAt,
      score: '42' as never,
      secret: 'token' })

    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "users" ("name", "nickname", "meta", "isActive", "bornAt", "score", "secret") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      bindings: ['mohamed', '55', '{"enabled":true}', 1, bornAt.toISOString(), 42, 'TOKEN'] })

    expect(created.get('name')).toBe('MOHAMED')
    expect(created.get('nickname')).toBe('55')
    expect(created.get('meta')).toEqual({ enabled: true })
    expect(created.get('isActive')).toBe(true)
    expect(created.get('bornAt')).toEqual(bornAt)
    expect(created.get('score')).toBe(42)
    expect(created.toJSON()).toEqual({
      id: 1,
      name: 'MOHAMED',
      nickname: '55',
      meta: { enabled: true },
      isActive: true,
      bornAt,
      score: 42,
      displayName: 'User:mohamed' })

    const found = await User.findOrFail(1)
    expect(found.get('name')).toBe('MOHAMED')
    expect(found.get('nickname')).toBe('55')
    expect(found.toJSON().secret).toBeUndefined()
    expect((found.toJSON() as Record<string, unknown>).displayName).toBe('User:mohamed')

    found.set('score', '7' as never)
    await found.save()
    expect(adapter.executions[1]).toEqual({
      sql: 'UPDATE "users" SET "score" = ?1 WHERE "id" = ?2',
      bindings: [7, 1] })
  })

  it('supports query-time casts without mutating model casts', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialectWithName('postgres') }) } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      lastPostedAt: column.string() })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'lastPostedAt'],
      serializeDate: value => value.toISOString() })

    const iso = '2025-03-04T05:06:07.000Z'
    adapter.rows.users = [{
      id: 1,
      name: 'Mohamed',
      lastPostedAt: iso }]

    const raw = await User.firstOrFail()
    const casted = await User.withCasts({ lastPostedAt: 'date' }).firstOrFail()

    expect(raw.get('lastPostedAt')).toBe(iso)
    expect(casted.get('lastPostedAt')).toEqual(new Date(iso))
    expect(casted.toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      lastPostedAt: iso })
    expect(User.definition.casts.lastPostedAt).toBeUndefined()
  })

  it('supports datetime, timestamp, parameterized date formatting, and vector casts', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialectWithName('postgres') }) } }))

    const events = defineTable('events', {
      id: column.id(),
      startsAt: column.timestamp(),
      sentAt: column.timestamp(),
      embedding: column.vector({ dimensions: 3 }) })

    const Event = defineModelFromTable(events, {
      fillable: ['startsAt', 'sentAt', 'embedding'],
      casts: {
        startsAt: 'datetime:Y-m-d H:i:s',
        sentAt: 'timestamp:unix',
        embedding: 'vector:3' } })

    const startsAt = new Date('2025-06-07T08:09:10.000Z')
    const sentAt = new Date('2025-06-07T08:09:11.000Z')
    const created = await Event.create({
      startsAt,
      sentAt,
      embedding: [0.1, 0.2, 0.3] as never })

    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "events" ("startsAt", "sentAt", "embedding") VALUES (?1, ?2, ?3) RETURNING "id"',
      bindings: [startsAt.toISOString(), sentAt.toISOString(), '[0.1,0.2,0.3]'] })

    expect(created.get('startsAt')).toEqual(startsAt)
    expect(created.get('sentAt')).toEqual(sentAt)
    expect(created.get('embedding')).toEqual([0.1, 0.2, 0.3])
    expect(created.toJSON()).toEqual({
      startsAt: '2025-06-07 08:09:10',
      sentAt: 1749283751,
      embedding: [0.1, 0.2, 0.3] })

    adapter.rows.events = [{
      id: 2,
      startsAt: startsAt.toISOString(),
      sentAt: sentAt.toISOString(),
      embedding: '[0.1, 0.2, 0.3]' }]

    const found = await Event.findOrFail(2)
    expect(found.get('startsAt')).toEqual(startsAt)
    expect(found.get('sentAt')).toEqual(sentAt)
    expect(found.get('embedding')).toEqual([0.1, 0.2, 0.3])

    adapter.rows.events = [{
      id: 3,
      startsAt: startsAt.toISOString(),
      sentAt: sentAt.toISOString(),
      embedding: '[0.4,0.5,0.6]' }]
    expect((await Event.findOrFail(3)).get('embedding')).toEqual([0.4, 0.5, 0.6])
  })

  it('supports enum casts and rejects unsupported enum values', async () => {
    enum PostStatus {
      Draft = 'draft',
      Published = 'published' }

    const adapter = new FeatureAdapter()

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
      status: column.string() })

    const Post = defineModelFromTable(posts, {
      fillable: ['title', 'status'],
      casts: {
        status: enumCast(PostStatus) } })

    const created = await Post.create({
      title: 'A',
      status: PostStatus.Published })

    expect(created.get('status')).toBe(PostStatus.Published)
    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "posts" ("title", "status") VALUES (?1, ?2)',
      bindings: ['A', 'published'] })

    adapter.rows.posts = [{ id: 1, title: 'Loaded', status: 'draft' }]
    expect((await Post.findOrFail(1)).get('status')).toBe(PostStatus.Draft)

    await expect(Post.create({
      title: 'Broken',
      status: 'archived' as never })).rejects.toThrow('Enum cast rejected unsupported value "archived".')

    adapter.rows.posts = [{ id: 2, title: 'Broken Row', status: 'archived' }]
    await expect(Post.findOrFail(2)).rejects.toThrow('Enum cast received unsupported value "archived".')
  })

  it('supports nullable enum cast values on reads and writes', async () => {
    enum NullableStatus {
      Draft = 'draft',
      Published = 'published' }

    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const posts = defineTable('posts', {
      id: column.id(),
      status: column.string().nullable() })

    const Post = defineModelFromTable(posts, {
      fillable: ['status'],
      casts: {
        status: enumCast(NullableStatus) } })

    const created = await Post.create({ status: null as never })
    expect(created.get('status')).toBeNull()

    adapter.rows.posts = [{ id: 1, status: null }]
    expect((await Post.findOrFail(1)).get('status')).toBeNull()
  })

  it('supports class-based value-object casts with inbound transformation', async () => {
    class Money {
      constructor(readonly cents: number) {}
    }

    class MoneyCast {
      get(value: unknown) {
        return value == null ? value : new Money(Number(value))
      }

      set(value: unknown) {
        return value instanceof Money ? value.cents : Number(value)
      }
    }

    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const products = defineTable('products', {
      id: column.id(),
      name: column.string(),
      price: column.integer() })

    const Product = defineModelFromTable(products, {
      fillable: ['name', 'price'],
      casts: {
        price: new MoneyCast() } })

    const created = await Product.create({
      name: 'Chair',
      price: new Money(2500) as never })

    expect(created.get('price')).toEqual(new Money(2500))
    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "products" ("name", "price") VALUES (?1, ?2)',
      bindings: ['Chair', 2500] })

    adapter.rows.products = [{ id: 1, name: 'Desk', price: 3999 }]
    const found = await Product.findOrFail(1)
    expect(found.get('price')).toEqual(new Money(3999))
  })

  it('supports binary and encrypted cast helpers', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const files = defineTable('files', {
      id: column.id(),
      payload: column.blob(),
      secret: column.string() })

    const File = defineModelFromTable(files, {
      fillable: ['payload', 'secret'],
      casts: {
        payload: binaryCast(),
        secret: encryptedCast('top-secret-key') } })

    const payload = new Uint8Array([1, 2, 3, 4])
    const created = await File.create({
      payload: 'ABCD' as never,
      secret: { token: 'abc' } as never })

    expect(created.get('payload')).toEqual(Uint8Array.from(Buffer.from('ABCD')))
    expect(created.get('secret')).toEqual({ token: 'abc' })

    const insertBindings = adapter.executions[0]!.bindings
    expect(insertBindings[0]).toEqual(Uint8Array.from(Buffer.from('ABCD')))
    expect(typeof insertBindings[1]).toBe('string')
    expect(String(insertBindings[1])).toMatch(/^enc:/)

    adapter.rows.files = [{
      id: 1,
      payload,
      secret: insertBindings[1] }]

    const found = await File.findOrFail(1)
    expect(found.get('payload')).toEqual(payload)
    expect(found.get('secret')).toEqual({ token: 'abc' })

    adapter.rows.files = [{
      id: 2,
      payload,
      secret: 'plain-text' }]

    await expect(File.findOrFail(2)).rejects.toThrow('Encrypted cast expected an encrypted string payload.')
  })

  it('rejects invalid vector casts and propagates custom cast failures', async () => {
    class BrokenCast {
      get(): never {
        throw new Error('broken-get')
      }

      set(): never {
        throw new Error('broken-set')
      }
    }

    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialectWithName('postgres') }) } }))

    const vectors = defineTable('vectors', {
      id: column.id(),
      embedding: column.vector({ dimensions: 3 }),
      broken: column.string() })

    const VectorRow = defineModelFromTable(vectors, {
      fillable: ['embedding', 'broken'],
      casts: {
        embedding: 'vector:3',
        broken: new BrokenCast() } })
    const LooseVectorRow = defineModelFromTable(vectors, {
      fillable: ['embedding'],
      casts: {
        embedding: 'vector' } })
    const InvalidVectorConfigRow = defineModelFromTable(vectors, {
      fillable: ['embedding'],
      casts: {
        embedding: 'vector:nope' } })

    const loose = await LooseVectorRow.create({
      embedding: [0.9, 0.8] as never })
    expect(loose.get('embedding')).toEqual([0.9, 0.8])
    const vectorRepository = loose.getRepository() as unknown as {
      parseVectorValue(value: unknown, parameter?: string): number[] | null | undefined
      parseVectorString(value: unknown): number[]
      applySchemaWriteNormalization(key: string, value: unknown): unknown
      isWritableColumn(column: string): boolean
      definition: {
        hasExplicitFillable?: boolean
      }
    }
    expect(vectorRepository.parseVectorValue('[0.9,0.8]')).toEqual([0.9, 0.8])
    expect(() => vectorRepository.parseVectorString(123)).toThrow('Vector casts require an array or string payload.')
    expect(() => vectorRepository.parseVectorString('   ')).toThrow('Vector casts require a non-empty payload.')
    expect(() => vectorRepository.parseVectorString('{"value":1}')).toThrow(
      'Vector casts require a JSON array or PostgreSQL-style vector literal.',
    )
    expect(vectorRepository.applySchemaWriteNormalization('missing', 'value')).toBe('value')
    expect(vectorRepository.isWritableColumn.call({
      definition: {
        guarded: [],
        fillable: ['embedding'],
        hasExplicitFillable: undefined,
      },
    }, 'embedding')).toBe(true)

    const jsonRows = defineTable('json_rows', {
      id: column.id(),
      payload: column.json(),
    })
    const JsonRow = defineModelFromTable(jsonRows, {
      fillable: ['payload'],
    })
    const jsonEntity = await JsonRow.create({
      payload: { ok: true } as never,
    })
    const jsonRepository = jsonEntity.getRepository() as unknown as {
      applySchemaReadNormalization(key: string, value: unknown): unknown
    }
    expect(jsonRepository.applySchemaReadNormalization('payload', '{"ok":true}')).toEqual({ ok: true })

    const nullableLoose = await LooseVectorRow.create({
      embedding: null as never })
    expect(nullableLoose.get('embedding')).toBeNull()

    await expect(VectorRow.create({
      embedding: [0.1, 0.2] as never,
      broken: 'x' })).rejects.toThrow('Vector cast requires exactly 3 dimensions.')

    await expect(LooseVectorRow.create({
      embedding: [0.1, Number.NaN] as never })).rejects.toThrow('Vector casts require numeric array values.')

    await expect(InvalidVectorConfigRow.create({
      embedding: [0.1, 0.2, 0.3] as never })).rejects.toThrow('Vector cast parameter "nope" must be a positive integer.')

    await expect(VectorRow.create({
      embedding: [0.1, 0.2, 0.3] as never,
      broken: 'x' })).rejects.toThrow('broken-set')

    adapter.rows.vectors = [{ id: 1, embedding: 'bad', broken: 'x' }]
    await expect(VectorRow.findOrFail(1)).rejects.toThrow(
      'Vector values require a JSON array or PostgreSQL-style vector literal.',
    )

    adapter.rows.vectors = [{ id: 3, embedding: '{"value":1}', broken: 'x' }]
    await expect(LooseVectorRow.findOrFail(3)).rejects.toThrow(
      'Vector values require a JSON array or PostgreSQL-style vector literal.',
    )

    adapter.rows.vectors = [{ id: 4, embedding: 123, broken: 'x' }]
    await expect(LooseVectorRow.findOrFail(4)).rejects.toThrow(
      'Vector values require an array or string payload.',
    )

    adapter.rows.vectors = [{ id: 5, embedding: '   ', broken: 'x' }]
    await expect(LooseVectorRow.findOrFail(5)).rejects.toThrow(
      'Vector values require a non-empty payload.',
    )

    adapter.rows.vectors = [{ id: 2, embedding: '[0.1,0.2,0.3]', broken: 'x' }]
    await expect(VectorRow.findOrFail(2)).rejects.toThrow('broken-get')
  })

  it('handles encrypted cast nulls and malformed payloads', () => {
    const cast = encryptedCast('another-secret')

    expect(cast.get(null)).toBeNull()
    expect(cast.get(undefined)).toBeUndefined()
    expect(cast.set(null)).toBeNull()
    expect(cast.set(undefined)).toBeUndefined()

    expect(() => cast.get('enc:broken.payload')).toThrow('Encrypted cast received a malformed payload.')
  })

  it('supports direct binary and encrypted cast helper branches', () => {
    const binary = binaryCast()
    const encrypted = encryptedCast('helper-secret')

    expect(binary.get(null)).toBeNull()
    expect(binary.set(undefined)).toBeUndefined()
    expect(binary.get(Uint8Array.from([1, 2]))).toEqual(Uint8Array.from([1, 2]))
    expect(binary.set(Uint8Array.from([3, 4]))).toEqual(Uint8Array.from([3, 4]))
    expect(binary.get(Buffer.from('AQID', 'base64').toString('base64'))).toEqual(Uint8Array.from([1, 2, 3]))
    expect(binary.get(123)).toEqual(Uint8Array.from(Buffer.from('123')))
    expect(binary.set(123)).toEqual(Uint8Array.from(Buffer.from('123')))

    const encryptedString = encrypted.set('plain-text')
    expect(typeof encryptedString).toBe('string')
    expect(encrypted.get(encryptedString)).toBe('plain-text')
  })

  it('compares casted values by value for dirty tracking', async () => {
    class Money {
      constructor(readonly cents: number) {}
    }

    class MoneyCast {
      get(value: unknown) {
        return value == null ? value : new Money(Number(value))
      }

      set(value: unknown) {
        return value instanceof Money ? value.cents : Number(value)
      }
    }

    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const items = defineTable('items', {
      id: column.id(),
      price: column.integer(),
      payload: column.blob(),
      meta: column.json<Record<string, unknown>>(),
      publishedAt: column.timestamp() })

    const Item = defineModelFromTable(items, {
      fillable: ['price', 'payload', 'meta', 'publishedAt'],
      casts: {
        price: new MoneyCast(),
        payload: binaryCast(),
        meta: 'json',
        publishedAt: 'date' } })

    const originalPayload = new Uint8Array([1, 2, 3])
    const originalDate = new Date('2025-01-02T03:04:05.000Z')
    adapter.rows.items = [{
      id: 1,
      price: 2500,
      payload: originalPayload,
      meta: '{"enabled":true}',
      publishedAt: originalDate.toISOString() }]

    const item = await Item.findOrFail(1)
    item.set('price', new Money(2500) as never)
    item.set('payload', new Uint8Array([1, 2, 3]) as never)
    item.set('meta', { enabled: true } as never)
    item.set('publishedAt', new Date(originalDate) as never)

    expect(item.isDirty()).toBe(false)
    expect(item.getDirty()).toEqual({})

    item.set('price', new Money(2600) as never)
    expect(item.isDirty('price')).toBe(true)

    item.set('meta', { enabled: true, extra: true } as never)
    expect(item.isDirty('meta')).toBe(true)

    item.syncOriginal()
    item.set('payload', new Uint8Array([1, 2]) as never)
    expect(item.isDirty('payload')).toBe(true)

    item.syncOriginal()
    item.set('payload', new Uint8Array([1, 9, 3]) as never)
    expect(item.isDirty('payload')).toBe(true)

    item.syncOriginal()
    item.set('meta', [{ enabled: true }] as never)
    expect(item.isDirty('meta')).toBe(true)
  })

  it('supports castable definitions that resolve to runtime casts', async () => {
    class TitleCastable {
      castUsing() {
        return {
          get(value: unknown) {
            return value == null ? value : `title:${String(value)}`
          },
          set(value: unknown) {
            return value == null ? value : String(value).toUpperCase()
          } }
      }
    }

    const adapter = new FeatureAdapter()

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

    const Post = defineModelFromTable(posts, {
      fillable: ['title'],
      casts: {
        title: new TitleCastable() } })

    const created = await Post.create({ title: 'hello' })
    expect(created.get('title')).toBe('title:HELLO')
    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "posts" ("title") VALUES (?1)',
      bindings: ['HELLO'] })

    adapter.rows.posts = [{ id: 1, title: 'WORLD' }]
    expect((await Post.findOrFail(1)).get('title')).toBe('title:WORLD')
  })

  it('falls back to raw entity attributes when repository hooks are absent', () => {
    const entity = new Entity({} as never, {
      id: 9,
      name: 'Raw' }, true)

    expect(entity.get('name' as never)).toBe('Raw')
    expect(entity.toJSON()).toEqual({
      id: 9,
      name: 'Raw' })
  })

  it('compares raw entity arrays and binary payloads by value', () => {
    const entity = new Entity({} as never, {
      payload: new Uint8Array([1, 2, 3]),
      tags: ['a', 'b'] }, true)

    entity.set('payload' as never, new Uint8Array([1, 2, 9]) as never)
    expect(entity.isDirty('payload' as never)).toBe(true)

    entity.syncOriginal()
    entity.set('tags' as never, ['a'] as never)
    expect(entity.isDirty('tags' as never)).toBe(true)

    entity.syncOriginal()
    entity.set('tags' as never, ['a', 'c'] as never)
    expect(entity.isDirty('tags' as never)).toBe(true)

    entity.syncOriginal()
    entity.set('tags' as never, ['a', 'c'] as never)
    expect(entity.isDirty('tags' as never)).toBe(false)
  })

  it('supports temporary visibility and append controls on entities', async () => {
    const adapter = new FeatureAdapter()

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
      email: column.string(),
      secret: column.string(),
      role: column.string() })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'email', 'secret', 'role'],
      accessors: {
        label: (_value, entity) => `${entity.toAttributes().name}:${entity.toAttributes().role}` },
      hidden: ['secret'],
      visible: ['id', 'name', 'email', 'label'],
      appended: ['label'] })

    const user = await User.create({
      name: 'Mohamed',
      email: 'm@example.com',
      secret: 'token',
      role: 'admin' })

    expect(user.toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      email: 'm@example.com',
      label: 'Mohamed:admin' })

    expect(user.makeVisible('secret').toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      email: 'm@example.com',
      secret: 'token',
      label: 'Mohamed:admin' })

    expect(user.makeHidden('email').toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      secret: 'token',
      label: 'Mohamed:admin' })

    expect(user.setVisible(['name', 'secret']).withoutAppends().toJSON()).toEqual({
      name: 'Mohamed',
      secret: 'token' })

    expect(user.setHidden(['email']).makeVisible('secret', 'role').append('label').toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      secret: 'token',
      role: 'admin',
      label: 'Mohamed:admin' })

    expect(user.setAppends(['label']).makeHidden('secret', 'role').makeVisible('email').toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      email: 'm@example.com',
      label: 'Mohamed:admin' })
  })

  it('supports custom date serialization for JSON output', async () => {
    const adapter = new FeatureAdapter()

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
      bornAt: column.timestamp() })

    const User = defineModelFromTable(users, {
      fillable: ['name', 'bornAt'],
      casts: {
        bornAt: 'date' },
      serializeDate: value => value.toISOString().slice(0, 10) })

    const user = await User.create({
      name: 'Mohamed',
      bornAt: new Date('2025-01-02T03:04:05.000Z') })

    expect(user.toJSON()).toEqual({
      id: 1,
      name: 'Mohamed',
      bornAt: '2025-01-02' })
  })

  it('covers cast fallback branches for nullable and pre-serialized values', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const profiles = defineTable('profiles', {
      id: column.id(),
      alias: column.string(),
      meta: column.json<Record<string, unknown>>(),
      bornAt: column.timestamp(),
      label: column.string() })

    const Profile = defineModelFromTable(profiles, {
      fillable: ['alias', 'meta', 'bornAt', 'label'],
      casts: {
        alias: 'string',
        meta: 'json',
        bornAt: 'date',
        label: {
          get: value => `label:${String(value)}` } } })

    const created = await Profile.create({
      alias: null as never,
      meta: '{"ok":true}' as never,
      bornAt: '2025-03-04T05:06:07.000Z' as never,
      label: 'plain' })

    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "profiles" ("alias", "meta", "bornAt", "label") VALUES (?1, ?2, ?3, ?4)',
      bindings: [null, '{"ok":true}', '2025-03-04T05:06:07.000Z', 'plain'] })

    expect(created.get('alias')).toBeNull()
    expect(created.get('meta')).toEqual({ ok: true })
    expect(created.get('bornAt')).toEqual(new Date('2025-03-04T05:06:07.000Z'))
    expect(created.get('label')).toBe('label:plain')
  })

  it('uses mass soft deletes on query deletes instead of hard deletes', async () => {
    const adapter = new FeatureAdapter()

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

    const User = defineModelFromTable(users, {
      fillable: ['name'],
      softDeletes: true })

    await User.where('id', 1).delete()

    expect(adapter.executions[0]?.sql).toMatch(/^UPDATE "users" SET "deleted_at" = \?1 WHERE /)
    expect(String(adapter.executions[0]?.bindings[0])).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('does not dispatch per-row lifecycle events for mass deletes', async () => {
    const adapter = new FeatureAdapter()
    adapter.rows.users = [
      { id: 1, name: 'Mohamed', deleted_at: null },
    ]

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
      name: column.string(),
      deleted_at: column.timestamp().nullable() })

    const User = defineModelFromTable(users, {
      fillable: ['name'],
      softDeletes: true,
      events: {
        deleting() {
          calls.push('deleting')
        },
        deleted() {
          calls.push('deleted')
        },
        trashed() {
          calls.push('trashed')
        } } })

    const result = await User.where('id', 1).delete()

    expect(result.affectedRows).toBe(1)
    expect(calls).toEqual([])
    expect(adapter.executions[0]?.sql).toMatch(/^UPDATE "users" SET "deleted_at" = \?1 WHERE /)
  })

  it('touches parent timestamps for belongsTo and morphTo relations and validates touch configuration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'))

    try {
      const adapter = new FeatureAdapter()
      adapter.rows.users = [
        { id: 1, name: 'Mohamed', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null },
      ]
      adapter.rows.posts = [
        { id: 1, userId: 1, title: 'Draft' },
        { id: 2, userId: null, title: 'Orphan' },
      ]
      adapter.rows.images = [
        { id: 1, imageableType: 'User', imageableId: 1, url: 'avatar.png' },
        { id: 2, imageableType: '', imageableId: null, url: 'orphan.png' },
        { id: 3, imageableType: 'Team', imageableId: 1, url: 'team.png' },
      ]
      adapter.rows.teams = [
        { id: 1, name: 'Platform' },
      ]
      adapter.rows.notes = [
        { id: 1, teamId: 1, body: 'Remember me' },
      ]

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
        updated_at: column.timestamp(),
        deleted_at: column.timestamp().nullable() })
      const posts = defineTable('posts', {
        id: column.id(),
        userId: column.integer(),
        title: column.string() })
      const images = defineTable('images', {
        id: column.id(),
        imageableType: column.string().nullable(),
        imageableId: column.integer().nullable(),
        url: column.string() })
      const teams = defineTable('teams', {
        id: column.id(),
        name: column.string() })
      const notes = defineTable('notes', {
        id: column.id(),
        teamId: column.integer().nullable(),
        body: column.string() })

      let User: ReturnType<typeof defineModelFromTable<typeof users>>
      let Post: ReturnType<typeof defineModelFromTable<typeof posts>>
      let Image: ReturnType<typeof defineModelFromTable<typeof images>>
      let Team: ReturnType<typeof defineModelFromTable<typeof teams>>
      let Note: ReturnType<typeof defineModelFromTable<typeof notes>>

      User = defineModelFromTable(users, {
        softDeletes: true })
      Team = defineModelFromTable(teams)
      Post = defineModelFromTable(posts, {
        relations: {
          author: belongsTo(() => User, 'userId') },
        touches: ['author'] })
      Image = defineModelFromTable(images, {
        relations: {
          imageable: morphTo('imageable', 'imageableType', 'imageableId') },
        touches: ['imageable'] })
      Note = defineModelFromTable(notes, {
        relations: {
          team: belongsTo(() => Team, 'teamId') },
        touches: ['team'] })

      const post = await Post.findOrFail(1)
      post.set('title', 'Published')
      await post.save()
      expect(adapter.rows.users[0]?.updated_at).toBe('2026-04-01T12:00:00.000Z')

      const orphanPost = await Post.findOrFail(2)
      orphanPost.set('title', 'Still Orphan')
      await orphanPost.save()

      vi.setSystemTime(new Date('2026-04-02T08:30:00.000Z'))
      const image = await Image.findOrFail(1)
      image.set('url', 'avatar-2.png')
      await image.save()
      expect(adapter.rows.users[0]?.updated_at).toBe('2026-04-02T08:30:00.000Z')

      const orphanedImage = await Image.findOrFail(2)
      orphanedImage.set('url', 'orphan-2.png')
      await orphanedImage.save()

      const teamImage = await Image.findOrFail(3)
      teamImage.set('url', 'team-2.png')
      await teamImage.save()
      expect(adapter.rows.teams[0]).toEqual({
        id: 1,
        name: 'Platform' })

      const note = await Note.findOrFail(1)
      note.set('body', 'Remembered')
      await note.save()

      expect(() => defineModelFromTable(posts, {
        relations: {
          author: belongsTo(() => User, 'userId') },
        touches: ['missing'] })).toThrow('Touched relation "missing" is not defined on model "Post".')

      expect(() => defineModelFromTable(posts, {
        relations: {
          siblings: hasMany(() => Post, 'userId') },
        touches: ['siblings'] })).toThrow('Touched relation "siblings" on model "Post" must be a belongs-to or morph-to relation.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('covers nullable scalar casts and set-only custom casts', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const flags = defineTable('flags', {
      id: column.id(),
      enabled: column.boolean(),
      count: column.integer(),
      token: column.string() })

    const Flag = defineModelFromTable(flags, {
      fillable: ['enabled', 'count', 'token'],
      casts: {
        enabled: 'boolean',
        count: 'number',
        token: {
          set: value => `stored:${String(value)}` } } })

    const created = await Flag.create({
      enabled: null as never,
      count: null as never,
      token: 'abc' })

    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "flags" ("enabled", "count", "token") VALUES (?1, ?2, ?3)',
      bindings: [null, null, 'stored:abc'] })

    expect(created.get('enabled')).toBeNull()
    expect(created.get('count')).toBeNull()
    expect(created.get('token')).toBe('stored:abc')
  })

  it('generates UUID, ULID, Snowflake, and custom IDs for configured models', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    vi.spyOn(Date, 'now').mockReturnValue(1704067200000)

    const uuidUsers = defineTable('uuid_users', {
      id: column.uuid().primaryKey(),
      name: column.string() })
    const ulidUsers = defineTable('ulid_users', {
      id: column.ulid().primaryKey(),
      name: column.string() })
    const snowflakeUsers = defineTable('snowflake_users', {
      id: column.snowflake().primaryKey(),
      name: column.string() })
    const customUsers = defineTable('custom_users', {
      id: column.uuid().primaryKey(),
      publicId: column.string().unique(),
      name: column.string() })

    const UuidUser = defineModelFromTable(uuidUsers, {
      traits: [HasUuids()],
      fillable: ['name'] })
    const ManualUuidUser = defineModelFromTable(uuidUsers, {
      traits: [HasUuids()],
      fillable: ['id', 'name'] })
    const UlidUser = defineModelFromTable(ulidUsers, {
      traits: [HasUlids()],
      fillable: ['name'] })
    const SnowflakeUser = defineModelFromTable(snowflakeUsers, {
      traits: [HasSnowflakes()],
      fillable: ['name'] })
    const CustomUser = defineModelFromTable(customUsers, {
      traits: [HasUniqueIds({ columns: ['publicId'] })],
      newUniqueId: () => 'custom-public-id',
      fillable: ['id', 'name'] })

    const uuidCreated = await UuidUser.create({ name: 'UUID' })
    const manualCreated = await ManualUuidUser.create({ id: 'manual-id', name: 'Manual' })
    const ulidCreated = await UlidUser.create({ name: 'ULID' })
    const snowflakeCreatedA = await SnowflakeUser.create({ name: 'Snow A' })
    const snowflakeCreatedB = await SnowflakeUser.create({ name: 'Snow B' })
    const customCreated = await CustomUser.create({ id: 'custom-id', name: 'Custom' })

    expect(uuidCreated.get('id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(manualCreated.get('id')).toBe('manual-id')
    expect(String(ulidCreated.get('id'))).toHaveLength(26)
    expect(String(snowflakeCreatedA.get('id'))).toMatch(/^\d+$/)
    expect(BigInt(String(snowflakeCreatedB.get('id')))).toBeGreaterThan(BigInt(String(snowflakeCreatedA.get('id'))))
    expect(customCreated.get('publicId')).toBe('custom-public-id')

    expect(adapter.executions[0]).toEqual({
      sql: 'INSERT INTO "uuid_users" ("name", "id") VALUES (?1, ?2)',
      bindings: ['UUID', uuidCreated.get('id')] })
    expect(adapter.executions[1]).toEqual({
      sql: 'INSERT INTO "uuid_users" ("id", "name") VALUES (?1, ?2)',
      bindings: ['manual-id', 'Manual'] })
    expect(adapter.executions[2]).toEqual({
      sql: 'INSERT INTO "ulid_users" ("name", "id") VALUES (?1, ?2)',
      bindings: ['ULID', ulidCreated.get('id')] })
    expect(adapter.executions[3]).toEqual({
      sql: 'INSERT INTO "snowflake_users" ("name", "id") VALUES (?1, ?2)',
      bindings: ['Snow A', snowflakeCreatedA.get('id')] })
    expect(adapter.executions[4]).toEqual({
      sql: 'INSERT INTO "snowflake_users" ("name", "id") VALUES (?1, ?2)',
      bindings: ['Snow B', snowflakeCreatedB.get('id')] })
    expect(adapter.executions[5]).toEqual({
      sql: 'INSERT INTO "custom_users" ("id", "name", "publicId") VALUES (?1, ?2, ?3)',
      bindings: ['custom-id', 'Custom', 'custom-public-id'] })
  })

  it('rejects invalid unique ID trait configurations', () => {
    const uuidUsers = defineTable('uuid_users', {
      id: column.uuid().primaryKey(),
      code: column.string() })
    const ulidUsers = defineTable('ulid_users', {
      id: column.ulid().primaryKey() })
    const numericUsers = defineTable('numeric_users', {
      id: column.integer().primaryKey() })

    expect(() => defineModelFromTable(uuidUsers, {
      uniqueIds: ['id'] })).toThrow('uniqueIds and newUniqueId require a unique ID trait.')

    expect(() => defineModelFromTable(uuidUsers, {
      traits: [HasUuids(), HasUlids()] })).toThrow('Only one unique ID trait may be applied to a model.')

    expect(() => defineModelFromTable(uuidUsers, {
      traits: [HasUniqueIds()] })).toThrow('HasUniqueIds requires an explicit generator.')

    expect(() => defineModelFromTable(uuidUsers, {
      traits: [HasUniqueIds({ generator: () => 'x', columns: [] })] })).toThrow('uniqueIds must contain at least one column.')

    expect(() => defineModelFromTable(uuidUsers, {
      traits: [HasUuids({ columns: ['code'] })] })).toThrow('Unique ID column "code" on table "uuid_users" must be primary or unique.')

    expect(() => defineModelFromTable(uuidUsers, {
      traits: [HasUniqueIds({ columns: ['missing' as never], generator: () => 'x' })] })).toThrow('Unique ID column "missing" does not exist on table "uuid_users".')

    expect(() => defineModelFromTable(ulidUsers, {
      traits: [HasUuids()] })).toThrow('HasUuids cannot target ULID column "id" on table "ulid_users".')

    expect(() => defineModelFromTable(uuidUsers, {
      traits: [HasUlids()] })).toThrow('HasUlids cannot target UUID column "id" on table "uuid_users".')

    expect(() => defineModelFromTable(uuidUsers, {
      traits: [HasSnowflakes()] })).toThrow('HasSnowflakes cannot target uuid column "id" on table "uuid_users".')

    expect(() => defineModelFromTable(numericUsers, {
      traits: [HasSnowflakes()] })).toThrow('Unique ID column "id" on table "numeric_users" must be string-like.')

    expect(SchemaError).toBeDefined()
  })

  it('covers the direct snowflake generator across changing timestamps', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1704067200001)
      .mockReturnValueOnce(1704067200002)

    const first = generateSnowflake()
    const second = generateSnowflake()

    expect(BigInt(second)).toBeGreaterThan(BigInt(first))
  })

  it('covers snowflake sequence rollover within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1704067200003)

    let previous = BigInt(generateSnowflake())
    for (let index = 0; index < 5000; index += 1) {
      const current = BigInt(generateSnowflake())
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
  })

  it('rejects unique ID generators that return empty strings at runtime', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const brokenUsers = defineTable('broken_users', {
      id: column.uuid().primaryKey(),
      name: column.string() })

    const BrokenUser = defineModelFromTable(brokenUsers, {
      traits: [HasUniqueIds({ generator: () => '   ' })],
      fillable: ['name'] })

    await expect(BrokenUser.create({ name: 'Broken' })).rejects.toThrow(
      'BrokenUser unique ID generator must return a non-empty string.',
    )
  })

  it('falls back to the default UUID generator for non-custom unique ID traits without an explicit generator', async () => {
    const adapter = new FeatureAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: createDatabase({
          connectionName: 'default',
          adapter,
          dialect: createDialect() }) } }))

    const fallbackUsers = defineTable('fallback_users', {
      id: column.uuid().primaryKey(),
      name: column.string() })

    const FallbackUser = defineModelFromTable(fallbackUsers, {
      traits: [{
        kind: 'uniqueIds',
        name: 'ManualUuidTrait',
        type: 'uuid' }],
      fillable: ['name'] })

    const created = await FallbackUser.create({ name: 'Fallback' })
    expect(String(created.get('id'))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })
})
