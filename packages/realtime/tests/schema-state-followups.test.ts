import { expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { unsafeSql } from '../../db/src'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
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
