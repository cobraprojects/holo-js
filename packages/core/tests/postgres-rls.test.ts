import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { DB, defineMigration } from '@holo-js/db'
import { expect, it } from 'vitest'
import { createHolo } from '../src/portable'

it.runIf(process.env.HOLO_POSTGRES_INTEGRATION === '1')('native app policy enables RLS migrations and isolates transaction-local tenant context', async () => {
  const name = `holo_rls_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(join(tmpdir(), 'holo-native-rls-'))
  const config = {
    host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
    database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
  }
  const admin = createPostgresAdapter({ config: { ...config, user: 'postgres' } })
  let runtime: Awaited<ReturnType<typeof createHolo>> | undefined
  try {
    await admin.execute(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS`)
    await admin.execute(`CREATE SCHEMA ${name} AUTHORIZATION ${name}`)
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
    await symlink(resolve(import.meta.dirname, '../../db-postgres'), join(root, 'node_modules/@holo-js/db-postgres'))
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))}
export default defineAppConfig({ name: 'RLS test', env: 'test', key: 'rls-test-key' })
`)
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${JSON.stringify(resolve(import.meta.dirname, '../../db/src/index.ts'))}
const connection = ${JSON.stringify({ driver: 'postgres', ...config, username: name, schema: name })} as const
export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: { ...connection, security: { allowUnsafeRawSql: true } },
    locked: connection,
    denied: { ...connection, security: { allowUnsafeRawSql: false } },
  },
})
`)
    runtime = await createHolo(root, { processEnv: {} })
    await runtime.initialize()
    const db = runtime.manager.connection()
    const table = `"${name}"."records"`
    const migrations = db.getMigrationService()
    migrations.register(defineMigration({
      name: '2026_10_11_120000_create_tenant_records',
      async up({ schema, db }) {
        await schema.createTable('records', table => {
          table.string('tenant_id')
          table.string('value')
        })
        await db.unsafeExecute(DB.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
        await db.unsafeExecute(DB.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`))
        await db.unsafeExecute(DB.raw(`CREATE POLICY tenant_context ON ${table}
          USING (tenant_id = nullif(current_setting('holo.tenant_id', true), ''))
          WITH CHECK (tenant_id = nullif(current_setting('holo.tenant_id', true), ''))`))
      },
      async down({ schema }) { await schema.dropTable('records') },
    }))
    await migrations.migrate()
    await db.transaction(async tx => {
      await tx.unsafeQuery(DB.raw("SELECT set_config('holo.tenant_id', $1, true)", ['tenant-a']))
      await DB.table('records').insert({ tenant_id: 'tenant-a', value: 'a' })
    })
    await db.transaction(async tx => {
      await tx.unsafeQuery(DB.raw("SELECT set_config('holo.tenant_id', $1, true)", ['tenant-b']))
      await DB.table('records').insert({ tenant_id: 'tenant-b', value: 'b' })
      expect(await DB.table('records').get()).toEqual([{ tenant_id: 'tenant-b', value: 'b' }])
    })
    expect(await DB.table('records').get()).toEqual([])
    let transactionsReady = 0
    let releaseTransactions: () => void = () => {}
    const bothReady = new Promise<void>(resolve => { releaseTransactions = resolve })
    await Promise.all([
      { tenant: 'tenant-a', value: 'a' },
      { tenant: 'tenant-b', value: 'b' },
    ].map(async ({ tenant, value }) => {
      await db.transaction(async tx => {
        await tx.unsafeQuery(DB.raw("SELECT set_config('holo.tenant_id', $1, true)", [tenant]))
        transactionsReady += 1
        if (transactionsReady === 2) releaseTransactions()
        await bothReady
        expect(await DB.table('records').get()).toEqual([{ tenant_id: tenant, value }])
      })
    }))
    expect(await DB.table('records').get()).toEqual([])
    await expect(db.transaction(async tx => {
      await tx.unsafeQuery(DB.raw("SELECT set_config('holo.tenant_id', $1, true)", ['tenant-a']))
      await DB.table('records').insert({ tenant_id: 'tenant-b', value: 'forbidden' })
    })).rejects.toThrow('row-level security')
    await expect(db.transaction(async tx => {
      await tx.unsafeQuery(DB.raw("SELECT set_config('holo.tenant_id', $1, true)", ['tenant-a']))
      expect(await DB.table('records').get()).toEqual([{ tenant_id: 'tenant-a', value: 'a' }])
      throw new Error('roll back tenant context')
    })).rejects.toThrow('roll back tenant context')
    expect(await DB.table('records').get()).toEqual([])
    for (const connection of ['locked', 'denied']) {
      await expect(runtime.manager.connection(connection).unsafeQuery(DB.raw('SELECT 1'))).rejects.toThrow('Unsafe raw SQL is disabled')
    }
    await migrations.rollback()
    expect(await migrations.status()).toMatchObject([{ status: 'pending' }])
  } finally {
    await runtime?.shutdown()
    await admin.execute(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
    await admin.execute(`DROP ROLE IF EXISTS ${name}`)
    await admin.disconnect()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
