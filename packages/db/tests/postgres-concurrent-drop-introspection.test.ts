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

function connectToTestSchema() {
  const manager = resolveRuntimeConnectionManagerOptions({ db: { connections: { main: { driver: 'postgres', host, port, username, password, database, schema: schemaName } } } })
  configureDB(manager)
  onTestFinished(async () => {
    await manager.disconnectAll()
    resetDB()
  })
  return manager.connection()
}

function openAdapter() {
  const connection = createPostgresAdapter({ config })
  onTestFinished(async () => { await connection.disconnect() })
  return connection
}

type Settled<T> = { value: T } | { error: unknown }

async function waitForBlockedReader(observer: ReturnType<typeof openAdapter>, relationId: string, read: Promise<Settled<unknown>>): Promise<void> {
  let settled = false
  void read.then(() => { settled = true })
  const deadline = Date.now() + 10_000
  for (;;) {
    const waiting = await observer.query<{ waiting: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) AND relation = $1::oid AND NOT granted) AS waiting',
      [relationId],
    )
    if (waiting.rows[0]?.waiting === true) return
    if (settled) throw new Error('The schema read finished without waiting on the dropped table lock.')
    if (Date.now() > deadline) throw new Error('The schema read never waited on the dropped table lock.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function readWhileDropCommits<T>(tableName: string, read: () => Promise<T>): Promise<T> {
  const dropper = createPostgresAdapter({ config })
  let dropOpen = false
  onTestFinished(async () => {
    if (dropOpen) await dropper.rollback()
    await dropper.disconnect()
  })
  const observer = openAdapter()
  const relation = await observer.query<{ id: string }>('SELECT $1::regclass::oid::text AS id', [`${schemaName}.${tableName}`])
  const relationId = relation.rows[0]?.id
  if (relationId === undefined) throw new Error(`The table ${tableName} was not created.`)
  await dropper.beginTransaction()
  dropOpen = true
  await dropper.execute(`DROP TABLE ${schemaName}.${tableName}`)
  const result: Promise<Settled<T>> = read().then(value => ({ value }), (error: unknown) => ({ error }))
  await waitForBlockedReader(observer, relationId, result)
  await dropper.commit()
  dropOpen = false
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
    const reader = holoRuntimeInternals.createSchemaReader(connectToTestSchema())

    expect(await readWhileDropCommits(tableName, () => reader.readTableStructure(tableName))).toBeUndefined()
  }, 30_000)

  it('reads a table dropped during introspection inside a repeatable read transaction as missing', async () => {
    const tableName = await createCheckedTable()

    const structure = await connectToTestSchema().transaction(async (tx) => {
      await tx.queryCompiled({ sql: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', source: 'query' })
      const reader = holoRuntimeInternals.createSchemaReader(tx)
      return readWhileDropCommits(tableName, () => reader.readTableStructure(tableName))
    })

    expect(structure).toBeUndefined()
  }, 30_000)

  it('leaves a table dropped during introspection out of the generated schema', async () => {
    const kept = await createCheckedTable()
    const dropped = await createCheckedTable()
    const reader = holoRuntimeInternals.createSchemaReader(connectToTestSchema())

    const tables = await readWhileDropCommits(dropped, () => reader.readGeneratedSchema())

    expect(tables.map(table => table.tableName)).toEqual([kept])
  }, 30_000)
})
