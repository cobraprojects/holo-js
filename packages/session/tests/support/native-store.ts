import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { onTestFinished } from 'vitest'
import { createSQLiteQueueHarness } from '../../../queue-db/tests/support/sqlite-queue'
import { createCoreDatabaseSessionAdapter } from '../../../core/src/portable/sessionPersistence'
import migration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044033_create_sessions'
import { createDatabaseSessionStore, createFileSessionStore, createRedisSessionStore, type SessionStore } from '../../src'
import { createSessionRedisAdapter } from '../../src/drivers/redis-adapter'
import { startRedisService } from './redis'

export async function createNativeSessionStore(driver: 'database' | 'file' | 'redis'): Promise<SessionStore> {
  if (driver === 'file') {
    const root = await mkdtemp(join(tmpdir(), 'holo-native-session-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    return createFileSessionStore(root)
  }
  if (driver === 'redis') {
    const service = await startRedisService()
    const port = service.ports[0]
    if (!port) throw new Error('Expected a native Redis port')
    const adapter = createSessionRedisAdapter({ name: 'redis', driver: 'redis', connection: 'default', host: '127.0.0.1', port, db: 0, prefix: `native-session:${randomUUID()}:` })
    await adapter.connect()
    onTestFinished(() => adapter.disconnect())
    return createRedisSessionStore(adapter)
  }
  const harness = await createSQLiteQueueHarness()
  onTestFinished(() => harness.cleanup())
  await migration.up({ db: harness.connection, schema: harness.schema })
  return createDatabaseSessionStore(createCoreDatabaseSessionAdapter('sessions', 'default'))
}
