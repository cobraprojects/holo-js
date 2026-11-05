import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { integrationDrivers, mysqlIntegration, mysqlTestConnection, postgresIntegration, postgresTestConnection, testConnectionUrl } from '../../../tests/support/real-database'
import { openDatabase } from './support/database'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('real database test support', () => {
  it.each([
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE'],
    ['mysql', 'HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE'],
  ] as const)('refuses to open %s without an explicit test database', async (driver, flag, database) => {
    vi.stubEnv(flag, '1')
    vi.stubEnv(database, undefined)
    await expect(openDatabase(driver)).rejects.toThrow(`${database} must name a scratch test database`)
  })

  it.each([
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE', 'postgres'],
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE', 'template1'],
    ['mysql', 'HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE', 'mysql'],
    ['mysql', 'HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE', 'Information_Schema'],
    ['mysql', 'HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE', 'sys'],
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE', '.'],
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE', '..'],
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE', 'postgres#scratch'],
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE', 'holo?test'],
    ['mysql', 'HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE', 'holo/test'],
    ['mysql', 'HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE', 'holo test'],
  ] as const)('refuses %s when %s is on and %s is the system or unsafe name %s', async (driver, flag, database, name) => {
    vi.stubEnv(flag, '1')
    vi.stubEnv(database, name)
    await expect(openDatabase(driver)).rejects.toThrow(`${database} must name a scratch test database`)
  })

  it.each([
    ['postgres', 'HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE'],
    ['mysql', 'HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE'],
  ] as const)('refuses to open %s when its integration flag is off', async (driver, flag, database) => {
    vi.stubEnv(flag, undefined)
    vi.stubEnv(database, 'holo_scratch')
    await expect(openDatabase(driver)).rejects.toThrow(`${flag}=1`)
  })

  it('reads the connection of each real database from the environment', () => {
    vi.stubEnv('HOLO_POSTGRES_INTEGRATION', '1')
    vi.stubEnv('HOLO_POSTGRES_HOST', 'pg.test')
    vi.stubEnv('HOLO_POSTGRES_PORT', '6543')
    vi.stubEnv('HOLO_POSTGRES_USER', 'tester')
    vi.stubEnv('HOLO_POSTGRES_PASSWORD', 'secret')
    vi.stubEnv('HOLO_POSTGRES_DATABASE', 'holo_pg_scratch')
    vi.stubEnv('HOLO_MYSQL_INTEGRATION', '1')
    vi.stubEnv('HOLO_MYSQL_HOST', 'my.test')
    vi.stubEnv('HOLO_MYSQL_PORT', '3307')
    vi.stubEnv('HOLO_MYSQL_USER', 'tester')
    vi.stubEnv('HOLO_MYSQL_PASSWORD', 'secret')
    vi.stubEnv('HOLO_MYSQL_DATABASE', 'holo_my_scratch')
    expect(postgresTestConnection()).toEqual({ host: 'pg.test', port: 6543, user: 'tester', password: 'secret', database: 'holo_pg_scratch' })
    expect(mysqlTestConnection()).toEqual({ host: 'my.test', port: 3307, user: 'tester', password: 'secret', database: 'holo_my_scratch' })
  })

  it.each([
    ['HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE', postgresTestConnection],
    ['HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE', mysqlTestConnection],
  ] as const)('refuses a %s connection without a scratch database', (flag, database, connection) => {
    vi.stubEnv(flag, '1')
    vi.stubEnv(database, undefined)
    expect(() => connection()).toThrow(`${database} must name a scratch test database`)
    vi.stubEnv(database, 'holo_scratch')
    vi.stubEnv(flag, undefined)
    expect(() => connection()).toThrow(`${flag}=1`)
  })

  it.each(['postgresql', 'mysql'] as const)('builds a %s URL that names exactly the scratch database it was given', scheme => {
    const url = testConnectionUrl(scheme, { host: 'db.test', port: 5433, user: 'te@st', password: 'p#ss/word', database: 'postgres#scratch?x=1' })
    expect(url.protocol).toBe(`${scheme}:`)
    expect(url.hash).toBe('')
    expect(url.search).toBe('')
    expect(decodeURIComponent(url.pathname.slice(1))).toBe('postgres#scratch?x=1')
    expect(decodeURIComponent(url.username)).toBe('te@st')
    expect(decodeURIComponent(url.password)).toBe('p#ss/word')
    expect(testConnectionUrl(scheme, { host: 'db.test', port: 5433, user: 'tester', database: 'holo_scratch' }).toString()).toBe(`${scheme}://tester@db.test:5433/holo_scratch`)
  })

  it.each([
    ['postgresql', '127.0.0.1/postgres#', 5432],
    ['mysql', '127.0.0.1/mysql#', 3306],
    ['mysql', 'user@db.test', 3306],
    ['postgresql', 'db.test?db=postgres', 5432],
    ['postgresql', 'db.test', Number.NaN],
  ] as const)('refuses to build a %s URL whose host %s or port %s could change the database', (scheme, host, port) => {
    expect(() => testConnectionUrl(scheme, { host, port, user: 'tester', database: 'holo_scratch' })).toThrow('must be a plain host name and port')
  })

  it('keeps only the drivers whose integration flag is on', () => {
    vi.stubEnv('HOLO_POSTGRES_INTEGRATION', '1')
    vi.stubEnv('HOLO_MYSQL_INTEGRATION', undefined)
    expect(integrationDrivers(['sqlite', 'postgres', 'mysql'])).toEqual(['sqlite', 'postgres'])
    vi.stubEnv('HOLO_POSTGRES_INTEGRATION', undefined)
    vi.stubEnv('HOLO_MYSQL_INTEGRATION', '1')
    expect(integrationDrivers(['sqlite', 'postgres', 'mysql'])).toEqual(['sqlite', 'mysql'])
  })

  it.runIf(postgresIntegration)('drops a postgres fixture through the connection it opened after the environment changes', async () => {
    const adapter = createPostgresAdapter({ config: postgresTestConnection() })
    let fixture = ''
    onTestFinished(async () => {
      try {
        expect((await adapter.query<{ found: string | null }>('SELECT to_regclass($1)::text AS found', [fixture])).rows).toEqual([{ found: null }])
      } finally {
        vi.unstubAllEnvs()
        await adapter.disconnect()
      }
    })
    fixture = (await openDatabase('postgres')).table.tableName
    onTestFinished(() => { vi.stubEnv('HOLO_POSTGRES_DATABASE', undefined) })
  })

  it.runIf(mysqlIntegration)('drops a mysql fixture through the connection it opened after the environment changes', async () => {
    const connection = mysqlTestConnection()
    const adapter = createMySQLAdapter({ config: connection })
    let fixture = ''
    onTestFinished(async () => {
      try {
        expect((await adapter.query<{ found: number }>('SELECT COUNT(*) AS found FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [connection.database, fixture.split('.').at(-1)])).rows).toEqual([{ found: 0 }])
      } finally {
        vi.unstubAllEnvs()
        await adapter.disconnect()
      }
    })
    fixture = (await openDatabase('mysql')).table.tableName
    onTestFinished(() => { vi.stubEnv('HOLO_MYSQL_DATABASE', undefined) })
  })
})
