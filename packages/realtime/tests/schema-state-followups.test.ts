import { createMySQLAdapter } from '../../db-mysql/src'
import { createPostgresAdapter, postgresDatabaseDriverFactory } from '../../db-postgres/src'
import { expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { createDatabase, createDialect, createSchemaService, type DriverAdapter, onDatabaseDependencyInvalidated, unsafeSql } from '../../db/src'
import { integrationDrivers, mysqlTestConnection, openDatabase, postgresTestConnection } from '../../db/tests/support/database'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  const enabled = driver === 'sqlite' || integrationDrivers([driver]).length > 0
  it.runIf(enabled)(`${driver} refreshes an existing bare-name subscription when a temporary table shadows it`, async () => {
    const { db, table, adapter } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    onTestFinished(() => resetRealtimeRuntime())
    await db.table(table.tableName).insert({ id: 1, name: 'original' })
    const bare = table.tableName.split('.').at(-1)!
    const run = async () => {
      const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async () => (await db.table(bare).get()).map(row => row.name) }), undefined)
      try {
        expect(subscription.current.data).toEqual(['original'])
        await db.unsafeExecute(unsafeSql(`CREATE TEMPORARY TABLE ${bare} (id INTEGER PRIMARY KEY, name VARCHAR(50))`))
        expect(subscription.current.data).toEqual([])
        await db.table(bare).insert({ id: 2, name: 'replacement' })
        expect(subscription.current.data).toEqual(['replacement'])
      } finally { subscription.unsubscribe() }
    }
    if (adapter.runWithTransactionScope) await adapter.runWithTransactionScope(run)
    else await run()
  })
}

for (const driver of ['postgres', 'mysql'] as const) {
  it.runIf(integrationDrivers([driver]).length > 0).each(['automatic', 'custom'] as const)(`${driver} isolates %s cached rows between two active pooled sessions`, async mode => {
    const { db, table, adapter } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    const bare = table.tableName.split('.').at(-1)!
    const read = async () => (await db.table(bare).cache(mode === 'custom' ? { key: bare, ttl: 60 } : 60).get()).map(row => row.name)
    let ready!: () => void
    let release!: () => void
    const firstReady = new Promise<void>(resolve => { ready = resolve })
    const finished = new Promise<void>(resolve => { release = resolve })
    const first = adapter.runWithTransactionScope!(async () => {
      await db.unsafeExecute(unsafeSql(`CREATE TEMPORARY TABLE ${bare} (id INTEGER PRIMARY KEY, name VARCHAR(50))`))
      await db.table(bare).insert({ id: 1, name: 'first' })
      expect(await read()).toEqual(['first'])
      ready()
      await finished
      expect(await read()).toEqual(['first'])
    })
    await firstReady
    try {
      await adapter.runWithTransactionScope!(async () => {
        await db.unsafeExecute(unsafeSql(`CREATE TEMPORARY TABLE ${bare} (id INTEGER PRIMARY KEY, name VARCHAR(50))`))
        await db.table(bare).insert({ id: 2, name: 'second' })
        expect(await read()).toEqual(['second'])
      })
    } finally { release(); await first }
  })
}

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  it.runIf(driver === 'sqlite' || integrationDrivers([driver]).length > 0)(`${driver} keeps ordinary managed caching and unchanged catalog budgets`, async () => {
    const queries: string[] = []
    const { db, table } = await openDatabase(driver, { security: { allowUnsafeRawSql: true }, logger: { onQuerySuccess: entry => { queries.push(entry.source ?? '') } } })
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    const bare = table.tableName.split('.').at(-1)!
    const read = () => db.table(bare).cache({ key: bare, ttl: 60, invalidate: ['explicit'] }).get()
    queries.length = 0
    expect(await read()).toEqual([])
    expect(queries.filter(source => source.startsWith('schema:introspect:'))).toHaveLength(driver === 'mysql' ? 1 : 0)
    await db.unsafeQuery(unsafeSql('SELECT 1'))
    await db.queryCompiled({ sql: 'SELECT 1', source: 'schema:introspect:ordinary' })
    queries.length = 0
    for (let index = 0; index < 3; index += 1) expect(await read()).toEqual([])
    expect(queries).toEqual([])
  })
}

for (const driver of ['postgres', 'mysql'] as const) {
  it.runIf(integrationDrivers([driver]).length > 0)(`${driver} keeps live subscriber holders separate and rejects their expired lifetime`, async () => {
    const { db, table, adapter } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    onTestFinished(() => resetRealtimeRuntime())
    await db.table(table.tableName).insert({ id: 0, name: 'ordinary' })
    const bare = table.tableName.split('.').at(-1)!
    const definition = defineRealtimeQuery({ access: 'public', handler: async () => (await db.table(bare).get()).map(row => row.name) })
    const ordinary = await subscribeRealtimeQuery(definition, undefined)
    let ready!: () => void
    let release!: () => void
    const firstReady = new Promise<void>(resolve => { ready = resolve })
    const finished = new Promise<void>(resolve => { release = resolve })
    const errors: unknown[] = []
    let current = () => [] as unknown[]
    let unsubscribe = () => {}
    const first = adapter.runWithTransactionScope!(async () => {
      await db.unsafeExecute(unsafeSql(`CREATE TEMPORARY TABLE ${bare} (id INTEGER PRIMARY KEY, name VARCHAR(50))`))
      await db.table(bare).insert({ id: 1, name: 'first' })
      const subscription = await subscribeRealtimeQuery(definition, undefined, { onError: error => { errors.push(error) } })
      current = () => subscription.current.data
      unsubscribe = () => subscription.unsubscribe()
      ready()
      await finished
    })
    await firstReady
    try {
      await adapter.runWithTransactionScope!(async () => {
        await db.unsafeExecute(unsafeSql(`CREATE TEMPORARY TABLE ${bare} (id INTEGER PRIMARY KEY, name VARCHAR(50))`))
        await db.table(bare).insert({ id: 2, name: 'second' })
        expect(current()).toEqual(['first'])
        expect(ordinary.current.data).toEqual(['ordinary'])
      })
      ordinary.unsubscribe()
      release()
      await first
      await db.table(table.tableName).insert({ id: 3, name: 'after' })
      expect(errors).toEqual([expect.objectContaining({ code: 'SESSION_ENDED' })])
      expect(current()).toEqual(['first'])
    } finally { ordinary.unsubscribe(); release(); await first; unsubscribe() }
  })
}

it('sqlite follows an attached bare table when a new main table shadows it', async () => {
  const { db, table, schema } = await openDatabase('sqlite', { security: { allowUnsafeRawSql: true } })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  onTestFinished(() => resetRealtimeRuntime())
  const bare = table.tableName
  await schema.dropTable(bare)
  await db.unsafeExecute(unsafeSql("ATTACH DATABASE ':memory:' AS aux"))
  await schema.createTable(`aux.${bare}`, columns => { columns.integer('id').primaryKey(); columns.string('name') })
  await db.table(`aux.${bare}`).insert({ id: 1, name: 'attached' })
  const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async () => (await db.table(bare).get()).map(row => row.name) }), undefined)
  try {
    expect(subscription.current.data).toEqual(['attached'])
    await schema.createTable(bare, columns => { columns.integer('id').primaryKey(); columns.string('name') })
    expect(subscription.current.data).toEqual([])
    await db.table(bare).insert({ id: 2, name: 'main' })
    expect(subscription.current.data).toEqual(['main'])
  } finally { subscription.unsubscribe() }
})

for (const driver of ['postgres', 'mysql'] as const) {
  it.runIf(integrationDrivers([driver]).length > 0)(`${driver} follows a changed search path or selected database without a later read`, async () => {
    const { db, table, adapter, schema } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    onTestFinished(() => resetRealtimeRuntime())
    const bare = table.tableName.split('.').at(-1)!
    const tenant = driver === 'postgres' ? `tenant_${bare}` : `${table.tableName.split('.')[0]}_scope`
    const quoted = driver === 'postgres' ? `"${tenant}"` : `\`${tenant}\``
    await db.executeSchemaStatement({ sql: `CREATE ${driver === 'postgres' ? 'SCHEMA' : 'DATABASE'} ${quoted}`, source: 'schema' })
    try {
      await schema.createTable(`${tenant}.${bare}`, columns => { columns.integer('id').primaryKey(); columns.string('name') })
      await db.table(table.tableName).insert({ id: 1, name: 'original' })
      await db.table(`${tenant}.${bare}`).insert({ id: 2, name: 'selected' })
      await adapter.runWithTransactionScope!(async () => {
        const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async () => (await db.table(bare).get()).map(row => row.name) }), undefined)
        try {
          expect(subscription.current.data).toEqual(['original'])
          await db.unsafeExecute(unsafeSql(driver === 'postgres' ? `SET search_path TO ${quoted}` : `USE ${quoted}`))
          expect(subscription.current.data).toEqual(['selected'])
        } finally { subscription.unsubscribe() }
      })
    } finally { await adapter.execute(`DROP ${driver === 'postgres' ? 'SCHEMA' : 'DATABASE'} ${quoted}${driver === 'postgres' ? ' CASCADE' : ''}`) }
  })
}

it('refreshes an initial snapshot read before its bare table was rebound', async () => {
  const { db, table } = await openDatabase('sqlite', { security: { allowUnsafeRawSql: true } })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  onTestFinished(() => resetRealtimeRuntime())
  await db.table(table.tableName).insert({ id: 1, name: 'original' })
  let started!: () => void
  let release!: () => void
  const readStarted = new Promise<void>(resolve => { started = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  let initial = true
  let refreshed!: () => void
  const replacement = new Promise<void>(resolve => { refreshed = resolve })
  const pending = subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async () => {
    const names = (await db.table(table.tableName).get()).map(row => row.name)
    if (initial) {
      initial = false
      started()
      await resume
    }
    return names
  } }), undefined, { onData: snapshot => { if (snapshot.data.length === 0) refreshed() } })
  await readStarted
  try {
    await db.unsafeExecute(unsafeSql(`CREATE TEMPORARY TABLE ${table.tableName} (id INTEGER PRIMARY KEY, name VARCHAR(50))`))
  } finally { release() }
  const subscription = await pending
  try {
    await replacement
    expect(subscription.current.data).toEqual([])
  } finally { subscription.unsubscribe() }
})

it.runIf(integrationDrivers(['postgres']).length > 0)('keeps factory-created PostgreSQL caching and table-scoped notifications', async () => {
  const { table } = await openDatabase('postgres')
  const connection = postgresTestConnection()
  const adapter = postgresDatabaseDriverFactory.create({ ...connection, username: connection.user })
  const queries: string[] = []
  const db = createDatabase({ adapter, dialect: createDialect('postgres'), logger: { onQuerySuccess: entry => { queries.push(entry.source ?? '') } } })
  onTestFinished(() => db.disconnect())
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  onTestFinished(() => resetCacheRuntime())
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  onTestFinished(() => resetRealtimeRuntime())
  for (let index = 0; index < 3; index += 1) expect(await db.table(table).cache(60).get()).toEqual([])
  expect(queries.filter(source => source.startsWith('query:select:'))).toHaveLength(1)
  const events: unknown[] = []
  const stop = onDatabaseDependencyInvalidated(event => { events.push(event) })
  onTestFinished(stop)
  const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async () => {
    return db.table(table).orderBy('id').get()
  } }), undefined)
  try {
    await db.table(table).insert({ id: 1, name: 'factory' })
    expect(subscription.current.data.map(row => row.name)).toEqual(['factory'])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({ dependencies: expect.not.arrayContaining(['__holo_database_schema__']) }))
  } finally { subscription.unsubscribe() }
})

for (const driver of ['postgres', 'mysql'] as const) {
  it.runIf(integrationDrivers([driver]).length > 0)(`${driver} releases a sole scoped client before refreshing an ordinary subscriber after DDL`, async () => {
    const { table } = await openDatabase(driver)
    const adapter = driver === 'postgres'
      ? createPostgresAdapter({ config: { ...postgresTestConnection(), max: 1 } })
      : createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } })
    const db = createDatabase({ adapter, dialect: createDialect(driver) })
    onTestFinished(() => db.disconnect())
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    onTestFinished(() => resetRealtimeRuntime())
    await db.table(table).insert({ id: 1, name: 'ordinary' })
    let runs = 0
    const errors: unknown[] = []
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async () => {
      runs += 1
      return db.table(table).select('id', 'name').orderBy('id').get()
    } }), undefined, { onError: error => { errors.push(error) } })
    let release!: () => void
    const cleanup = new Promise<void>(resolve => { release = resolve })
    let returned = false
    let runsWhenReturned = 0
    let ddl: Promise<unknown> | undefined
    const qualified = table.tableName.split('.').map(part => driver === 'postgres' ? `"${part}"` : `\`${part}\``).join('.')
    const scopeError = new Error('scope exit')
    const scope = adapter.runWithTransactionScope(async () => {
      ddl = db.executeSchemaStatement({ sql: `ALTER TABLE ${qualified} ADD COLUMN refresh_marker INTEGER`, source: 'schema' }).then(() => {
        runsWhenReturned = runs
        returned = true
      })
      await Promise.race([ddl, cleanup])
      throw scopeError
    }).catch(error => { expect(error).toBe(scopeError) })
    try {
      await expect.poll(() => returned).toBe(true)
      await scope
      expect(runsWhenReturned).toBe(1)
      expect(runs).toBe(2)
      expect(errors).toEqual([])
      expect(subscription.current.data.map(row => row.name)).toEqual(['ordinary'])
    } finally {
      release()
      await scope
      await ddl
      subscription.unsubscribe()
    }
  })

  it.runIf(integrationDrivers([driver]).length > 0)(`${driver} delivers SESSION_ENDED once on a normal mutation after an untainted subscriber scope ends`, async () => {
    const { db, table, adapter } = await openDatabase(driver)
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    onTestFinished(() => resetRealtimeRuntime())
    await db.table(table).insert({ id: 1, name: 'first' })
    const qualifiedErrors: unknown[] = []
    const bareErrors: unknown[] = []
    const subscribe = (name: string, errors: unknown[]) => subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => db.table(name).orderBy('id').get() }), undefined, { onError: error => { errors.push(error) } })
    const subscriptions = await adapter.runWithTransactionScope!(async () => [
      await subscribe(table.tableName, qualifiedErrors),
      await subscribe(table.tableName.split('.').at(-1)!, bareErrors),
    ])
    try {
      await db.table(table).insert({ id: 2, name: 'second' })
      expect([qualifiedErrors, bareErrors]).toEqual([
        [expect.objectContaining({ code: 'SESSION_ENDED' })],
        [expect.objectContaining({ code: 'SESSION_ENDED' })],
      ])
      expect(subscriptions.map(subscription => subscription.current.data.map(row => row.name))).toEqual([['first'], ['first']])
    } finally { subscriptions.forEach(subscription => subscription.unsubscribe()) }
  })
}

it.runIf(integrationDrivers(['postgres']).length > 0)('isolates cached rows selected by a raw tenant setting under native RLS', async () => {
  const { db: admin, table } = await openDatabase('postgres')
  const role = `review7_${table.tableName.split('.').at(-1)!}`
  await admin.executeCompiled({ sql: `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS` })
  const connection = postgresTestConnection()
  const adapter = postgresDatabaseDriverFactory.create({ ...connection, username: role, max: 1 })
  const db = createDatabase({ adapter, dialect: createDialect('postgres'), security: { allowUnsafeRawSql: true } })
  onTestFinished(async () => {
    await db.disconnect()
    await admin.executeCompiled({ sql: `DROP OWNED BY ${role}` })
    await admin.executeCompiled({ sql: `DROP ROLE ${role}` })
  })
  await admin.table(table).insert([{ id: 1, name: 'tenant-a' }, { id: 2, name: 'tenant-b' }])
  await admin.executeCompiled({ sql: `ALTER TABLE ${table.tableName} ENABLE ROW LEVEL SECURITY` })
  await admin.executeCompiled({ sql: `CREATE POLICY tenant_context ON ${table.tableName} USING (name = current_setting('app.tenant_id', true))` })
  await admin.executeCompiled({ sql: `GRANT SELECT ON ${table.tableName} TO ${role}` })
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  onTestFinished(() => resetCacheRuntime())
  const read = () => db.table(table.tableName).cache(60).pluck('name')
  await db.unsafeExecute(unsafeSql("SET app.tenant_id = 'tenant-a'"))
  expect(await read()).toEqual(['tenant-a'])
  await db.unsafeExecute(unsafeSql("SET app.tenant_id = 'tenant-b'"))
  expect(await read()).toEqual(['tenant-b'])
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function delayExecution(adapter: DriverAdapter, marker: string, started: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): DriverAdapter {
  return new Proxy(adapter, {
    get(target, key) {
      if (key === 'execute') return async (...args: Parameters<DriverAdapter['execute']>) => {
        const result = await target.execute(...args)
        if (args[0].includes(marker)) { started.resolve(); await release.promise }
        return result
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

it('delivers writes on an independent database while another schema statement is pending', async () => {
  const started = deferred()
  const release = deferred()
  const { db: first, table: firstTable } = await openDatabase('sqlite', { connectionName: 'review7-a', wrapAdapter: adapter => delayExecution(adapter, 'pending_marker', started, release) })
  const { db, table } = await openDatabase('sqlite', { connectionName: 'review7-b' })
  configureRealtimeRuntime({ db: () => first, loadAuthModule: async () => null })
  onTestFinished(() => resetRealtimeRuntime())
  const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => db.table(table).pluck('name') }), undefined)
  const pending = first.executeSchemaStatement({ sql: `ALTER TABLE ${firstTable.tableName} ADD COLUMN pending_marker INTEGER` })
  await started.promise
  try {
    await db.table(table).insert({ id: 1, name: 'independent' })
    expect(subscription.current.data).toEqual(['independent'])
  } finally { release.resolve(); await pending; subscription.unsubscribe() }
})

it.runIf(integrationDrivers(['mysql']).length > 0)('refreshes after transactional DDL settles later than transaction cleanup', async () => {
  const started = deferred()
  const release = deferred()
  const { db, table } = await openDatabase('mysql', { wrapAdapter: adapter => delayExecution(adapter, 'TRUNCATE', started, release) })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  onTestFinished(() => resetRealtimeRuntime())
  await db.table(table).insert({ id: 1, name: 'before' })
  const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => db.table(table).pluck('name') }), undefined)
  try {
    const transaction = db.transaction(async tx => {
      await tx.executeSchemaStatement({ sql: `TRUNCATE TABLE ${table.tableName}` }, { timeoutMs: 20 })
    })
    await started.promise
    await expect(transaction).rejects.toThrow(/timed out/)
    release.resolve()
    await expect.poll(() => subscription.current.data).toEqual([])
    expect(await db.table(table).pluck('name')).toEqual([])
  } finally { release.resolve(); subscription.unsubscribe() }
})

it.runIf(integrationDrivers(['postgres']).length > 0)('reconciles a cache-ineligible mutation that overlaps the initial subscription read', async () => {
  const { db, table, adapter } = await openDatabase('postgres')
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  onTestFinished(() => resetRealtimeRuntime())
  await adapter.runWithTransactionScope!(async () => {
    const started = deferred()
    const release = deferred()
    let initial = true
    const pending = subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async () => {
      const names = await db.table(table).pluck('name')
      if (initial) { initial = false; started.resolve(); await release.promise }
      return names
    } }), undefined)
    await started.promise
    try { await db.table(table).insert({ id: 1, name: 'overlap' }) }
    finally { release.resolve() }
    const subscription = await pending
    try { await expect.poll(() => subscription.current.data).toEqual(['overlap']) }
    finally { subscription.unsubscribe() }
  })
})

it('reports a rolled-back subscription table and retains its last successful snapshot', async () => {
  const { db, table, schema } = await openDatabase('sqlite')
  await schema.dropTable(table.tableName)
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  onTestFinished(() => resetRealtimeRuntime())
  const errors: unknown[] = []
  let current: () => unknown[] = () => []
  let unsubscribe = () => {}
  const rollback = new Error('rollback subscription table')
  try {
    await expect(db.transaction(async tx => {
      await createSchemaService(tx).createTable(table.tableName, columns => { columns.integer('id').primaryKey(); columns.string('name') })
      await tx.table(table.tableName).insert({ id: 1, name: 'last successful' })
      const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => db.table(table.tableName).pluck('name') }), undefined, { onError: error => { errors.push(error) } })
      current = () => subscription.current.data
      unsubscribe = () => subscription.unsubscribe()
      expect(current()).toEqual(['last successful'])
      throw rollback
    })).rejects.toBe(rollback)
    expect(errors).toEqual([expect.objectContaining({ code: 'DRIVER_QUERY_ERROR' })])
    expect(current()).toEqual(['last successful'])
    await expect(db.table(table.tableName).get()).rejects.toThrow()
  } finally { unsubscribe() }
})
