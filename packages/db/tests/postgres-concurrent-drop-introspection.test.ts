import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { createPostgresAdapter, postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import {
  configureDB,
  holoRuntimeInternals,
  registerDatabaseDriverFactory,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
} from '../src'

registerDatabaseDriverFactory(postgresDatabaseDriverFactory)

const host = process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1'
const port = Number(process.env.HOLO_POSTGRES_PORT ?? 5432)
const username = process.env.HOLO_POSTGRES_USER ?? 'postgres'
const password = process.env.HOLO_POSTGRES_PASSWORD
const database = process.env.HOLO_POSTGRES_DATABASE ?? 'postgres'
const config = { host, port, user: username, password, database }
const schemaName = `holo_dropped_${randomUUID().replaceAll('-', '')}`

function connectTo() {
  const manager = resolveRuntimeConnectionManagerOptions({ db: { connections: { main: { driver: 'postgres', host, port, username, password, database, schema: schemaName } } } })
  configureDB(manager)
  onTestFinished(async () => {
    await manager.disconnectAll()
    resetDB()
  })
  return manager.connection()
}

function adapter() {
  const connection = createPostgresAdapter({ config })
  onTestFinished(async () => { await connection.disconnect() })
  return connection
}

async function waitForBlockedReader(observer: ReturnType<typeof adapter>, relationId: number): Promise<void> {
  for (;;) {
    const waiting = await observer.query<{ waiting: string }>('SELECT count(*)::text AS waiting FROM pg_catalog.pg_locks WHERE relation = $1 AND NOT granted', [relationId])
    if (waiting.rows[0]?.waiting !== '0') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function readWhileDropCommits<T>(tableName: string, read: () => Promise<T>): Promise<T> {
  const dropper = adapter()
  const observer = adapter()
  const relation = await observer.query<{ id: number }>('SELECT $1::regclass::oid::int AS id', [`${schemaName}.${tableName}`])
  const relationId = relation.rows[0]!.id
  await dropper.beginTransaction()
  await dropper.execute(`DROP TABLE ${schemaName}.${tableName}`)
  const result = read().then(value => ({ value }), (error: unknown) => ({ error }))
  await waitForBlockedReader(observer, relationId)
  await dropper.commit()
  const settled = await result
  if ('error' in settled) throw settled.error
  return settled.value
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('PostgreSQL schema introspection of a concurrently dropped table', () => {
  const admin = createPostgresAdapter({ config })

  beforeAll(async () => {
    await admin.execute(`CREATE SCHEMA ${schemaName}`)
  })

  afterAll(async () => {
    await admin.execute(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    await admin.disconnect()
  })

  async function createCheckedTable(): Promise<string> {
    const tableName = `holo_posts_${randomUUID().replaceAll('-', '')}`
    await admin.execute(`CREATE TABLE ${schemaName}.${tableName} (id integer PRIMARY KEY, status text NOT NULL CHECK (status IN ('draft', 'published')))`)
    onTestFinished(async () => { await admin.execute(`DROP TABLE IF EXISTS ${schemaName}.${tableName}`) })
    return tableName
  }

  it('reads a table dropped during introspection as missing', async () => {
    const tableName = await createCheckedTable()
    const reader = holoRuntimeInternals.createSchemaReader(connectTo())

    expect(await readWhileDropCommits(tableName, () => reader.readTableStructure(tableName))).toBeUndefined()
  }, 30_000)

  it('leaves a table dropped during introspection out of the generated schema', async () => {
    const kept = await createCheckedTable()
    const dropped = await createCheckedTable()
    const reader = holoRuntimeInternals.createSchemaReader(connectTo())

    const tables = await readWhileDropCommits(dropped, () => reader.readGeneratedSchema())

    expect(tables.map(table => table.tableName)).toEqual([kept])
  }, 30_000)
})
