import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertExampleAppAuthStorageBehavior } from './example-app-auth-storage.mjs'
import { assertExampleAppQueryBehavior } from './example-app-query.mjs'
import { assertExampleAppHostedAuthBehavior, startExampleAppHostedAuthService } from './example-app-hosted-auth.mjs'

export async function openExampleAppDatabase(projectRoot) {
  const require = createRequire(join(projectRoot, 'package.json'))
  const { initializeHoloAdapterProject } = await import(pathToFileURL(require.resolve('@holo-js/core')).href)
  const { DB, createSchemaService } = await import(pathToFileURL(require.resolve('@holo-js/db')).href)
  const service = await startExampleAppHostedAuthService()
  let project
  try {
    project = await initializeHoloAdapterProject(projectRoot, { processEnv: { ...process.env, ...service.processEnv }, preferCache: false })
    await assertExampleAppHostedAuthBehavior(projectRoot, DB, service)
    await assertExampleAppAuthStorageBehavior(projectRoot, DB)
    return { DB, createSchemaService, close: () => project.runtime.shutdown() }
  } catch (error) {
    await project?.runtime.shutdown()
    throw error
  } finally {
    await service.close()
  }
}

export async function assertExampleAppDatabaseBehavior(DB, createSchemaService, projectRoot) {
  const require = createRequire(join(projectRoot, 'package.json'))
  const modelApi = await import(pathToFileURL(require.resolve('@holo-js/db')).href)
  for (const name of ['sqlite', 'postgres', 'mysql']) {
    const connection = DB.connection(name)
    await assert.rejects(connection.unsafeQuery(DB.raw('SELECT 1')), /unsafe/i)
    const schema = createSchemaService(connection)
    await assertExampleAppQueryBehavior(DB, schema, name, modelApi)
    await schema.createTable('named_connection_records', table => {
      table.id()
      table.string('value').unique()
      table.integer('score').default(0)
    })
    try {
      const committed = []
      for (const method of ['transaction', 'writeTransaction']) {
        const value = `${name}:${method}`
        const id = await DB[method](async tx => {
          const id = await tx.table('named_connection_records').insertGetId({ value })
          assert.ok(typeof id === 'number' || typeof id === 'string', `${name}/${method}: insertGetId must return the generated ID`)
          assert.equal(await tx.table('named_connection_records').where('id', id).value('value'), value)
          return id
        }, name)
        committed.push({ id, value, score: 0 })
        await assert.rejects(DB[method](async tx => {
          const id = await tx.table('named_connection_records').insertGetId({ value: 'rollback' })
          assert.equal(await tx.table('named_connection_records').where('id', id).value('value'), 'rollback')
          throw new Error('named rollback')
        }, name), /named rollback/)
      }
      assert.deepEqual(await DB.table('named_connection_records', name).orderBy('id').get(), committed)
      const records = () => DB.table('named_connection_records', name)
      const directId = await records().insertGetId({ value: 'direct' })
      assert.ok(typeof directId === 'number' || typeof directId === 'string', `${name}: direct insertGetId must return the generated ID`)
      assert.equal(await records().where('id', directId).value('value'), 'direct')
      await records().insertOrIgnore({ value: 'direct', score: 99 })
      assert.equal(await records().where('id', directId).value('score'), 0)
      await records().upsert({ value: 'direct', score: 3 }, ['value'], ['score'])
      assert.equal(await records().where('id', directId).value('score'), 3)
      await records().upsert({ value: 'direct', score: 99 }, ['value'])
      assert.equal(await records().where('id', directId).value('score'), 3)
      await records().where('id', directId).increment('score', 2)
      assert.equal(await records().where('id', directId).value('score'), 5)
      await records().where('id', directId).decrement('score', 1)
      assert.equal(await records().where('id', directId).value('score'), 4)
      assert.equal((await records().where('id', directId).update({ score: 7 })).affectedRows, 1)
      assert.equal(await records().where('id', directId).value('score'), 7)
      assert.equal((await records().insert([{ value: 'bulk-a' }, { value: 'bulk-b' }])).affectedRows, 2)
      assert.deepEqual(await records().whereIn('value', ['bulk-a', 'bulk-b']).orderBy('value').pluck('value'), ['bulk-a', 'bulk-b'])
      assert.equal((await records().whereIn('value', ['direct', 'bulk-a', 'bulk-b']).delete()).affectedRows, 3)
      assert.deepEqual(await records().orderBy('id').get(), committed)
    } finally {
      await schema.dropTable('named_connection_records')
    }
  }
  const rawSchema = createSchemaService(DB.connection())
  await rawSchema.createTable('native_raw_records', table => { table.integer('id').primaryKey(); table.string('name') })
  try {
    await DB.table('native_raw_records').insert([{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }])
    const quote = value => DB.connection().getDialect().quoteIdentifier(value)
    assert.deepEqual(await DB.table('native_raw_records')
      .unsafeSelect(`${quote('id')} + ?2 AS second, ${quote('id')} + ?1 AS first, ${quote('id')} + ?1 AS repeated`, [10, 20])
      .where('id', 1).unsafeWhere(`${quote('name')} = $1 OR ${quote('name')} = $1`, ['Alpha'])
      .unsafeOrderBy(`CASE WHEN ${quote('id')} = ? THEN 0 ELSE 1 END`, [1]).get(),
    [{ second: 21, first: 11, repeated: 11 }])
    assert.deepEqual(await DB.table('native_raw_records').unsafeSelect("'literal ? $1' AS text", [])
      .unsafeWhere(`${quote('id')} = ? /* ignored ?1 */ -- ignored $2\n`, [2]).get(), [{ text: 'literal ? $1' }])
  } finally {
    await rawSchema.dropTable('native_raw_records')
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
