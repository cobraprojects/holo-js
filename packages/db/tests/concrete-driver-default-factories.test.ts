import { beforeEach, describe, expect, it, vi } from 'vitest'

const mysqlClient = {
  end: vi.fn(async () => {}),
  query: vi.fn(async (sql: string, bindings: unknown[]) => [[{ sql, bindings }], []] as const),
  release: vi.fn(),
}
const mysqlPool = {
  end: vi.fn(async () => {}),
  getConnection: vi.fn(async () => mysqlClient),
  query: vi.fn(async (sql: string, bindings: unknown[]) => [[{ sql, bindings }], []] as const),
}
const createMySQLPool = vi.fn(() => mysqlPool)

vi.mock('mysql2/promise', () => ({
  default: { createPool: createMySQLPool },
}))

describe('concrete driver default factories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adapts the native MySQL pool and leased clients', async () => {
    const { createMySQLAdapter } = await import('@holo-js/db-mysql')
    const adapter = createMySQLAdapter({ uri: 'mysql://localhost/application' })

    await adapter.initialize()
    await expect(adapter.query('SELECT ?', [1])).resolves.toEqual({
      rowCount: 1,
      rows: [{ bindings: [1], sql: 'SELECT ?' }],
    })
    await expect(adapter.runWithTransactionScope(async () => adapter.query('SELECT ?', [2])))
      .resolves.toEqual({
        rowCount: 1,
        rows: [{ bindings: [2], sql: 'SELECT ?' }],
      })
    await adapter.disconnect()

    expect(createMySQLPool).toHaveBeenCalledWith({ uri: 'mysql://localhost/application' })
    expect(mysqlPool.query).toHaveBeenCalledWith('SELECT ?', [1])
    expect(mysqlClient.query).toHaveBeenCalledWith('SELECT ?', [2])
    expect(mysqlClient.release).toHaveBeenCalledTimes(1)
    expect(mysqlPool.end).toHaveBeenCalledTimes(1)
  })
})
