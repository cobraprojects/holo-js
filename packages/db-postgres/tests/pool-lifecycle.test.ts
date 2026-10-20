import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createPostgresAdapter } from '../src'

const livePostgresConfig = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
  password: process.env.HOLO_POSTGRES_PASSWORD,
  database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
}

describe('@holo-js/db-postgres pool lifecycle', () => {
  it('reports and recovers from an idle pooled connection the server terminates', async () => {
    const applicationName = `holo_idle_${randomUUID()}`
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, application_name: applicationName, max: 1 } })
    const admin = createPostgresAdapter({ config: livePostgresConfig })
    try {
      const first = await adapter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await admin.execute(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()',
        [applicationName],
      )
      await vi.waitFor(() => expect(errorLog).toHaveBeenCalled())
      const next = await adapter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      expect(next.rows[0]?.pid).not.toBe(first.rows[0]?.pid)
    } finally {
      errorLog.mockRestore()
      await adapter.disconnect()
      await admin.disconnect()
    }
  }, 30_000)

  it('resolves disconnect only after its pooled sessions have closed', async () => {
    const applicationName = `holo_close_${randomUUID()}`
    const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, application_name: applicationName, max: 4 } })
    const admin = createPostgresAdapter({ config: livePostgresConfig })
    try {
      await Promise.all(Array.from({ length: 4 }, () => adapter.query('SELECT pg_sleep(0.01)')))
      await adapter.disconnect()
      expect((await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1',
        [applicationName],
      )).rows).toEqual([{ count: 0 }])
    } finally {
      await adapter.disconnect()
      await admin.disconnect()
    }
  }, 30_000)
})
