import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queryObjects } from 'node:v8'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createDatabase, createDialect, createQueryScheduler } from '../src'

function exclusiveGateClass(): new () => unknown {
  const scheduler = createQueryScheduler({ connectionName: 'default', supportsConcurrentQueries: false, supportsWorkerThreads: false })
  return (scheduler as unknown as { ownGate: { constructor: new () => unknown } }).ownGate.constructor
}

async function useAndDiscardDatabases(directory: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const filename = join(directory, `database-${index}.sqlite`)
    await writeFile(filename, '')
    const db = createDatabase({ adapter: createSQLiteAdapter({ filename }), dialect: createDialect('sqlite') })
    await db.transaction(async (tx) => {
      await tx.queryCompiled({ sql: 'SELECT 1', bindings: [], source: 'schema' })
    })
    await db.disconnect()
  }
}

describe('query scheduler gates for SQLite files', () => {
  it('lets the gate of a SQLite file go once no connection to that file is left', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-gate-retention-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const gateClass = exclusiveGateClass()
    const before = queryObjects(gateClass, { format: 'count' })

    await useAndDiscardDatabases(directory, 20)

    expect(queryObjects(gateClass, { format: 'count' }) - before).toBeLessThanOrEqual(1)
  })
})
