import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigDirectory, writeConfigCache } from '@holo-js/config'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'
import { createPostgresAdapter, postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import { defineDatabaseConfig, normalizeDatabaseConfig, registerDatabaseDriverFactory, resolveRuntimeConnectionManagerOptions, type DatabaseLogger } from '../src'

type QuerySuccessLog = Parameters<NonNullable<DatabaseLogger['onQuerySuccess']>>[0]

registerDatabaseDriverFactory(postgresDatabaseDriverFactory)
registerDatabaseDriverFactory(sqliteDatabaseDriverFactory)

describe('runtime database budgets', () => {
  it('reloads logger callbacks from cached database configuration and enforces concurrency', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-logger-'))
    onTestFinished(() => rm(projectRoot, { recursive: true, force: true }))
    await mkdir(join(projectRoot, 'config'))
    await writeFile(join(projectRoot, 'config/database.mjs'), `export default {
      connections: { main: { driver: 'sqlite', url: ':memory:',
        concurrency: { maxConcurrentQueries: 1, queueLimit: 0 },
        logger: { onQuerySuccess(entry) { console.info({ rowCount: entry.rowCount }) } },
      } },
    }`)
    await writeConfigCache(projectRoot)
    const loaded = await loadConfigDirectory(projectRoot, { preferCache: true })
    const manager = resolveRuntimeConnectionManagerOptions({ db: loaded.database })
    onTestFinished(() => manager.disconnectAll())
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    onTestFinished(() => output.mockRestore())
    const db = manager.connection()
    await db.queryCompiled({ sql: 'SELECT 1', source: 'query' })
    expect(output.mock.calls).toEqual([[{ rowCount: 1 }]])
    const pending = db.queryCompiled({ sql: 'SELECT 1', source: 'query' })
    await expect(db.queryCompiled({ sql: 'SELECT 2', source: 'query' })).rejects.toThrow('queue')
    await pending
  })

  it.each(['url', 'structured'] as const)('preserves pool budgets and a redacted custom logger through %s configuration', async mode => {
    const applicationName = `holo_budget_${randomUUID()}`
    const entries: QuerySuccessLog[] = []
    const logger: DatabaseLogger = { onQuerySuccess(entry) { entries.push(entry) } }
    const host = process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1'
    const port = Number(process.env.HOLO_POSTGRES_PORT ?? 5432)
    const username = process.env.HOLO_POSTGRES_USER ?? 'postgres'
    const password = process.env.HOLO_POSTGRES_PASSWORD
    const database = process.env.HOLO_POSTGRES_DATABASE ?? 'postgres'
    const url = new URL(`postgresql://${host}:${port}/${database}`)
    url.username = username
    if (password) url.password = password
    const config = normalizeDatabaseConfig(defineDatabaseConfig({
      connections: {
        main: {
          driver: 'postgres',
          ...(mode === 'url' ? { url: url.toString() } : { host, port, username, password, database }),
          max: 1,
          connectionTimeoutMillis: 100,
          idleTimeoutMillis: 50,
          application_name: applicationName,
          concurrency: { maxConcurrentQueries: 2, queueLimit: 0 },
          logging: true,
          logger,
        },
      },
    }))
    const manager = resolveRuntimeConnectionManagerOptions({ db: config })
    onTestFinished(() => manager.disconnectAll())
    const db = manager.connection()
    const adapter = db.getAdapter()
    expect(db.getLogger()).toBe(logger)
    expect(db.getConcurrencyOptions()).toEqual({ maxConcurrentQueries: 2, queueLimit: 0 })
    const session = () => adapter.query<{ name: string, pid: number }>("SELECT current_setting('application_name') AS name, pg_backend_pid() AS pid")
    const first = (await session()).rows[0]
    expect(first?.name).toBe(applicationName)
    const observer = createPostgresAdapter({ config: { host, port, user: username, password, database } })
    onTestFinished(() => observer.disconnect())
    await observer.query('SELECT 1')
    let notifyStarted = () => {}
    let releaseTransaction = () => {}
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const release = new Promise<void>(resolve => { releaseTransaction = resolve })
    const transaction = db.transaction(async () => {
      notifyStarted()
      await release
    })
    await started
    try {
      await expect(session()).rejects.toThrow('timeout')
    } finally {
      releaseTransaction()
      await transaction
    }
    await db.queryCompiled({ sql: 'SELECT $1::text AS value', bindings: ['private-value'], source: 'query' })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sql).toBe('[SQL REDACTED]')
    expect(entries[0]?.bindings).toEqual(['[REDACTED]'])
    await vi.waitFor(async () => {
      const backends = await observer.query<{ count: number }>('SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = $1', [first?.pid])
      expect(backends.rows[0]?.count).toBe(0)
    }, { timeout: 150, interval: 10 })
    expect((await session()).rows[0]?.pid).not.toBe(first?.pid)
  })

  it.each([
    { max: 0 }, { max: 1.5 }, { connectionTimeoutMillis: -1 }, { idleTimeoutMillis: Number.NaN },
  ])('rejects invalid pool budgets before creating a connection: %j', budget => {
    expect(() => resolveRuntimeConnectionManagerOptions({ db: { connections: { main: { driver: 'postgres', ...budget } } } })).toThrow('must be an integer')
  })
})
