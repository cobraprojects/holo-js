import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { createPostgresAdapter, postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import {
  configureDB,
  createSchemaService,
  registerDatabaseDriverFactory,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
  type DriverAdapter,
} from '../src'
import { postgresTestConnection, testConnectionUrl } from './support/database'

registerDatabaseDriverFactory(postgresDatabaseDriverFactory)

const database = `holo_session_tz_${randomUUID().replaceAll('-', '').slice(0, 12)}`

function sessionConnection() {
  return { ...postgresTestConnection(), database }
}

function structuredConnection() {
  const { user, ...connection } = sessionConnection()
  return { ...connection, username: user }
}

function connectionUrl(options?: string): string {
  const url = testConnectionUrl('postgresql', sessionConnection())
  if (options) url.searchParams.set('options', options)
  return url.toString()
}

function useAppTimezone(timeZone: string): void {
  configureConfigRuntime({ app: { timezone: timeZone } } as never)
  onTestFinished(() => { resetConfigRuntime() })
}

function connectTo(connection: Record<string, unknown>) {
  const manager = resolveRuntimeConnectionManagerOptions({ db: { connections: { main: { driver: 'postgres', ...connection } } } })
  configureDB(manager)
  onTestFinished(async () => {
    await manager.disconnectAll()
    resetDB()
  })
  return manager.connection()
}

async function sessionSettings(db: ReturnType<typeof connectTo>, ...names: string[]): Promise<Record<string, unknown> | undefined> {
  const columns = names.map((name, index) => `current_setting($${index + 1}) AS "${name}"`).join(', ')
  return (await db.queryCompiled({ sql: `SELECT ${columns}`, bindings: names, source: 'query' })).rows[0]
}

async function sessionTimeZone(options?: string): Promise<unknown> {
  const adapter = createPostgresAdapter({ config: { ...sessionConnection(), ...(options ? { options } : {}) } })
  onTestFinished(async () => { await adapter.disconnect() })
  return (await adapter.query('SHOW TimeZone')).rows[0]?.TimeZone
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('PostgreSQL session time zone follows app.timezone', () => {
  let admin: DriverAdapter

  beforeAll(async () => {
    admin = createPostgresAdapter({ config: postgresTestConnection() })
    await admin.execute(`CREATE DATABASE ${database}`)
    await admin.execute(`ALTER DATABASE ${database} SET timezone = 'Etc/GMT-2'`)
  })

  afterAll(async () => {
    await admin.execute(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.disconnect()
  })

  it.each([
    { mode: 'url', connection: () => ({ url: connectionUrl() }) },
    { mode: 'structured', connection: structuredConnection },
  ])('reads defaultNow() and timestamps() defaults back in app.timezone on a UTC+2 server with $mode configuration', async ({ connection }) => {
    useAppTimezone('UTC')
    const db = connectTo(connection())
    const tableName = `holo_defaults_${randomUUID().replaceAll('-', '')}`
    const schema = createSchemaService(db)
    await schema.createTable(tableName, (table) => {
      table.id()
      table.string('name')
      table.timestamp('seen_at').defaultNow()
      table.timestamps()
    })
    onTestFinished(async () => { await createSchemaService(connectTo(connection())).dropTable(tableName) })

    const before = Date.now()
    await db.table(tableName).insert({ name: 'default now' })
    const after = Date.now()
    const rows = await db.table(tableName).select('seen_at', 'created_at', 'updated_at').get()

    expect(rows).toHaveLength(1)
    for (const value of rows.flatMap(row => Object.values(row))) {
      expect(value).toBeInstanceOf(Date)
      expect((value as Date).getTime()).toBeGreaterThanOrEqual(before - 1_000)
      expect((value as Date).getTime()).toBeLessThanOrEqual(after + 1_000)
    }
    expect(await sessionSettings(db, 'TimeZone')).toEqual({ TimeZone: 'UTC' })
  }, 30_000)

  it('uses app.timezone for adapters created from a pg config', async () => {
    useAppTimezone('Asia/Tokyo')
    expect(await sessionTimeZone())
      .toBe('Asia/Tokyo')
  })

  it('keeps a search_path from the configured schema alongside the session time zone', async () => {
    useAppTimezone('Asia/Tokyo')
    const db = connectTo({ url: connectionUrl(), schema: 'public' })
    expect(await sessionSettings(db, 'TimeZone', 'search_path')).toEqual({ TimeZone: 'Asia/Tokyo', search_path: '"public"' })
  })

  it('uses app.timezone when the connection URL has an empty options parameter', async () => {
    useAppTimezone('Asia/Tokyo')
    const url = new URL(connectionUrl())
    url.searchParams.set('options', '')
    const db = connectTo({ url: url.toString() })
    expect(await sessionSettings(db, 'TimeZone')).toEqual({ TimeZone: 'Asia/Tokyo' })
  })

  it('lets the last options parameter of the connection URL win, as pg does', async () => {
    useAppTimezone('UTC')
    const url = new URL(connectionUrl('-c TimeZone=Europe/Paris'))
    url.searchParams.append('options', '-c TimeZone=Asia/Tokyo')
    const db = connectTo({ url: url.toString(), schema: 'public' })
    expect(await sessionSettings(db, 'TimeZone', 'search_path')).toEqual({ TimeZone: 'Asia/Tokyo', search_path: '"public"' })
  })

  it('keeps PGOPTIONS when the connection URL has an empty options parameter', async () => {
    useAppTimezone('UTC')
    vi.stubEnv('PGOPTIONS', '-c statement_timeout=7000 -c TimeZone=America/New_York')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const url = new URL(connectionUrl())
    url.searchParams.set('options', '')
    const db = connectTo({ url: url.toString() })
    expect(await sessionSettings(db, 'TimeZone', 'statement_timeout')).toEqual({ TimeZone: 'America/New_York', statement_timeout: '7s' })
  })

  it('uses app.timezone for a connection URL whose host is a query parameter', async () => {
    useAppTimezone('Asia/Tokyo')
    const { host, port, user, password } = sessionConnection()
    const query = new URLSearchParams({ host, port: String(port), options: '-c statement_timeout=5000' })
    const credentials = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user)
    const db = connectTo({ url: `postgresql://${credentials}@/${database}?${query.toString()}` })
    expect(await sessionSettings(db, 'TimeZone', 'statement_timeout')).toEqual({ TimeZone: 'Asia/Tokyo', statement_timeout: '5s' })
  })

  it('lets a TimeZone in the connection URL options win over app.timezone', async () => {
    useAppTimezone('UTC')
    const db = connectTo({ url: connectionUrl('-c statement_timeout=5000 -c TimeZone=America/New_York'), schema: 'public' })
    expect(await sessionSettings(db, 'TimeZone', 'statement_timeout')).toEqual({ TimeZone: 'America/New_York', statement_timeout: '5s' })
  })

  it('lets a TimeZone in the pg options win over app.timezone', async () => {
    useAppTimezone('UTC')
    expect(await sessionTimeZone('-c TimeZone=America/New_York'))
      .toBe('America/New_York')
  })

  it.each([
    { mode: 'without', schema: undefined },
    { mode: 'with', schema: 'public' },
  ])('lets a TimeZone in PGOPTIONS win over app.timezone $mode a configured schema', async ({ schema }) => {
    useAppTimezone('UTC')
    vi.stubEnv('PGOPTIONS', '-c TimeZone=America/New_York')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const db = connectTo({ ...structuredConnection(), ...(schema ? { schema } : {}) })
    expect(await sessionSettings(db, 'TimeZone')).toEqual({ TimeZone: 'America/New_York' })
  })
})
