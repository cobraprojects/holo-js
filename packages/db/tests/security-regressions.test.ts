import { beforeEach, describe, expect, it } from 'vitest'
import {
  DB,
  SecurityError,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  defineModel,
  resetDB,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

class SecurityAdapter implements DriverAdapter {
  connected = false
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []

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
    return {
      rows: [] as TRow[],
      rowCount: 0 }
  }

  async execute(): Promise<DriverExecutionResult> {
    return { affectedRows: 0 }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

function createDialect(name = 'sqlite'): Dialect {
  return {
    name,
    capabilities: {
      returning: name === 'postgres',
      savepoints: false,
      concurrentQueries: true,
      workerThreadExecution: false,
      lockForUpdate: name === 'postgres' || name === 'mysql',
      sharedLock: name === 'postgres' || name === 'mysql',
      jsonValueQuery: true,
      jsonContains: name === 'postgres' || name === 'mysql',
      jsonLength: name === 'postgres' || name === 'mysql',
      schemaQualifiedIdentifiers: name === 'postgres' || name === 'mysql',
      nativeUpsert: name === 'postgres' || name === 'mysql',
      ddlAlterSupport: false,
      introspection: true },
    quoteIdentifier(identifier: string) {
      return name === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return name === 'postgres' ? `$${index}` : `?${index}`
    } }
}

describe('security regressions', () => {
  beforeEach(() => {
    resetDB()
  })

  it('keeps malicious string payloads in bindings instead of interpolating them', async () => {
    const adapter = new SecurityAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect() } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const quotePayload = `Mohamed' OR '1'='1`
    const commentPayload = `"; DROP TABLE users; --`

    await DB.table(users).where('name', quotePayload).get()
    await DB.table(users).where('name', commentPayload).get()

    expect(adapter.queries).toEqual([
      {
        sql: 'SELECT * FROM "users" WHERE "name" = ?1',
        bindings: [quotePayload] },
      {
        sql: 'SELECT * FROM "users" WHERE "name" = ?1',
        bindings: [commentPayload] },
    ])
  })

  it('keeps malicious string payloads in bindings on the Postgres dialect too', async () => {
    const adapter = new SecurityAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('postgres') } } }))

    const users = defineTable('public.users', {
      id: column.id(),
      name: column.string() })

    const payload = `Mohamed' OR '1'='1`

    await DB.table(users).where('name', payload).get()

    expect(adapter.queries).toEqual([{
      sql: 'SELECT * FROM "public"."users" WHERE "name" = $1',
      bindings: [payload] }])
  })

  it('keeps malicious string payloads in bindings on the MySQL dialect and quotes database-qualified names structurally', async () => {
    const adapter = new SecurityAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('mysql') } } }))

    const users = defineTable('analytics.users', {
      id: column.id(),
      name: column.string() })

    const payload = `Mohamed' OR '1'='1`

    await DB.table(users).where('name', payload).get()

    expect(adapter.queries).toEqual([{
      sql: 'SELECT * FROM `analytics`.`users` WHERE `name` = ?1',
      bindings: [payload] }])
  })

  it('rejects identifier and operator injection attempts in safe query mode', async () => {
    const adapter = new SecurityAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect() } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean() })

    await expect(DB.table('users; DROP TABLE users').get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).select('name; DROP TABLE users' as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).where('name', 'or 1=1' as never, 'Mohamed').get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).orderBy('name desc; --' as never).get()).rejects.toThrow(SecurityError)
  })

  it('rejects malformed cursor tokens on both table and model queries', async () => {
    const adapter = new SecurityAdapter()
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
    const User = defineModelFromTable(users)
    const malformedCursor = Buffer.from(JSON.stringify({ offset: 'bad' }), 'utf8').toString('base64url')

    await expect(DB.table(users).cursorPaginate(2, 'broken')).rejects.toThrow('Cursor is malformed.')
    await expect(DB.table(users).cursorPaginate(2, malformedCursor)).rejects.toThrow('Cursor is malformed.')
    await expect(User.cursorPaginate(2, 'broken')).rejects.toThrow('Cursor is malformed.')
    await expect(User.cursorPaginate(2, malformedCursor)).rejects.toThrow('Cursor is malformed.')
  })

  it('rejects malformed or database-specific JSON paths early', async () => {
    const adapter = new SecurityAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect() } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      settings: column.json() })
    const User = defineModelFromTable(users)

    expect(() => DB.table(users).whereJson('settings->', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('->profile' as never, 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->>profile', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJsonContains('name->profile', 'eu')).toThrow(SecurityError)
    await expect(User.whereJsonLength('settings->tags', 'like' as never, 2).get()).rejects.toThrow(SecurityError)
  })
})
