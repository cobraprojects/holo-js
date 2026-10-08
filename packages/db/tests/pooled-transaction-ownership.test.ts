import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { describe, expect, it } from 'vitest'
import { createDatabase, createDialect, unsafeSql, type DriverAdapter } from '../src'

type ClientState = {
  id: number
  releases: number
  ends: number
}

function createFixture(driver: 'postgres' | 'mysql', direct = false) {
  const clients: ClientState[] = []
  let poolQueries = 0
  let poolEnds = 0

  function createClient() {
    const state: ClientState = { id: clients.length + 1, releases: 0, ends: 0 }
    clients.push(state)
    return {
      query(sql: string) {
        if (sql === 'FAIL' || sql === 'COMMIT') {
          throw new Error(sql)
        }
        return [{ clientId: state.id }]
      },
      release() { state.releases += 1 },
      async end() { state.ends += 1 },
    }
  }

  function postgresClient() {
    const client = createClient()
    return {
      async query(sql: string) { return { rows: client.query(sql), rowCount: 1 } },
      release: client.release,
      end: client.end,
    }
  }

  function mysqlClient() {
    const client = createClient()
    return {
      async query(sql: string) { return [client.query(sql), []] as const },
      release: client.release,
      end: client.end,
    }
  }

  const adapter = driver === 'postgres'
    ? createPostgresAdapter(direct ? { client: postgresClient() } : {
        pool: {
          async query() {
            poolQueries += 1
            return { rows: [], rowCount: 0 }
          },
          async connect() { return postgresClient() },
          async end() { poolEnds += 1 },
        },
      })
    : createMySQLAdapter(direct ? { client: mysqlClient() } : {
        pool: {
          async query() {
            poolQueries += 1
            return [[], []] as const
          },
          async getConnection() { return mysqlClient() },
          async end() { poolEnds += 1 },
        },
      })

  return { adapter, clients, get poolQueries() { return poolQueries }, get poolEnds() { return poolEnds } }
}

async function clientId(adapter: DriverAdapter): Promise<number | undefined> {
  return (await adapter.query<{ clientId: number }>('SELECT client')).rows[0]?.clientId
}

describe.each(['postgres', 'mysql'] as const)('%s pooled transaction ownership', driver => {
  it('retains one lease through nested scopes and failed transaction commands until scope exit', async () => {
    const fixture = createFixture(driver)
    const { adapter, clients } = fixture

    await expect(adapter.runWithTransactionScope(async () => {
      await adapter.beginTransaction()
      expect(await clientId(adapter)).toBe(1)
      await adapter.runWithTransactionScope(async () => {
        expect(await clientId(adapter)).toBe(1)
      })
      await expect(adapter.commit()).rejects.toThrow('COMMIT')
      await adapter.rollback()
      expect(clients[0]?.releases).toBe(0)
      await adapter.query('FAIL')
    })).rejects.toThrow('FAIL')

    expect(clients).toHaveLength(1)
    expect(clients[0]?.releases).toBe(1)
    await adapter.query('SELECT root')
    expect(fixture.poolQueries).toBe(1)
    await adapter.disconnect()
    expect(clients[0]?.releases).toBe(1)
  })

  it('isolates overlapping scopes from each other and from an adapter-wide lease', async () => {
    const { adapter, clients } = createFixture(driver)
    await adapter.beginTransaction()
    let resume!: () => void
    let ready!: () => void
    const paused = new Promise<void>(resolve => { ready = resolve })
    const resumed = new Promise<void>(resolve => { resume = resolve })
    const first = adapter.runWithTransactionScope(async () => {
      expect(await clientId(adapter)).toBe(2)
      ready()
      await resumed
      expect(await clientId(adapter)).toBe(2)
      await adapter.rollback()
      expect(clients[1]?.releases).toBe(0)
    })

    try {
      await paused
      await adapter.runWithTransactionScope(async () => {
        expect(await clientId(adapter)).toBe(3)
        await adapter.rollback()
      })
      expect(clients.map(client => client.releases)).toEqual([0, 0, 1])
      expect(await clientId(adapter)).toBe(1)
    } finally {
      resume()
      await first
      await adapter.rollback()
      await adapter.disconnect()
    }

    expect(clients.map(client => client.releases)).toEqual([1, 1, 1])
  })

  it('retains a failed adapter-wide commit for rollback and releases on disconnect', async () => {
    const fixture = createFixture(driver)
    const { adapter, clients } = fixture
    await adapter.beginTransaction()
    await expect(adapter.commit()).rejects.toThrow('COMMIT')
    expect(await clientId(adapter)).toBe(1)
    expect(clients[0]?.releases).toBe(0)
    await adapter.rollback()
    expect(clients[0]?.releases).toBe(1)
    await expect(adapter.rollback()).rejects.toThrow('No active')
    await adapter.beginTransaction()
    await adapter.disconnect()
    await adapter.disconnect()
    expect(clients.map(client => client.releases)).toEqual([1, 1])
    expect(fixture.poolEnds).toBe(1)
  })

  it('reuses direct clients without releasing them on scope exit or rollback', async () => {
    const { adapter, clients } = createFixture(driver, true)
    await expect(adapter.runWithTransactionScope(async () => {
      await adapter.runWithTransactionScope(async () => {
        expect(await clientId(adapter)).toBe(1)
        await adapter.beginTransaction()
        await adapter.rollback()
      })
      throw new Error('callback failed')
    })).rejects.toThrow('callback failed')
    await adapter.beginTransaction()
    await adapter.rollback()
    expect(clients[0]?.releases).toBe(0)
    await adapter.disconnect()
    expect(clients[0]?.releases).toBe(0)
    expect(clients[0]?.ends).toBe(1)
  })
})


describe.each(['postgres', 'mysql'] as const)('%s native transaction ownership', driver => {
  const enabled = process.env[`HOLO_${driver.toUpperCase()}_INTEGRATION`] === '1'

  it.runIf(enabled)('isolates overlapping transactions and rolls back nested and failed callbacks', async () => {
    const tableName = `holo_leases_${randomUUID().replaceAll('-', '')}`
    const adapter = driver === 'postgres'
      ? createPostgresAdapter({ config: {
          host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
          port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
          user: 'postgres',
          database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
          max: 2,
        } })
      : createMySQLAdapter({ config: {
          host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
          port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
          user: 'root',
          database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
          connectionLimit: 2,
        } })
    const db = createDatabase({ adapter, dialect: createDialect(driver), security: { allowUnsafeRawSql: true } })
    let resume!: () => void
    let ready!: () => void
    const paused = new Promise<void>(resolve => { ready = resolve })
    const resumed = new Promise<void>(resolve => { resume = resolve })

    try {
      await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, changed INTEGER NOT NULL)`)
      await adapter.execute(`INSERT INTO ${tableName} VALUES (1, 0), (2, 0), (3, 0), (4, 0)`)
      const first = expect(db.transaction(async tx => {
        await tx.unsafeExecute(unsafeSql(`UPDATE ${tableName} SET changed = 1 WHERE id = 1`))
        await expect(tx.transaction(async nested => {
          await nested.unsafeExecute(unsafeSql(`UPDATE ${tableName} SET changed = 1 WHERE id = 2`))
          throw new Error('nested failed')
        })).rejects.toThrow('nested failed')
        expect((await tx.unsafeQuery<{ id: number }>(unsafeSql(`SELECT id FROM ${tableName} WHERE changed = 1`))).rows).toEqual([{ id: 1 }])
        ready()
        await resumed
        throw new Error('outer failed')
      })).rejects.toThrow('outer failed')

      try {
        await paused
        await db.transaction(async tx => {
          await tx.unsafeExecute(unsafeSql(`UPDATE ${tableName} SET changed = 1 WHERE id = 3`))
        })
        expect((await adapter.query(`SELECT id FROM ${tableName} WHERE changed = 1`)).rows).toEqual([{ id: 3 }])
      } finally {
        resume()
        await first
      }

      await db.transaction(async tx => {
        await tx.unsafeExecute(unsafeSql(`UPDATE ${tableName} SET changed = 1 WHERE id = 4`))
      })
      expect((await adapter.query(`SELECT id FROM ${tableName} WHERE changed = 1 ORDER BY id`)).rows).toEqual([{ id: 3 }, { id: 4 }])
    } finally {
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await adapter.disconnect()
    }
  }, 30_000)
})
