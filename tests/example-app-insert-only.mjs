import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function assertExampleAppInsertOnlyBehavior(DB, schema, projectRoot, { column, defineGeneratedTable }) {
  const role = process.env.HOLO_POSTGRES_INSERT_ONLY_ROLE
  assert.ok(role, 'The native app matrix must provision an INSERT-only PostgreSQL role')
  const require = createRequire(join(projectRoot, 'package.json'))
  const { defineRealtimeQuery } = await import(pathToFileURL(require.resolve('@holo-js/realtime')).href)
  const { subscribeRealtimeQuery } = await import(pathToFileURL(require.resolve('@holo-js/realtime/server')).href)
  const connection = DB.connection('postgres')
  const quote = value => connection.getDialect().quoteIdentifier(value)
  const name = 'native_private_preferences'
  const table = defineGeneratedTable(name, { tenant_id: column.string().primaryKey(), secret: column.string() })
  let subscription
  await schema.createTable(name, table => { table.string('tenant_id').primaryKey(); table.string('secret') })
  try {
    await connection.executeCompiled({
      sql: `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;
        CREATE POLICY provision ON ${name} FOR INSERT TO ${quote(role)} WITH CHECK (true);
        CREATE POLICY read_preferences ON ${name} FOR SELECT TO CURRENT_USER USING (true);
        GRANT INSERT ON ${name} TO ${quote(role)}`,
      source: 'schema',
    })
    const snapshots = []
    subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => DB.table(table, 'postgres').get() }), {}, {
      onData: snapshot => snapshots.push(snapshot.data), onError: error => { throw error },
    })
    const result = await DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${quote(role)}`, source: 'schema' })
      return tx.table(table).insert({ tenant_id: 'tenant-a', secret: 'private' })
    }, 'postgres')
    assert.equal(result.affectedRows, 1)
    const ignored = await DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${quote(role)}`, source: 'schema' })
      return tx.table(table).insertOrIgnore({ tenant_id: 'tenant-a', secret: 'unchanged' })
    }, 'postgres')
    assert.equal(ignored.affectedRows, 0)
    await assert.rejects(DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${quote(role)}`, source: 'schema' })
      return tx.table(table).get()
    }, 'postgres'), /permission denied/)
    assert.deepEqual(await DB.table(table, 'postgres').get(), [{ tenant_id: 'tenant-a', secret: 'private' }])
    assert.deepEqual(snapshots.at(-1), [{ tenant_id: 'tenant-a', secret: 'private' }])
    await connection.executeCompiled({
      sql: `GRANT SELECT (tenant_id) ON ${name} TO ${quote(role)};
        CREATE POLICY read_id ON ${name} FOR SELECT TO ${quote(role)} USING (true)`, source: 'schema',
    })
    const id = await DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${quote(role)}`, source: 'schema' })
      return tx.table(table).insertGetId({ tenant_id: 'tenant-b', secret: 'still private' })
    }, 'postgres')
    assert.equal(id, 'tenant-b')
    await assert.rejects(DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${quote(role)}`, source: 'schema' })
      return tx.table(table).get()
    }, 'postgres'), /permission denied/)
    await connection.executeCompiled({ sql: `GRANT SELECT ON ${name} TO ${quote(role)}; ALTER POLICY read_id ON ${name} USING (false)`, source: 'schema' })
    const hidden = await DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${quote(role)}`, source: 'schema' })
      return tx.table(table).insert({ tenant_id: 'tenant-c', secret: 'hidden by RLS' })
    }, 'postgres')
    assert.equal(hidden.affectedRows, 1)
    assert.deepEqual(await DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${quote(role)}`, source: 'schema' })
      return tx.table(table).get()
    }, 'postgres'), [])
  } finally {
    subscription?.unsubscribe()
    await schema.dropTable(name)
  }
}
