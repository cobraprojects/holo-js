import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createPostgresAdapter, postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import {
  column,
  configureDB,
  defineGeneratedTable,
  defineModel,
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

function connectionUrl(searchPath?: string): string {
  const url = new URL(`postgresql://${host}:${port}/${database}`)
  url.username = username
  if (password) url.password = password
  if (searchPath) url.searchParams.set('options', `-c statement_timeout=5000 -c search_path=${searchPath}`)
  return url.toString()
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

async function createNotesTables(schemas: readonly string[], tableName: string): Promise<void> {
  const admin = createPostgresAdapter({ config: { host, port, user: username, password, database } })
  onTestFinished(async () => {
    for (const schema of schemas.filter(name => name !== 'public')) await admin.execute(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`)
    await admin.execute(`DROP TABLE IF EXISTS public.${quoted(tableName)}`)
    await admin.disconnect()
  })
  for (const schema of schemas) {
    if (schema !== 'public') await admin.execute(`CREATE SCHEMA ${quoted(schema)}`)
    await admin.execute(`CREATE TABLE ${quoted(schema)}.${quoted(tableName)} (id SERIAL PRIMARY KEY, body TEXT NOT NULL)`)
    await admin.execute(`INSERT INTO ${quoted(schema)}.${quoted(tableName)} (body) VALUES ($1)`, [`seeded in ${schema}`])
  }
}

function connectTo(connection: Record<string, unknown>) {
  const manager = resolveRuntimeConnectionManagerOptions({ db: { connections: { main: { driver: 'postgres', ...connection } } } })
  configureDB(manager)
  onTestFinished(async () => {
    await manager.disconnectAll()
    resetDB()
  })
  return manager.connection()
}

async function bodiesThroughQueriesAndModels(connection: Record<string, unknown>, tableName: string): Promise<string[]> {
  const db = connectTo(connection)
  const Note = defineModel(defineGeneratedTable(tableName, { id: column.id(), body: column.string() }), { timestamps: false, fillable: ['body'] })
  await db.table(tableName).insert({ body: 'query builder' })
  await Note.create({ body: 'model' })
  await db.transaction(async tx => tx.table(tableName).insert({ body: 'transaction' }))
  return (await Note.query().orderBy('id').get()).map(note => note.get('body'))
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('PostgreSQL search_path from the configured schema', () => {
  it.each([
    { mode: 'url', connection: (schema: string) => ({ url: connectionUrl(), schema }) },
    { mode: 'structured', connection: (schema: string) => ({ host, port, username, password, database, schema }) },
  ])('reads and writes the configured schema through unqualified queries and models with $mode configuration', async ({ connection }) => {
    const suffix = randomUUID().replaceAll('-', '')
    const tenant = `Holo "tenant" ${suffix}`
    const tableName = `holo_notes_${suffix}`
    await createNotesTables(['public', tenant], tableName)

    expect(await bodiesThroughQueriesAndModels(connection(tenant), tableName))
      .toEqual([`seeded in ${tenant}`, 'query builder', 'model', 'transaction'])

    const publicRows = await connectTo({ url: connectionUrl() }).table(`public.${tableName}`).pluck('body')
    expect(publicRows).toEqual(['seeded in public'])
  }, 30_000)

  it('keeps the public schema for the default schema setting', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const tableName = `holo_notes_${suffix}`
    await createNotesTables(['public'], tableName)

    expect(await bodiesThroughQueriesAndModels({ url: connectionUrl(), schema: 'public' }, tableName))
      .toEqual(['seeded in public', 'query builder', 'model', 'transaction'])
  }, 30_000)

  it('lets a search_path in the connection URL options win over the configured schema', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const tenant = `holo_tenant_${suffix}`
    const explicit = `holo_explicit_${suffix}`
    const tableName = `holo_notes_${suffix}`
    await createNotesTables([tenant, explicit], tableName)

    expect(await bodiesThroughQueriesAndModels({ url: connectionUrl(explicit), schema: tenant }, tableName))
      .toEqual([`seeded in ${explicit}`, 'query builder', 'model', 'transaction'])
    const timeout = await connectTo({ url: connectionUrl(explicit), schema: tenant })
      .queryCompiled<{ statement_timeout: string }>({ sql: 'SHOW statement_timeout', source: 'query' })
    expect(timeout.rows).toEqual([{ statement_timeout: '5s' }])
  }, 30_000)

  it('keeps PGOPTIONS settings and lets their search_path win over the configured schema', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const tenant = `holo_tenant_${suffix}`
    const explicit = `holo_explicit_${suffix}`
    const tableName = `holo_notes_${suffix}`
    await createNotesTables([tenant, explicit], tableName)
    vi.stubEnv('PGOPTIONS', `-c statement_timeout=7000 -c search_path=${explicit}`)
    onTestFinished(() => { vi.unstubAllEnvs() })

    expect(await bodiesThroughQueriesAndModels({ url: connectionUrl(), schema: tenant }, tableName))
      .toEqual([`seeded in ${explicit}`, 'query builder', 'model', 'transaction'])
    const timeout = await connectTo({ url: connectionUrl(), schema: tenant })
      .queryCompiled<{ statement_timeout: string }>({ sql: 'SHOW statement_timeout', source: 'query' })
    expect(timeout.rows).toEqual([{ statement_timeout: '7s' }])
  }, 30_000)
})
