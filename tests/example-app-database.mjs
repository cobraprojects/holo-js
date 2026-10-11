import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function openExampleAppDatabase(projectRoot) {
  const require = createRequire(join(projectRoot, 'package.json'))
  const { initializeHoloAdapterProject } = await import(pathToFileURL(require.resolve('@holo-js/core')).href)
  const { DB, createSchemaService } = await import(pathToFileURL(require.resolve('@holo-js/db')).href)
  const project = await initializeHoloAdapterProject(projectRoot)
  return { DB, createSchemaService, close: () => project.runtime.shutdown() }
}

export async function assertExampleAppDatabaseBehavior(DB, createSchemaService) {
  for (const name of ['sqlite', 'postgres', 'mysql']) {
    const connection = DB.connection(name)
    await assert.rejects(connection.unsafeQuery(DB.raw('SELECT 1')), /unsafe/i)
    const schema = createSchemaService(connection)
    await schema.createTable('named_connection_records', table => {
      table.string('value')
    })
    try {
      await DB.transaction(async () => {
        await DB.table('named_connection_records').insert({ value: name })
        assert.deepEqual(await DB.table('named_connection_records').get(), [{ value: name }])
      }, name)
      await assert.rejects(DB.transaction(async () => {
        await DB.table('named_connection_records').insert({ value: 'rollback' })
        throw new Error('named rollback')
      }, name), /named rollback/)
      assert.deepEqual(await DB.table('named_connection_records', name).get(), [{ value: name }])
    } finally {
      await schema.dropTable('named_connection_records')
    }
  }
  const dialect = DB.connection().getDialect().name
  const postgres = dialect === 'postgres'
  const records = () => DB.table('tenant_records')
  const withTenant = async (tenant, callback) => await DB.transaction(async tx => {
    if (postgres) await tx.unsafeQuery(DB.raw("SELECT set_config('holo.tenant_id', $1, true)", [tenant]))
    return await callback(tx)
  })
  const value = "bound'; DROP TABLE tenant_records; --"
  await withTenant('a', async () => {
    await records().insert({ tenant_id: 'a', value })
    assert.deepEqual(await records().where('tenant_id', 'a').get(), [{ tenant_id: 'a', value }])
  })
  await assert.rejects(withTenant('a', async () => {
    await records().insert({ tenant_id: 'a', value: 'rolled back' })
    throw new Error('abort')
  }), /abort/)
  await withTenant('a', async tx => {
    await assert.rejects(tx.transaction(async () => {
      await records().insert({ tenant_id: 'a', value: 'savepoint rollback' })
      throw new Error('savepoint abort')
    }), /savepoint abort/)
    assert.deepEqual(await records().where('tenant_id', 'a').get(), [{ tenant_id: 'a', value }])
  })
  let arrived = 0
  const { promise: bothInserted, resolve: release, reject } = Promise.withResolvers()
  const timeout = setTimeout(() => reject(new Error('Concurrent tenant transactions did not both reach the database')), 10000)
  try {
    await Promise.all(['a', 'b'].map(tenant => withTenant(tenant, async () => {
      await records().insert({ tenant_id: tenant, value: `concurrent-${tenant}` })
      if (dialect !== 'sqlite') {
        if (++arrived === 2) release()
        await bothInserted
      }
      assert.equal(await records().where('tenant_id', tenant).where('value', `concurrent-${tenant}`).count(), 1)
      if (dialect !== 'sqlite') {
        const other = tenant === 'a' ? 'b' : 'a'
        assert.equal(await records().where('tenant_id', other).where('value', `concurrent-${other}`).count(), 0)
      }
    })))
  } finally {
    clearTimeout(timeout)
  }
  if (postgres) {
    assert.deepEqual(await records().get(), [])
    await assert.rejects(withTenant('a', async () => {
      await records().insert({ tenant_id: 'b', value: 'forbidden' })
    }), /row-level security/)
    assert.deepEqual(await records().get(), [])
    assert.deepEqual((await DB.connection().unsafeQuery(DB.raw('SELECT 1 AS value; SELECT 2 AS value;'))).rows, [{ value: 2 }])
    await assert.rejects(DB.connection().unsafeExecute(DB.raw('SELECT 1; SELECT missing_column;')), /missing_column/)
  }
  assert.deepEqual((await DB.connection().unsafeQuery(DB.raw('SELECT 3 AS value'))).rows, [{ value: 3 }])
}
