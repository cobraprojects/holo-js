import { afterEach, describe, expect, it, vi } from 'vitest'
import { integrationDrivers, mysqlTestConnection, openDatabase, postgresTestConnection } from './support/database'

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
  ] as const)('refuses to open %s on the %s system database %s', async (driver, flag, database, name) => {
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

  it('keeps only the drivers whose integration flag is on', () => {
    vi.stubEnv('HOLO_POSTGRES_INTEGRATION', '1')
    vi.stubEnv('HOLO_MYSQL_INTEGRATION', undefined)
    expect(integrationDrivers(['sqlite', 'postgres', 'mysql'])).toEqual(['sqlite', 'postgres'])
    vi.stubEnv('HOLO_POSTGRES_INTEGRATION', undefined)
    vi.stubEnv('HOLO_MYSQL_INTEGRATION', '1')
    expect(integrationDrivers(['sqlite', 'postgres', 'mysql'])).toEqual(['sqlite', 'mysql'])
  })
})
