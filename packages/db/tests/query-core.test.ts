import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  CompilerError,
  DB,
  MySQLQueryCompiler,
  PostgresQueryCompiler,
  SecurityError,
  SQLiteQueryCompiler,
  column,
  configureDB,
  createConnectionManager,
  createSchemaService,
  createDialect as createDatabaseDialect,
  createCursorPaginator,
  createDeleteQueryPlan,
  createInsertQueryPlan,
  createPaginator,
  createSelectQueryPlan,
  createSimplePaginator,
  createTableSource,
  createUpdateQueryPlan,
  resetDB,
  validateQueryPlan,
 } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'
import { createUpsertQueryPlan, type QueryJsonUpdateOperation } from '../src/query/ast'

function createTestAdapter(): ReturnType<typeof createSQLiteAdapter> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  return adapter
}

async function createRealQueryDatabase(): Promise<ReturnType<typeof createSQLiteAdapter>> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  onTestFinished(() => adapter.disconnect())
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDatabaseDialect('sqlite') } },
  }))
  return adapter
}

describe('query core slice', () => {
  beforeEach(() => {
    resetDB()
  })

  it('retrieves filtered pages without changing the original query', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed', 1), (2, 'Mohamed', 0), (3, 'Mohamed', 1), (4, 'Amina', 1)")
    const users = defineTable('users', { id: column.id(), name: column.string(), active: column.boolean() })
    const query = DB.table(users).select('id', 'name').where('name', 'Mohamed').orderBy('id', 'desc')

    expect(await query.limit(5).offset(2).get()).toEqual([{ id: 1, name: 'Mohamed' }])
    expect(await query.pluck('id')).toEqual([3, 2, 1])
    expect(await query.where('active', true).pluck('id')).toEqual([3, 1])
  })

  it('rejects queries exceeding the configured complexity while allowing simple reads', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed', 1)")
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDatabaseDialect('sqlite'), security: { maxQueryComplexity: 3 } } },
    }))
    const users = defineTable('users', { id: column.id(), name: column.string(), active: column.boolean() })
    expect(await DB.table(users).where('id', 1).first()).toMatchObject({ name: 'Mohamed' })
    await expect(DB.table(users).select('id', 'name').where('name', 'Mohamed').orderBy('id', 'desc').limit(5).get()).rejects.toThrow(SecurityError)
  })

  it('retrieves single rows and rejects missing or ambiguous results', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, meta TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed', ?)", [JSON.stringify({ enabled: 'yes' })])
    const users = defineTable('users', { id: column.id(), name: column.string(), meta: column.json<Record<string, unknown>>().nullable() })
    const builder = DB.table(users).select('id', 'name').where('name', 'like', 'Mo%')
    expect(builder.toSQL().bindings).toEqual(['Mo%'])
    expect(await builder.first()).toEqual({ id: 1, name: 'Mohamed' })
    expect(await builder.sole()).toEqual({ id: 1, name: 'Mohamed' })
    expect(await DB.table(users).find(1)).toMatchObject({ id: 1, name: 'Mohamed' })
    expect(await DB.table(users).valueOrFail('name')).toBe('Mohamed')
    expect(await DB.table(users).soleValue('name')).toBe('Mohamed')
    expect(await DB.table(users).whereJson('meta->enabled', 'like', 'yes').pluck('name')).toEqual(['Mohamed'])
    expect(await DB.table(users).whereNull('meta').count()).toBe(0)
    expect(await DB.table(users).whereNotNull('meta').count()).toBe(1)
    expect(() => DB.table(users).whereJson('meta->>name', '=', 'Mohamed')).toThrow('Use portable JSON path syntax')
    await DB.table(users).delete()
    expect(await DB.table(users).find(1)).toBeUndefined()
    await expect(DB.table(users).sole()).rejects.toThrow('Query expected exactly one row but found 0.')
    await expect(DB.table(users).valueOrFail('name')).rejects.toThrow('Query returned no value for column "name".')
    await DB.table(users).insert([{ name: 'Mohamed' }, { name: 'Amina' }])
    await expect(DB.table(users).sole()).rejects.toThrow('Query expected exactly one row but found 2.')
  })

  it('reads qualified scalar columns without joined-column collisions and preserves selected aliases', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE records (id INTEGER PRIMARY KEY, category TEXT)')
    await adapter.execute('CREATE TABLE labels (id INTEGER PRIMARY KEY, record_id INTEGER)')
    await adapter.execute("INSERT INTO records VALUES (1, 'a'), (2, 'a'), (3, 'b')")
    await adapter.execute('INSERT INTO labels VALUES (20, 1)')
    const query = DB.table('records').leftJoin('labels', 'records.id', '=', 'labels.record_id')
    expect(await query.orderBy('records.id').pluck('records.id')).toEqual([1, 2, 3])
    expect(await query.where('records.id', 1).value('records.id')).toBe(1)
    expect(await query.where('records.id', 2).valueOrFail('records.id')).toBe(2)
    expect(await query.where('records.id', 3).soleValue('records.id')).toBe(3)
    expect(await DB.table('records').select('category as label').where('id', 1).value('label')).toBe('a')
    expect(await DB.table('records').distinct().orderBy('category').pluck('category')).toEqual(['a', 'b'])
  })

  it('executes grouped OR clauses and treats empty grouped callbacks as no-ops', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A'), (2, 'B'), (3, 'C')")
    expect(await DB.table('users').where(() => undefined).orWhere(() => undefined).orderBy('id').pluck('id')).toEqual([1, 2, 3])
    expect(await DB.table('users').where('id', 1).orWhere('name', 'B').orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await DB.table('users').where(query => query.where('name', 'A').orWhere('name', 'B')).where('id', '>', 1).pluck('id')).toEqual([2])
    expect(await DB.table('users').where(query => query.where('name', 'A')).pluck('id')).toEqual([1])
  })

  it('redacts debug bindings while executing the original bound values', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed')")
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: {
      default: { adapter, dialect: createDatabaseDialect('sqlite'), security: { redactBindingsInLogs: true } },
    } }))
    const query = DB.table('users').where('name', 'Mohamed')
    expect(query.debug()).toMatchObject({ sql: 'SELECT * FROM "users" WHERE "name" = ?', bindings: ['[REDACTED]'], connectionName: 'default' })
    expect(query.toSQL().bindings).toEqual(['Mohamed'])
    expect(await query.get()).toEqual([{ id: 1, name: 'Mohamed' }])
  })

  it('applies conditional filters, ordering helpers, and grouped HAVING to persisted rows', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed', '2025-01-01'), (2, 'Amina', '2025-01-02'), (3, 'Mohamed', NULL), (4, 'fallback', '2025-01-03')")
    const users = () => DB.table('users')
    expect(await users().when(true, q => q.where('name', 'Mohamed')).unless(true, q => q.where('id', 99), q => q.where('id', 1)).latest().reorder('name').pluck('id')).toEqual([1])
    expect(await users().whereNotNull('created_at').oldest().pluck('id')).toEqual([1, 2, 4])
    expect(await users().whereNotNull('created_at').latest().pluck('id')).toEqual([4, 2, 1])
    expect((await users().inRandomOrder().pluck('id')).sort()).toEqual([1, 2, 3, 4])
    expect(await users().unless(false, q => q.where('id', 1)).pluck('id')).toEqual([1])
    expect(await users().when(false, q => q.where('id', 1), q => q.where('name', 'fallback')).pluck('id')).toEqual([4])
    expect(await users().when(true, () => {}).when(false, q => q.where('id', 1)).unless(true, q => q.where('id', 1)).orderBy('id', 'desc').reorder('id').pluck('id')).toEqual([1, 2, 3, 4])
    expect(await users().where(query => query.where('name', 'Mohamed').orWhere('id', 2)).whereNotNull('created_at').orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await users().whereNot(q => q.where('name', 'Mohamed').orWhere('id', 2)).orWhereNot(q => q.whereNull('created_at')).orderBy('id').pluck('id')).toEqual([1, 2, 4])
    expect(await users().whereLike('name', 'Mo%').orWhereLike('name', 'Am%').orderBy('id').pluck('id')).toEqual([1, 2, 3])
    expect(await users().whereAny(['name', 'created_at'], 'like', 'Mo%').orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await users().whereAll(['name', 'created_at'], 'like', 'Mo%').pluck('id')).toEqual([])
    expect(await users().whereNone(['name', 'created_at'], 'like', 'Mo%').orderBy('id').pluck('id')).toEqual([2, 4])
    expect(await users().select('name').groupBy('name').having('count(*)', '>=', 2).havingBetween('count(*)', [2, 5]).get()).toEqual([{ name: 'Mohamed' }])
    expect(await users().select('name').groupBy('name').having('count(*)', 2).get()).toEqual([{ name: 'Mohamed' }])
    expect(await users().whereDate('created_at', '2025-01-01').select('id').addSelect('name').get()).toEqual([{ id: 1, name: 'Mohamed' }])
  })

  it('traverses string-source tables exactly once across multiple chunks', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A'), (2, 'B'), (3, 'C'), (4, 'D'), (5, 'E')")
    const seen: number[] = []
    await DB.table('users').chunkById(2, rows => { seen.push(...rows.map(row => Number(row.id))) })
    expect(seen).toEqual([1, 2, 3, 4, 5])
    const descending: number[] = []
    await DB.table('users').chunkByIdDesc(2, rows => { descending.push(...rows.map(row => Number(row.id))) })
    expect(descending).toEqual([5, 4, 3, 2, 1])
  })

  it('filters persisted rows using distinct, column comparisons, ranges, and sets', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score INTEGER, minScore INTEGER, maxScore INTEGER, active INTEGER)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A', 10, 0, 10, 1), (2, 'A', 20, 2, 20, 1), (3, 'B', 8, 5, 3, 0), (4, 'C', 30, 0, 30, 1)")
    const users = defineTable('users', { id: column.id(), name: column.string(), score: column.integer(), minScore: column.integer(), maxScore: column.integer(), active: column.boolean() })
    expect(await DB.table(users).distinct().select('name').whereColumn('minScore', '<=', 'maxScore').whereIn('id', [1, 2]).whereNotIn('score', [7, 8]).whereBetween('score', [10, 20]).whereNotBetween('id', [30, 40]).orderBy('name').get()).toEqual([{ name: 'A' }])
    expect(await DB.table(users).whereIn('id', [1, 2, 3]).whereNotBetween('score', [5, 9]).orderBy('id').pluck('id')).toEqual([1, 2])
  })

  it('ignores conflicting inserts without changing existing rows', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)')
    const users = defineTable('users', { id: column.id(), name: column.string() })
    await DB.table(users).insert({ id: 1, name: 'Mohamed' })
    expect((await DB.table(users).insertOrIgnore({ id: 1, name: 'Changed' })).affectedRows).toBe(0)
    await DB.table(users).insertOrIgnore([{ id: 2, name: 'Amina' }, { id: 3, name: 'Salma' }])
    expect(await DB.table(users).orderBy('id').get()).toEqual([
      { id: 1, name: 'Mohamed' }, { id: 2, name: 'Amina' }, { id: 3, name: 'Salma' },
    ])
  })

  it('upserts persisted rows and rejects invalid conflict keys and payloads', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL)')
    const users = defineTable('users', { id: column.id(), email: column.string(), name: column.string() })
    await DB.table(users).insert({ id: 1, email: 'm@example.com', name: 'Mohamed' })
    await DB.table(users).upsert({ id: 2, email: 'm@example.com', name: 'Updated' }, ['email'], ['name'])
    expect(await DB.table(users).get()).toEqual([{ id: 1, email: 'm@example.com', name: 'Updated' }])
    await DB.table(users).upsert({ id: 2, email: 'm@example.com', name: 'Ignored' }, ['email'])
    expect(await DB.table(users).value('name')).toBe('Updated')
    await expect(DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, [], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, ['missing'], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert([{ id: 1, email: 'm@example.com', name: 'Mohamed' }, { id: 2, email: 'a@example.com' } as never], ['email'], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert([{ id: 1, email: 'm@example.com', name: 'Mohamed' }, { id: 2, email: 'a@example.com', name: undefined as never }], ['email'], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, ['email'], ['missing'])).rejects.toThrow(SecurityError)
    expect(await DB.table(users).get()).toEqual([{ id: 1, email: 'm@example.com', name: 'Updated' }])
  })

  it('rejects malformed plans directly in the validator', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      meta: column.json<Record<string, unknown>>().nullable(),
      embedding: column.vector({ dimensions: 3 }).nullable() })

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      joins: [{
        type: 'inner',
        table: 'teams',
        subquery: createSelectQueryPlan(createTableSource(users)),
        leftColumn: 'users.id',
        operator: '=',
        rightColumn: 'teams.userId' }] })).toThrow('Join clauses must target exactly one source')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'group',
        boolean: 'and',
        predicates: [] }] } as never)).toThrow('Grouped predicates must include at least one nested predicate.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['valid', ''],
        jsonMode: 'value',
        operator: '=',
        value: 1 }] } as never)).toThrow('contains an invalid segment')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['region'],
        jsonMode: 'value',
        operator: '>',
        value: null }] } as never)).toThrow('JSON null comparisons only support')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'vector',
        boolean: 'and',
        column: 'name',
        vector: [1, 2, 3],
        minSimilarity: 0.5 }] } as never)).toThrow('requires "name" to be a vector column')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'vector',
        boolean: 'and',
        column: 'embedding',
        vector: [1, Number.NaN],
        minSimilarity: 0.5 }] } as never)).toThrow('require a non-empty numeric vector')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'vector',
        boolean: 'and',
        column: 'embedding',
        vector: [1, 2],
        minSimilarity: 0.5 }] } as never)).toThrow('must provide 3 dimensions')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'vector',
        boolean: 'and',
        column: 'users.embedding',
        vector: [1, 2, 3],
        minSimilarity: 0.5 }] } as never)).not.toThrow()

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'date',
        boolean: 'and',
        column: 'name',
        part: 'date',
        operator: '=',
        value: undefined }] } as never)).toThrow('Date predicate value for column "name" cannot be undefined.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'date',
        boolean: 'and',
        column: 'name',
        part: 'century',
        operator: '=',
        value: '2025-01-01' }] } as never)).toThrow('Date predicate part "century" is not supported.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'date',
        boolean: 'and',
        column: 'name',
        part: 'date',
        operator: 'contains',
        value: '2025-01-01' }] } as never)).toThrow('Operator "contains" is not allowed in safe query mode.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'fulltext',
        boolean: 'and',
        columns: [],
        value: 'term',
        mode: 'natural' }] } as never)).toThrow('Full-text predicates must target at least one column.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'fulltext',
        boolean: 'and',
        columns: ['name'],
        value: '   ',
        mode: 'natural' }] } as never)).toThrow('require a non-empty search string')

    expect(() => validateQueryPlan({
      kind: 'update',
      source: createTableSource(users),
      predicates: [],
      values: {
        meta: [] } } as never)).toThrow('must include at least one operation')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      joins: [{
        type: 'cross',
        table: 'teams',
        leftColumn: 'users.id',
        operator: '=',
        rightColumn: 'teams.userId' }] } as never)).toThrow('Cross joins cannot include join constraints.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      joins: [{
        type: 'inner',
        lateral: true,
        table: 'teams' }] } as never)).toThrow('Lateral joins require a subquery source.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'length',
        operator: '=',
        value: Number.NaN }] } as never)).toThrow('requires a numeric value')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'fulltext',
        boolean: 'and',
        columns: ['name'],
        value: 'term',
        mode: 'invalid' }] } as never)).toThrow('not supported')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      limit: -1 } as never)).toThrow('Limit must be a non-negative integer.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      selections: [{ kind: 'column', column: 'name', alias: 'bad alias' }] } as never)).toThrow('Selection alias')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      joins: [{
        type: 'inner',
        subquery: createSelectQueryPlan(createTableSource(users)) }] } as never)).toThrow('Subquery joins must define an alias.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      joins: [{
        type: 'inner',
        lateral: true,
        subquery: createSelectQueryPlan(createTableSource(users)),
        alias: 'sub',
        leftColumn: 'users.id' }] } as never)).toThrow('Lateral joins cannot include explicit ON column constraints.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      joins: [{
        type: 'inner',
        table: 'teams',
        leftColumn: 'users.id' }] } as never)).toThrow('INNER joins must include left column, operator, and right column.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'value',
        value: 1 }] } as never)).toThrow('requires an operator')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'length',
        value: 1 }] } as never)).toThrow('requires an operator')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'value',
        operator: 'in',
        value: 1 }] } as never)).toThrow('not allowed for JSON value predicates')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'value',
        operator: '=',
        value: { nested: true } }] } as never)).toThrow('requires a finite scalar value')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'value',
        operator: '=',
        value: Number.NaN }] } as never)).toThrow('requires a finite scalar value')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'contains',
        value: undefined }] } as never)).toThrow('cannot be undefined')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'subquery',
        boolean: 'and',
        column: 'id',
        operator: 'contains',
        subquery: createSelectQueryPlan(createTableSource(users)) }] } as never)).toThrow('Operator "contains" is not allowed in subquery predicates.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      having: [{ expression: 'count(*)', operator: '>', value: undefined }] } as never)).toThrow('Having value for "count(*)" cannot be undefined.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{
        kind: 'json',
        boolean: 'and',
        column: 'meta',
        path: ['items'],
        jsonMode: 'value',
        operator: '=' }] } as never)).toThrow('cannot be undefined')

    expect(() => validateQueryPlan({
      kind: 'insert',
      source: createTableSource(users),
      ignoreConflicts: false,
      values: [] } as never)).toThrow('Insert queries must include at least one row.')

    expect(() => validateQueryPlan({
      kind: 'insert',
      source: createTableSource(users),
      ignoreConflicts: false,
      values: [{}] } as never)).toThrow('Insert queries must include at least one column.')

    expect(() => validateQueryPlan({
      kind: 'insert',
      source: createTableSource(users),
      ignoreConflicts: false,
      values: [{ name: undefined }] } as never)).toThrow('Insert value for column "name" cannot be undefined.')

    expect(() => validateQueryPlan({
      kind: 'update',
      source: createTableSource(users),
      predicates: [],
      values: {
        meta: { kind: 'json-set', path: [], value: 1 } } } as never)).toThrow('must include a valid nested path')

    expect(() => validateQueryPlan({
      kind: 'update',
      source: createTableSource(users),
      predicates: [],
      values: {
        meta: { kind: 'json-set', path: ['a'], value: undefined } } } as never)).toThrow('cannot use undefined values')

    expect(() => validateQueryPlan({
      kind: 'update',
      source: createTableSource(users),
      predicates: [],
      values: {
        name: { kind: 'json-set', path: ['a'], value: 1 } } } as never)).toThrow('require "name" to be a JSON column')

    expect(() => validateQueryPlan({
      kind: 'update',
      source: createTableSource(users),
      predicates: [],
      values: {
        meta: [{ kind: 'bad-op', path: ['a'], value: 1 } as never] } } as never)).toThrow('Update value for column "meta" is malformed.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      orderBy: [{ kind: 'vector', column: 'name', vector: [1, 2, 3] }] } as never)).toThrow('Vector ordering requires "name" to be a vector column.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      orderBy: [{ kind: 'vector', column: 'embedding', vector: [1, Number.NaN] }] } as never)).toThrow('requires a non-empty numeric vector')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      orderBy: [{ kind: 'column', column: 'name', direction: 'sideways' }] } as never)).toThrow('Order direction "sideways" is not allowed.')
  })


  it('compiles returning clauses for insert, upsert, update, and delete mutation plans', () => {
    const compiler = new PostgresQueryCompiler(
      identifier => `"${identifier}"`,
      index => `$${index}`,
    )
    const users = defineTable('users', {
      id: column.id(),
      active: column.boolean(),
    })

    expect(compiler.compile(createInsertQueryPlan(
      createTableSource(users),
      [{ active: true }],
      { returning: true },
    ))).toEqual(expect.objectContaining({
      sql: 'INSERT INTO "users" ("active") VALUES ($1) RETURNING *',
      bindings: [true],
    }))
    expect(compiler.compile(createInsertQueryPlan(
      createTableSource(users),
      [{ active: true }],
      { ignoreConflicts: true, returning: true },
    )).sql).toBe('INSERT INTO "users" ("active") VALUES ($1) ON CONFLICT DO NOTHING RETURNING *')
    expect(compiler.compile(createUpsertQueryPlan(
      createTableSource(users),
      [{ id: 1, active: true }],
      ['id'],
      ['active'],
      { returning: true },
    ))).toEqual(expect.objectContaining({
      sql: 'INSERT INTO "users" ("id", "active") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "active" = EXCLUDED."active" RETURNING *',
      bindings: [1, true],
    }))
    expect(compiler.compile(createUpdateQueryPlan(
      createTableSource(users),
      [{ kind: 'comparison', column: 'id', operator: '=', value: 1 }],
      { active: true },
      { returning: true },
    ))).toEqual(expect.objectContaining({
      sql: 'UPDATE "users" SET "active" = $1 WHERE "id" = $2 RETURNING *',
      bindings: [true, 1],
    }))
    expect(compiler.compile(createDeleteQueryPlan(
      createTableSource(users),
      [{ kind: 'comparison', column: 'id', operator: '=', value: 1 }],
      { returning: true },
    ))).toEqual(expect.objectContaining({
      sql: 'DELETE FROM "users" WHERE "id" = $1 RETURNING *',
      bindings: [1],
    }))
  })


  it('validates comprehensive happy-path plans directly', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      meta: column.json<Record<string, unknown>>().nullable(),
      embedding: column.vector({ dimensions: 3 }).nullable() })

    const subquery = {
      ...createSelectQueryPlan(createTableSource(users)),
      selections: [{ kind: 'column', column: 'id' }] } as const

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource('users as u')),
      selections: [
        { kind: 'column', column: 'name', alias: 'displayName' },
        { kind: 'subquery', query: subquery, alias: 'subId' },
      ],
      joins: [{
        type: 'inner',
        subquery,
        alias: 'sub_users',
        leftColumn: 'u.id',
        operator: '=',
        rightColumn: 'sub_users.id' }],
      unions: [{ all: true, query: subquery }],
      predicates: [
        { kind: 'comparison', column: 'name', operator: '=', value: 'Mohamed' },
        { kind: 'column', column: 'u.id', operator: '=', compareTo: 'u.id' },
        { kind: 'null', column: 'meta', negated: false },
        { kind: 'date', column: 'name', part: 'date', operator: '=', value: '2025-01-01' },
        { kind: 'json', column: 'meta', path: ['enabled'], jsonMode: 'value', operator: '=', value: true },
        { kind: 'fulltext', columns: ['name'], mode: 'natural', value: 'mohamed' },
        { kind: 'vector', column: 'embedding', vector: [1, 2, 3], minSimilarity: 0.4 },
        { kind: 'exists', subquery },
        { kind: 'subquery', column: 'id', operator: 'in', subquery },
      ],
      groupBy: ['name'],
      having: [{ expression: 'count(*)', operator: '>', value: 1 }],
      orderBy: [
        { kind: 'random' },
        { kind: 'column', column: 'name', direction: 'asc' },
        { kind: 'vector', column: 'embedding', vector: [1, 2, 3] },
      ],
      limit: 10,
      offset: 2 } as never)).not.toThrow()

    expect(() => validateQueryPlan({
      kind: 'insert',
      source: createTableSource(users),
      ignoreConflicts: false,
      values: [{ name: 'A' }] } as never)).not.toThrow()

    expect(() => validateQueryPlan({
      kind: 'upsert',
      source: createTableSource(users),
      values: [{ id: 1, name: 'A' }],
      uniqueBy: ['id'],
      updateColumns: ['name'] } as never)).not.toThrow()

    expect(() => validateQueryPlan({
      kind: 'update',
      source: createTableSource(users),
      predicates: [{ kind: 'comparison', column: 'name', operator: '=', value: 'A' }],
      values: { meta: { kind: 'json-set', path: ['enabled'], value: true } } } as never)).not.toThrow()

    expect(() => validateQueryPlan({
      kind: 'delete',
      source: createTableSource(users),
      predicates: [{ kind: 'comparison', column: 'name', operator: '=', value: 'A' }] } as never)).not.toThrow()
  })

  it('rejects remaining validator edge branches directly', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      meta: column.json<Record<string, unknown>>().nullable(),
      embedding: column.vector({ dimensions: 3 }).nullable() })

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{ kind: 'comparison', column: 'name', operator: 'in', value: [] }] } as never)).toThrow('must be a non-empty array')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{ kind: 'comparison', column: 'name', operator: 'between', value: [1] }] } as never)).toThrow('must provide exactly two boundary values')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      predicates: [{ kind: 'comparison', column: 'name', operator: '=', value: undefined }] } as never)).toThrow('Predicate value for column "name" cannot be undefined.')

    expect(() => validateQueryPlan({
      ...createSelectQueryPlan(createTableSource(users)),
      orderBy: [{ kind: 'vector', column: 'users.embedding', vector: [1, 2] }] } as never)).toThrow('must provide 3 dimensions')

    expect(() => validateQueryPlan({
      kind: 'upsert',
      source: createTableSource(users),
      values: [],
      uniqueBy: ['id'],
      updateColumns: ['name'] } as never)).toThrow('Upsert queries must include at least one row.')

    expect(() => validateQueryPlan({
      kind: 'upsert',
      source: createTableSource(users),
      values: [{}],
      uniqueBy: ['id'],
      updateColumns: ['name'] } as never)).toThrow('Upsert queries must include at least one column.')

    expect(() => validateQueryPlan({
      kind: 'upsert',
      source: createTableSource(users),
      values: [{ id: 1, name: 'A' }],
      uniqueBy: ['meta'],
      updateColumns: ['name'] } as never)).toThrow('must be present in every row')

    expect(() => validateQueryPlan({
      kind: 'upsert',
      source: createTableSource(users),
      values: [{ id: 1, name: 'A' }],
      uniqueBy: ['id'],
      updateColumns: ['meta'] } as never)).toThrow('must be present in every row')
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('preserves every concurrent increment and decrement across matching rows on %s', async (driver) => {
    let writes = 0
    const { db, table, schema } = await openDatabase(driver, {
      logger: { onQuerySuccess: entry => { if (entry.kind === 'execute') writes += 1 } },
    })
    await schema.table(table.tableName, table => { table.integer('score').default(0) })
    const counters = defineTable(table.tableName, { ...table.columns, score: column.integer() })
    await db.table(counters).insert([
      { id: 1, name: 'First', score: 100, active: true },
      { id: 2, name: 'Second', score: 200, active: true },
      { id: 3, name: 'Inactive', score: 300, active: false },
    ])
    writes = 0
    const query = db.table(counters).where('active', true)
    const results = await Promise.all(Array.from({ length: 20 }, () => [
      query.increment('score', 3),
      query.decrement('score', 2),
    ]).flat())

    expect(results.every(result => result.affectedRows === 2)).toBe(true)
    expect(writes).toBe(40)
    expect(await db.table(counters).orderBy('id').pluck('score')).toEqual([120, 220, 300])
  })

  it('preserves bounded row selection with disjunctive counter predicates', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE counters (id INTEGER PRIMARY KEY, score INTEGER NOT NULL, active INTEGER NOT NULL)')
    await adapter.execute('INSERT INTO counters VALUES (1, 10, 1), (2, 20, 1), (3, 30, 0)')
    const counters = defineTable('counters', { id: column.id(), score: column.integer(), active: column.boolean() })
    const query = DB.table(counters).where('active', true).orWhere('id', 3).orderBy('id', 'desc').limit(1).offset(1)

    expect((await query.increment('score', 5)).affectedRows).toBe(1)
    expect(await DB.table(counters).orderBy('id').pluck('score')).toEqual([10, 25, 30])
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('adjusts bigint budgets through declared and named tables in transactions on %s', async (driver) => {
    const { db, table, schema } = await openDatabase(driver)
    await schema.table(table.tableName, table => { table.bigInteger('reserved_micros').default(0) })
    const budgets = defineTable(table.tableName, { ...table.columns, reserved_micros: column.bigInteger() })
    await db.table(budgets).insert([
      { id: 1, name: 'Current', reserved_micros: 1_000_000_000_000 },
      { id: 2, name: 'Previous', reserved_micros: 2_000_000_000_000 },
    ])

    await db.transaction(async (tx) => {
      expect((await tx.table(budgets).where('id', 1).increment('reserved_micros', 500)).affectedRows).toBe(1)
      expect((await tx.table(table.tableName).where('id', 1).decrement('reserved_micros', 200)).affectedRows).toBe(1)
    })

    const rows = await db.table(budgets).orderBy('id').pluck('reserved_micros')
    expect(rows.map(Number)).toEqual([1_000_000_000_300, 2_000_000_000_000])
  })

  it('updates only matching rows when incrementing and decrementing with extra values', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL, active INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'First', 10, 1), (2, 'Second', 20, 1), (3, 'Inactive', 15, 0)")
    const users = defineTable('users', { id: column.id(), name: column.string(), score: column.integer(), active: column.boolean() })
    expect((await DB.table(users).where('active', true).increment('score', 2, { name: 'Boosted' })).affectedRows).toBe(2)
    expect(await DB.table(users).orderBy('id').select('name', 'score').get()).toEqual([
      { name: 'Boosted', score: 12 },
      { name: 'Boosted', score: 22 },
      { name: 'Inactive', score: 15 },
    ])
    expect((await DB.table(users).where('id', 1).decrement('score', 4, { name: 'Lowered' })).affectedRows).toBe(1)
    expect(await DB.table(users).where('id', 1).select('name', 'score').first()).toEqual({ name: 'Lowered', score: 8 })
    expect((await DB.table('users').where('id', 3).increment('score', 5)).affectedRows).toBe(1)
    expect(await DB.table(users).where('id', 3).value('score')).toBe(20)
    expect((await DB.table(users).where('id', 99).increment('score', 1)).affectedRows).toBe(0)
    for (const amount of [Number.NaN, Infinity, -Infinity]) {
      await expect(DB.table(users).increment('score', amount)).rejects.toThrow(SecurityError)
      await expect(DB.table(users).decrement('score', amount)).rejects.toThrow(SecurityError)
    }
    await adapter.execute("UPDATE users SET score = 'bad' WHERE id = 1")
    await expect(DB.table(users).where('id', 1).increment('score', 1)).rejects.toThrow(CompilerError)
  })

  it('filters persisted timestamps by numeric year, month, day, date, and time', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE dated_records (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL)')
    await adapter.execute("INSERT INTO dated_records VALUES (1, '2026-03-25T10:30:00.000Z'), (2, '2025-03-25T10:30:00.000Z'), (3, '2026-04-26T12:00:00.000Z')")
    const records = () => DB.table('dated_records')
    expect(await records().whereYear('created_at', 2026).orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await records().whereMonth('created_at', 3).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await records().whereDay('created_at', 25).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await records().whereMonth('created_at', '04').pluck('id')).toEqual([3])
    expect(await records().whereDate('created_at', '2026-03-25').pluck('id')).toEqual([1])
    expect(await records().whereTime('created_at', '10:30:00').orderBy('id').pluck('id')).toEqual([1, 2])
  })

  it('compiles pessimistic lock clauses per dialect and degrades SQLite locks to plain selects', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('postgres') } } }))

    expect(DB.table(users).where('id', 1).lockForUpdate().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = $1 FOR UPDATE',
      bindings: [1],
      source: 'query:select:users' })
    expect(DB.table(users).sharedLock().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" FOR SHARE',
      bindings: [],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('mysql') } } }))

    expect(DB.table(users).where('id', 1).lock('update').toSQL()).toEqual({
      sql: 'SELECT * FROM `users` WHERE `id` = ? FOR UPDATE',
      bindings: [1],
      source: 'query:select:users' })
    expect(DB.table(users).lock('share').toSQL()).toEqual({
      sql: 'SELECT * FROM `users` LOCK IN SHARE MODE',
      bindings: [],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('sqlite') } } }))

    expect(DB.table(users).lockForUpdate().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
    expect(DB.table(users).sharedLock().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
  })

  it('executes correlated EXISTS and NOT EXISTS predicates', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, userId INTEGER, title TEXT)')
    await adapter.execute('INSERT INTO users VALUES (1), (2), (3)')
    await adapter.execute("INSERT INTO posts VALUES (1, 1, 'Hello'), (2, 2, 'World')")
    const posts = DB.table('posts').whereColumn('posts.userId', '=', 'users.id')
    expect(await DB.table('users').whereExists(posts).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await DB.table('users').whereNotExists(posts).orWhereExists(posts.where('title', 'like', 'Hello%')).orderBy('id').pluck('id')).toEqual([1, 3])
  })

  it('executes scalar and set subquery predicates', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, score INTEGER)')
    await adapter.execute('CREATE TABLE scores (id INTEGER PRIMARY KEY, userId INTEGER, amount INTEGER)')
    await adapter.execute('INSERT INTO users VALUES (1, 10), (2, 30), (3, 50)')
    await adapter.execute('INSERT INTO scores VALUES (1, 1, 20), (2, 3, 40)')
    expect(await DB.table('users').whereSub('score', '>=', DB.table('scores').select('amount').where('userId', 1).limit(1)).orderBy('id').pluck('id')).toEqual([2, 3])
    expect(await DB.table('users').whereInSub('id', DB.table('scores').select('userId').where('amount', '>', 10)).orWhereSub('score', '=', DB.table('scores').select('amount').where('id', 1).limit(1)).orderBy('id').pluck('id')).toEqual([1, 3])
  })

  it('executes inner, left, right, and cross joins and rejects unsafe join identifiers', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, userId INTEGER)')
    await adapter.execute('CREATE TABLE profiles (userId INTEGER, country TEXT)')
    await adapter.execute('CREATE TABLE countries (name TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A'), (2, 'B')")
    await adapter.execute('INSERT INTO posts VALUES (10, 1), (20, 3)')
    await adapter.execute("INSERT INTO profiles VALUES (2, 'EG')")
    await adapter.execute("INSERT INTO countries VALUES ('EG'), ('DE')")
    const users = () => DB.table('users')
    expect(await users().join('posts', 'users.id', '=', 'posts.userId').leftJoin('profiles', 'profiles.userId', '=', 'users.id').select('users.name', 'posts.id as postId', 'profiles.country').get()).toEqual([{ name: 'A', postId: 10, country: null }])
    expect(await users().rightJoin('posts', 'posts.userId', '=', 'users.id').select('users.name', 'posts.id as postId').orderBy('posts.id').get()).toEqual([{ name: 'A', postId: 10 }, { name: null, postId: 20 }])
    expect(await users().crossJoin('countries').count()).toBe(4)
    await expect(users().join('bad table', 'users.id', '=', 'posts.userId').get()).rejects.toThrow(SecurityError)
    await expect(users().join('posts', 'users.id', 'in' as never, 'posts.userId').get()).rejects.toThrow(SecurityError)
    await expect(users().join('posts', 'users.id;', '=', 'posts.userId').get()).rejects.toThrow(SecurityError)
  })

  it('preserves SQL and locks when table definitions replace string joins', () => {
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const members = defineTable('members', { id: column.id(), userId: column.integer() })

    for (const dialect of [createDatabaseDialect('postgres'), createDatabaseDialect('mysql')]) {
      configureDB(createConnectionManager({
        defaultConnection: 'default',
        connections: { default: { adapter: createTestAdapter(), dialect } },
      }))
      const typed = DB.table(members)
        .join(users, 'members.userId', '=', 'users.id')
        .select('members.id', 'users.name as userName')
        .where('members.id', 1)
      const strings = DB.table(members)
        .join('users', 'members.userId', '=', 'users.id')
        .select('members.id', 'users.name as userName')
        .where('members.id', 1)

      expect(typed.lockForUpdate().toSQL()).toEqual(strings.lockForUpdate().toSQL())
      expect(typed.sharedLock().toSQL()).toEqual(strings.sharedLock().toSQL())
      expect(typed.lockForUpdate().toSQL().sql).toContain('FOR UPDATE')
      expect(typed.sharedLock().toSQL().sql).toContain(dialect.name === 'mysql' ? 'LOCK IN SHARE MODE' : 'FOR SHARE')
    }
  })

  it('executes UNION with deduplication and UNION ALL with duplicates', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A'), (2, 'B'), (3, 'C')")
    const first = DB.table('users').where('id', '<', 3).select('id', 'name')
    const second = DB.table('users').where('id', '>', 1).select('id', 'name')
    expect(await first.union(second).orderBy('id').get()).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }])
    expect(await first.unionAll(second).orderBy('id').limit(3).get()).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 2, name: 'B' }])
  })

  it('executes subquery joins and rejects missing aliases', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute('CREATE TABLE posts (userId INTEGER, title TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A'), (2, 'B')")
    await adapter.execute("INSERT INTO posts VALUES (1, 'Hello A'), (2, 'World B')")
    const recent = DB.table('posts').select('userId').where('title', 'like', 'Hello%')
    expect(await DB.table('users').joinSub(recent, 'recent', 'recent.userId', '=', 'users.id')
      .leftJoinSub(DB.table('posts').select('userId').where('title', 'like', 'World%'), 'world', 'world.userId', '=', 'users.id')
      .select('users.name', 'world.userId as otherId').get()).toEqual([{ name: 'A', otherId: null }])
    await expect(DB.table('users').joinSub(recent, '', 'recent.userId', '=', 'users.id').get()).rejects.toThrow(SecurityError)
  })

  it('returns selected aliases and rejects malformed aliases', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (name TEXT, status TEXT)')
    await adapter.execute("INSERT INTO users VALUES ('A', 'active')")
    expect(await DB.table('users').select('name as displayName', 'status').get()).toEqual([{ displayName: 'A', status: 'active' }])
    expect(await DB.table('users').select('users.name as displayName').get()).toEqual([{ displayName: 'A' }])
    await expect(DB.table('users').select('name as bad alias').get()).rejects.toThrow(SecurityError)
  })

  it('reads aliased sources through table and from and rejects malformed aliases', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A'), (2, 'B')")
    expect(await DB.table('users as u').where('u.id', 1).value('u.name')).toBe('A')
    expect(await DB.table('users').from('users as u').select('u.name as displayName').where('u.id', 2).get()).toEqual([{ displayName: 'B' }])
    await expect(DB.table('users as bad alias').get()).rejects.toThrow(SecurityError)
  })

  it('returns correlated scalar subquery selections and null for missing rows', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute('CREATE TABLE posts (userId INTEGER, title TEXT)')
    await adapter.execute("INSERT INTO users VALUES (1, 'A'), (2, 'B')")
    await adapter.execute("INSERT INTO posts VALUES (1, 'Hello')")
    const latest = DB.table('posts').select('title').whereColumn('posts.userId', '=', 'users.id').limit(1)
    expect(await DB.table('users').selectSub(latest, 'latestTitle').orderBy('id').get()).toEqual([{ latestTitle: 'Hello' }, { latestTitle: null }])
    expect(await DB.table('users').select('name').addSelectSub(latest, 'latestTitle').orderBy('id').get()).toEqual([{ name: 'A', latestTitle: 'Hello' }, { name: 'B', latestTitle: null }])
  })

  it('compiles lateral joins only on supporting dialects', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('postgres') } } }))

    const lateralSubquery = DB.table(posts)
      .select('title')
      .whereColumn('posts.userId', '=', 'users.id')
      .limit(1)

    expect(DB.table(users).joinLateral(lateralSubquery, 'latest_post').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" INNER JOIN LATERAL (SELECT "title" FROM "posts" WHERE "posts"."userId" = "users"."id" LIMIT 1) AS "latest_post" ON TRUE',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).leftJoinLateral(lateralSubquery, 'latest_post').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" LEFT JOIN LATERAL (SELECT "title" FROM "posts" WHERE "posts"."userId" = "users"."id" LIMIT 1) AS "latest_post" ON TRUE',
      bindings: [],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('mysql') } } }))

    expect(DB.table(users).joinLateral(lateralSubquery, 'latest_post').toSQL()).toEqual({
      sql: 'SELECT * FROM `users` INNER JOIN LATERAL (SELECT `title` FROM `posts` WHERE `posts`.`userId` = `users`.`id` LIMIT 1) `latest_post` ON TRUE',
      bindings: [],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('sqlite') } } }))

    expect(() => DB.table(users).joinLateral(lateralSubquery, 'latest_post').toSQL()).toThrow(CompilerError)
  })

  it('compiles full-text predicates only on supporting dialects', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      bio: column.text() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('postgres') } } }))

    expect(DB.table(users).whereFullText(['name', 'bio'], 'mohamed').toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE to_tsvector(concat_ws(' ', "name", "bio")) @@ websearch_to_tsquery($1)`,
      bindings: ['mohamed'],
      source: 'query:select:users' })

    expect(DB.table(users).orWhereFullText('bio', 'mohamed:*', { mode: 'boolean' }).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE to_tsvector("bio") @@ to_tsquery($1)',
      bindings: ['mohamed:*'],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('mysql') } } }))

    expect(DB.table(users).whereFullText(['name', 'bio'], 'mohamed').toSQL()).toEqual({
      sql: 'SELECT * FROM `users` WHERE MATCH (`name`, `bio`) AGAINST (? IN NATURAL LANGUAGE MODE)',
      bindings: ['mohamed'],
      source: 'query:select:users' })

    expect(DB.table(users).whereFullText('bio', '+mohamed*', { mode: 'boolean' }).toSQL()).toEqual({
      sql: 'SELECT * FROM `users` WHERE MATCH (`bio`) AGAINST (? IN BOOLEAN MODE)',
      bindings: ['+mohamed*'],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('sqlite') } } }))

    expect(() => DB.table(users).whereFullText('bio', 'mohamed').toSQL()).toThrow(CompilerError)
    expect(() => DB.table(users).whereFullText([], 'mohamed')).toThrow(SecurityError)
    await expect(DB.table(users).whereFullText('bio', '   ').get()).rejects.toThrow(SecurityError)
  })

  it('compiles vector similarity clauses for Postgres and fails closed elsewhere', async () => {
    const documents = defineTable('documents', {
      id: column.id(),
      title: column.string(),
      embedding: column.vector({ dimensions: 3 }) })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('postgres') } } }))

    expect(DB.table(documents).whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.4).limit(10).toSQL()).toEqual({
      sql: 'SELECT * FROM "documents" WHERE "embedding" <=> CAST($1 AS vector) <= $2 ORDER BY "embedding" <=> CAST($3 AS vector) ASC LIMIT 10',
      bindings: ['[0.1,0.2,0.3]', 0.6, '[0.1,0.2,0.3]'],
      source: 'query:select:documents' })

    await expect(DB.table(documents).whereVectorSimilarTo('embedding', [0.1, 0.2], 0.4).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(documents).whereVectorSimilarTo('title' as never, [0.1, 0.2, 0.3], 0.4).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(documents).whereVectorSimilarTo('embedding', [0.1, Number.NaN, 0.3], 0.4).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(documents).whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 1.2).get()).rejects.toThrow(SecurityError)

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('sqlite') } } }))

    expect(() => DB.table(documents).whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.4).toSQL()).toThrow(CompilerError)

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('mysql') } } }))

    expect(() => DB.table(documents).whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.4).toSQL()).toThrow(CompilerError)
  })

  it('filters persisted JSON values and rejects malformed paths and comparisons', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, settings TEXT)')
    const users = defineTable('users', { id: column.id(), name: column.string(), settings: column.json() })
    await DB.table(users).insert([
      { id: 1, name: 'A', settings: { profile: { region: 'eu' }, tags: ['beta', 'paid'], enabled: true } },
      { id: 2, name: 'B', settings: { profile: { region: null }, tags: [], enabled: false } },
      { id: 3, name: 'C', settings: { region: 'eu' } },
    ])
    expect(await DB.table(users).whereJson('settings->profile->region', 'eu').whereJsonContains('settings->tags', 'beta').whereJsonLength('settings->tags', '>=', 2).pluck('id')).toEqual([1])
    expect(await DB.table(users).where('settings->profile->region', 'eu').pluck('id')).toEqual([1])
    expect(await DB.table(users).whereJson('settings->enabled', true).pluck('id')).toEqual([1])
    expect(await DB.table(users).whereJson('settings->enabled', false).pluck('id')).toEqual([2])
    expect(await DB.table(users).whereJson('settings->profile->region', '=', null).pluck('id')).toEqual([2])
    expect(await DB.table(users).whereJson('settings->profile->region', '!=', null).pluck('id')).toEqual([1])
    expect(await DB.table(users).whereJsonContains('settings', { region: 'eu' }).pluck('id')).toEqual([3])
    expect(() => DB.table(users).whereJson('settings->', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('->profile' as never, 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('   ' as never, 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->>profile', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJsonContains('name->profile', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).where('name->profile', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->profile', '>', null)).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->profile', 'like', null)).toThrow(SecurityError)
    await expect(DB.table(users).whereJsonLength('settings->tags', 'like' as never, 2).get()).rejects.toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->profile', { region: 'eu' } as never)).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->profile', Number.NaN)).toThrow(SecurityError)
  })

  it('updates nested JSON fields without losing siblings and rejects invalid update payloads', async () => {
    await createRealQueryDatabase()
    await createSchemaService(DB.connection()).createTable('json_records', table => {
      table.id()
      table.string('name')
      table.json('settings')
    })
    const users = defineTable('json_records', { id: column.id(), name: column.string(), settings: column.json() })
    await DB.table(users).insert({ id: 1, name: 'A', settings: { profile: { region: 'us', language: 'en' }, flags: { beta: false } } })
    const result = await DB.table(users).where('id', 1).update({ 'settings->profile->region': 'eu', 'settings->flags->beta': true })
    expect(result.affectedRows).toBe(1)
    expect(await DB.table(users).whereJson('settings->profile->region', 'eu').whereJson('settings->profile->language', 'en').whereJson('settings->flags->beta', true).pluck('id')).toEqual([1])
    await expect(DB.table(users).update({ 'settings->profile->region': undefined })).rejects.toThrow(SecurityError)
    await expect(DB.table(users).update({ settings: {}, 'settings->profile->region': 'eu' })).rejects.toThrow(SecurityError)
    await expect(DB.table(users).update({ 'name->profile': 'eu' })).rejects.toThrow(SecurityError)
    expect((await DB.table(users).where('id', 1).updateJson('settings->profile->region', 'mena')).affectedRows).toBe(1)
    expect(await DB.table(users).whereJson('settings->profile->region', 'mena').whereJson('settings->profile->language', 'en').pluck('id')).toEqual([1])
  })

  it('uses registered schema metadata when writing through a string table name', async () => {
    await createRealQueryDatabase()
    await createSchemaService(DB.connection()).createTable('registered_records', table => {
      table.id()
      table.json('settings')
      table.boolean('enabled')
    })
    const id = await DB.table('registered_records').insertGetId({ settings: { tags: ['native'], active: true }, enabled: true })
    expect(await DB.table('registered_records').whereJson('settings->active', true).where('enabled', true).pluck('id')).toEqual([id])
    await DB.table('registered_records').where('id', id).update({ settings: { tags: [], active: false }, enabled: false })
    expect(await DB.table('registered_records').whereJson('settings->active', false).where('enabled', false).pluck('id')).toEqual([id])
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('compares complete JSON arrays and sets on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert([
      { id: 1, name: 'First', settings: ['native', 'one'] },
      { id: 2, name: 'Second', settings: ['native', 'two'] },
      { id: 3, name: 'Empty', settings: [] },
    ])
    const ids = (values: readonly (string | number)[]) => values.map(Number)
    expect(ids(await db.table(table).where('settings', ['native', 'one']).pluck('id'))).toEqual([1])
    expect(ids(await db.table(table).where('settings', []).pluck('id'))).toEqual([3])
    expect(ids(await db.table(table).whereIn('settings', [['native', 'one'], ['native', 'two']]).orderBy('id').pluck('id'))).toEqual([1, 2])
    expect(ids(await db.table(table).whereNotIn('settings', [['native', 'one'], ['native', 'two']]).pluck('id'))).toEqual([3])
  })

  it('persists direct writes that can be queried through declared JSON, boolean, and date columns', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE capability_samples (id INTEGER PRIMARY KEY, title TEXT, payload TEXT, is_enabled INTEGER, published_at TEXT)')
    const capabilities = defineTable('capability_samples', { id: column.id(), title: column.string(), payload: column.json(), is_enabled: column.boolean(), published_at: column.datetime() })
    const publishedAt = new Date('2026-03-31T12:00:00.000Z')
    const id = await DB.table(capabilities).insertGetId({ title: 'Matrix', payload: { ok: true }, is_enabled: true, published_at: publishedAt })
    expect(await DB.table(capabilities).where('id', id).whereJson('payload->ok', true).where('is_enabled', true).whereDate('published_at', '2026-03-31').value('title')).toBe('Matrix')
  })

  it('executes explicitly enabled raw SQL with bound values', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (7, 'A'), (8, 'B')")
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDatabaseDialect('sqlite'), security: { allowUnsafeRawSql: true } } } }))
    const result = await DB.unsafeQuery(DB.raw('SELECT name FROM users WHERE id = ?', [7]))
    expect(result.rows).toEqual([{ name: 'A' }])
    expect(await DB.table('users').count()).toBe(2)
  })

  it('fails closed for malformed set and range predicates', async () => {
    const users = defineTable('users', {
      id: column.id(),
      score: column.integer(),
      minScore: column.integer(),
      maxScore: column.integer() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: createTestAdapter(),
          dialect: createDatabaseDialect('sqlite') } } }))

    await expect(DB.table(users).whereIn('id', []).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).whereNotIn('id', [1, undefined] as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).whereBetween('score', [1] as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).whereNotBetween('score', [1, undefined] as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).whereColumn('minScore', '=', 'missing' as never).get()).rejects.toThrow(SecurityError)
    expect(() => DB.table(users).whereAny([], '=', 1)).toThrow(SecurityError)
    await expect(DB.table(users).groupBy('missing' as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).groupBy('id').having('count(id) + 1' as never, '>=', 1).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).groupBy('id').havingBetween('count(*)', [1] as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).groupBy('id').having('count(*)', 'sideways' as never, 1).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).groupBy('id').havingBetween('count(*)', [1, undefined] as never).get()).rejects.toThrow(SecurityError)
  })

  it('inserts, updates, and deletes persisted rows with declared value normalization', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0)')
    const users = defineTable('users', { id: column.id(), name: column.string(), active: column.boolean() })
    expect((await DB.table(users).insert([{ name: 'Mohamed', active: true }, { name: 'Amina', active: false }])).affectedRows).toBe(2)
    expect(await DB.table(users).where('active', true).pluck('name')).toEqual(['Mohamed'])
    expect((await DB.table(users).where('name', 'Amina').update({ active: true })).affectedRows).toBe(1)
    expect(await DB.table(users).where('active', true).orderBy('id').pluck('name')).toEqual(['Mohamed', 'Amina'])
    expect((await DB.table(users).where('name', 'Mohamed').delete()).affectedRows).toBe(1)
    await DB.table('users').insert({ name: 'Solo' })
    expect(await DB.table(users).orderBy('id').pluck('name')).toEqual(['Amina', 'Solo'])
    expect(await DB.table(users).where('active', false).pluck('name')).toEqual(['Solo'])
  })

  it('aggregates persisted records and handles an empty table', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed', 10), (2, 'Amina', 20), (3, 'Salma', 30)")
    const users = defineTable('users', { id: column.id(), name: column.string(), score: column.integer() })
    expect(await DB.table(users).count()).toBe(3)
    expect(await DB.table(users).exists()).toBe(true)
    expect(await DB.table(users).doesntExist()).toBe(false)
    expect(await DB.table(users).orderBy('id').pluck('name')).toEqual(['Mohamed', 'Amina', 'Salma'])
    expect(await DB.table(users).orderBy('id').value('name')).toBe('Mohamed')
    expect(await DB.table(users).sum('score')).toBe(60)
    expect(await DB.table(users).avg('score')).toBe(20)
    expect(await DB.table(users).min('score')).toBe(10)
    expect(await DB.table(users).max('score')).toBe(30)
    await DB.table(users).delete()
    expect(await DB.table(users).count()).toBe(0)
    expect(await DB.table(users).exists()).toBe(false)
    expect(await DB.table(users).doesntExist()).toBe(true)
    expect(await DB.table(users).pluck('name')).toEqual([])
    expect(await DB.table(users).value('name')).toBeUndefined()
    expect(await DB.table(users).sum('score')).toBe(0)
    expect(await DB.table(users).avg('score')).toBeNull()
    expect(await DB.table(users).min('score')).toBeNull()
    expect(await DB.table(users).max('score')).toBeNull()
  })

  it('groups persisted rows into typed aggregate selections', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed', 10), (2, 'Amina', 20), (3, 'Mohamed', 30)")
    const users = defineTable('users', { id: column.id(), name: column.string(), score: column.integer() })
    expect(await DB.table(users).select('name').addSelectCount('total').addSelectSum('totalScore', 'score')
      .addSelectAvg('averageScore', 'score').addSelectMin('minimumScore', 'score').addSelectMax('maximumScore', 'score')
      .groupBy('name').orderBy('name').get()).toEqual([
      { name: 'Amina', total: 1, totalScore: 20, averageScore: 20, minimumScore: 20, maximumScore: 20 },
      { name: 'Mohamed', total: 2, totalScore: 40, averageScore: 20, minimumScore: 10, maximumScore: 30 },
    ])
    await expect(DB.table(users).selectCount('total').groupBy('missing' as never).get()).rejects.toThrow(SecurityError)
    expect(await DB.table(users).selectMin('minimumScore', 'score').first()).toEqual({ minimumScore: 10 })
    expect(await DB.table(users).selectMax('maximumScore', 'score').first()).toEqual({ maximumScore: 30 })
    expect(await DB.table(users).selectCount().first()).toEqual({ count: 3 })
    expect(await DB.table(users).selectSum('totalScore', 'score').first()).toEqual({ totalScore: 60 })
    expect(await DB.table(users).selectAvg('averageScore', 'score').first()).toEqual({ averageScore: 20 })
  })

  it('supports pagination and chunking on persisted table rows', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed'), (2, 'Amina'), (3, 'Salma'), (4, 'Youssef'), (5, 'Nada')")
    const users = defineTable('users', { id: column.id(), name: column.string() })
    expect((await DB.table(users).cursorPaginate(1)).data).toEqual([{ id: 1, name: 'Mohamed' }])
    expect(await DB.table(users).orderBy('id').forPage(2, 2).pluck('id')).toEqual([3, 4])
    expect(await DB.table(users).orderBy('id').skip(1).take(2).pluck('id')).toEqual([2, 3])

    const paginated = await DB.table(users).orderBy('id').paginate(2, 2)
    expect(paginated.data).toEqual([
      { id: 3, name: 'Salma' },
      { id: 4, name: 'Youssef' },
    ])
    expect(paginated.meta).toEqual({
      total: 5,
      perPage: 2,
      pageName: 'page',
      currentPage: 2,
      lastPage: 3,
      from: 3,
      to: 4,
      hasMorePages: true })
    expect(paginated.items()).toEqual(paginated.data)
    expect(paginated.firstItem()).toBe(3)
    expect(paginated.lastItem()).toBe(4)
    expect(paginated.hasPages()).toBe(true)
    expect(paginated.hasMorePages()).toBe(true)
    expect(paginated.getPageName()).toBe('page')
    expect(paginated.toJSON()).toEqual({
      data: paginated.data,
      meta: paginated.meta })

    const emptyPage = await DB.table(users).orderBy('id').paginate(2, 4)
    expect(emptyPage.meta.from).toBeNull()
    expect(emptyPage.meta.to).toBeNull()

    const simple = await DB.table(users).orderBy('id').simplePaginate(2, 3)
    expect(simple.data).toEqual([{ id: 5, name: 'Nada' }])
    expect(simple.meta).toEqual({
      perPage: 2,
      pageName: 'page',
      currentPage: 3,
      from: 5,
      to: 5,
      hasMorePages: false })
    expect(simple.items()).toEqual(simple.data)
    expect(simple.firstItem()).toBe(5)
    expect(simple.lastItem()).toBe(5)
    expect(simple.hasPages()).toBe(true)
    expect(simple.hasMorePages()).toBe(false)
    expect(simple.getPageName()).toBe('page')

    const firstSimple = await DB.table(users).orderBy('id').simplePaginate(2, 1)
    expect(firstSimple.data).toEqual([
      { id: 1, name: 'Mohamed' },
      { id: 2, name: 'Amina' },
    ])
    expect(firstSimple.meta.hasMorePages).toBe(true)

    const emptySimple = await DB.table(users).orderBy('id').simplePaginate(2, 4)
    expect(emptySimple.meta.from).toBeNull()
    expect(emptySimple.meta.to).toBeNull()

    const firstCursorPage = await DB.table(users).orderBy('id').cursorPaginate(2)
    expect(firstCursorPage.data).toEqual([
      { id: 1, name: 'Mohamed' },
      { id: 2, name: 'Amina' },
    ])
    expect(firstCursorPage.nextCursor).toBeTruthy()
    expect(firstCursorPage.cursorName).toBe('cursor')
    expect(firstCursorPage.prevCursor).toBeNull()
    expect(firstCursorPage.items()).toEqual(firstCursorPage.data)
    expect(firstCursorPage.hasMorePages()).toBe(true)
    expect(firstCursorPage.getCursorName()).toBe('cursor')
    const qualifiedCursorPage = await DB.table(users).orderBy('users.id').cursorPaginate(2)
    expect(qualifiedCursorPage.data.map(row => row.id)).toEqual([1, 2])
    expect(firstCursorPage.nextCursorToken()).toBe(firstCursorPage.nextCursor)
    expect(firstCursorPage.previousCursorToken()).toBeNull()
    expect(firstCursorPage.toJSON()).toEqual({
      data: firstCursorPage.data,
      perPage: firstCursorPage.perPage,
      cursorName: 'cursor',
      nextCursor: firstCursorPage.nextCursor,
      prevCursor: null })

    const lastCursorPage = await DB.table(users).orderBy('id').cursorPaginate(10)
    expect(lastCursorPage.nextCursor).toBeNull()

    const customPaginated = await DB.table(users).orderBy('id').paginate(2, 1, { pageName: ' usersPage ' })
    expect(customPaginated.meta.pageName).toBe('usersPage')
    const customSimple = await DB.table(users).orderBy('id').simplePaginate(2, 1, { pageName: ' usersPage ' })
    expect(customSimple.meta.pageName).toBe('usersPage')
    const customCursor = await DB.table(users).orderBy('id').cursorPaginate(2, null, { cursorName: ' usersCursor ' })
    expect(customCursor.cursorName).toBe('usersCursor')

    await adapter.execute('CREATE TABLE edge_users (id INTEGER PRIMARY KEY, sortKey INTEGER, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO edge_users VALUES (1, 1, 'Equal A'), (2, NULL, 'Null'), (3, 1, 'Equal B'), (4, NULL, 'Also null'), (5, 2, 'Two')")
    const ascending: string[] = []
    await DB.table('edge_users').chunkById(2, rows => { ascending.push(...rows.map(row => String(row.name))) }, 'sortKey')
    expect(ascending).toEqual(['Null', 'Also null', 'Equal A', 'Equal B', 'Two'])
    const descending: string[] = []
    await DB.table('edge_users').chunkByIdDesc(2, rows => { descending.push(...rows.map(row => String(row.name))) }, 'sortKey')
    expect(descending).toEqual(['Two', 'Equal A', 'Equal B', 'Null', 'Also null'])
    const stopped: string[] = []
    await DB.table('edge_users').chunkByIdDesc(1, rows => { stopped.push(...rows.map(row => String(row.name))); return stopped.length < 2 }, 'sortKey')
    expect(stopped).toEqual(['Two', 'Equal A'])
  })

  it('rejects malformed pagination and cursor inputs on table queries', async () => {
    const adapter = createTestAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDatabaseDialect('sqlite') } } }))

    await expect(DB.table('users').paginate(0, 1)).rejects.toThrow('Per-page value must be a positive integer.')
    expect(() => DB.table('users').forPage(0, 1)).toThrow('Page must be a positive integer.')
    expect(() => DB.table('users').forPage(1, 0)).toThrow('Per-page value must be a positive integer.')
    await expect(DB.table('users').paginate(1, 0)).rejects.toThrow('Page must be a positive integer.')
    await expect(DB.table('users').simplePaginate(0, 1)).rejects.toThrow('Per-page value must be a positive integer.')
    await expect(DB.table('users').simplePaginate(1, 0)).rejects.toThrow('Page must be a positive integer.')
    await expect(DB.table('users').simplePaginate(1, 1, { pageName: '' })).rejects.toThrow('Page parameter name must be a non-empty string.')
    await expect(DB.table('users').cursorPaginate(0)).rejects.toThrow('Per-page value must be a positive integer.')
    await expect(DB.table('users').chunkByIdDesc(0, () => {})).rejects.toThrow('Chunk size must be a positive integer.')
    await expect(DB.table('users').cursorPaginate(2, 'broken')).rejects.toThrow('Cursor is malformed.')
    await expect(DB.table('users').paginate(1, 1, { pageName: '' })).rejects.toThrow('Page parameter name must be a non-empty string.')
    await expect(DB.table('users').cursorPaginate(1, null, { cursorName: '' })).rejects.toThrow('Cursor parameter name must be a non-empty string.')
    await expect(DB.table('users').cursorPaginate(1)).rejects.toThrow('Cursor pagination requires an explicit stable orderBy clause.')
    await expect(DB.table('users').inRandomOrder().cursorPaginate(1)).rejects.toThrow('Cursor pagination cannot use random ordering.')
    await expect(DB.table('users').unsafeOrderBy('id', []).cursorPaginate(1)).rejects.toThrow('requires column orderBy clauses')
    const malformedCursor = Buffer.from(JSON.stringify({ offset: 'bad' }), 'utf8').toString('base64url')
    await expect(DB.table('users').cursorPaginate(2, malformedCursor)).rejects.toThrow('Cursor is malformed.')
    await expect(DB.table('users').chunk(0, () => undefined)).rejects.toThrow('Chunk size must be a positive integer.')
    await expect(DB.table('users').chunkById(0, () => undefined)).rejects.toThrow('Chunk size must be a positive integer.')
  })

  it('supports explicit unsafe raw builder APIs with policy enforcement', async () => {
    const deniedAdapter = createTestAdapter()
    await deniedAdapter.initialize()
    await deniedAdapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER)')
    await deniedAdapter.execute("INSERT INTO users VALUES (1, 'Mohamed', 10)")
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: deniedAdapter,
          dialect: createDatabaseDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer() })

    const unsafeBuilder = DB.table(users)
      .unsafeSelect('COUNT(*) AS "total"', [])
      .unsafeWhere('"name" = ?1', ['Mohamed'])
      .unsafeOrderBy('"total" DESC', [])

    await expect(unsafeBuilder.get()).rejects.toThrow(
      'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().',
    )

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: deniedAdapter,
          dialect: createDatabaseDialect('sqlite'),
          security: { allowUnsafeRawSql: true } } } }))

    expect(await DB.table(users)
      .unsafeSelect('COUNT(*) AS "total"', [])
      .unsafeWhere('"name" = ?1', ['Mohamed'])
      .unsafeOrderBy('"total" DESC', [])
      .get()).toEqual([{ total: 1 }])
    expect(await DB.table(users)
      .unsafeWhere('"name" = ?', ['Mohamed'])
      .get()).toEqual([{ id: 1, name: 'Mohamed', score: 10 }])

    await expect(DB.table(users).unsafeSelect('', []).get()).rejects.toThrow('Raw selection SQL must be a non-empty string.')
    await expect(DB.table(users).unsafeWhere('"name" = ?1', [undefined] as never).get()).rejects.toThrow('Raw predicate bindings cannot contain undefined values.')
    await expect(DB.table(users).unsafeOrderBy('', []).get()).rejects.toThrow('Raw ORDER BY SQL must be a non-empty string.')
    await expect(DB.table(users).unsafeSelect('COUNT(*) FILTER (WHERE "name" = ?1)', []).get()).rejects.toThrow(
      'Raw selection SQL placeholder count does not match the provided bindings.',
    )
    await expect(DB.table(users).unsafeWhere('"name" = "name"', ['Mohamed']).get()).rejects.toThrow(
      'Raw predicate SQL cannot provide bindings without placeholders.',
    )
    await expect(DB.table(users).unsafeWhere('"name" = ?1 OR "name" = $2', ['Mohamed', 'Amina']).get()).rejects.toThrow(
      'Raw predicate SQL cannot mix question-mark and dollar-numbered placeholders.',
    )
    await expect(DB.table(users).unsafeWhere('"name" = ?1 OR "score" = ?', ['Mohamed', 1]).get()).rejects.toThrow(
      'Raw predicate SQL cannot mix anonymous and numbered placeholders.',
    )
    await expect(DB.table(users).unsafeWhere('"name" = ?2', ['Mohamed', 'Amina']).get()).rejects.toThrow(
      'Raw predicate SQL must use contiguous numbered placeholders starting at 1.',
    )
    await expect(DB.table(users).unsafeOrderBy('CASE WHEN ? THEN 1 END', []).get()).rejects.toThrow(
      'Raw ORDER BY SQL placeholder count does not match the provided bindings.',
    )
    expect(DB.table(users).unsafeWhere('"name" = $abc', []).toSQL().sql).toContain('"name" = $abc')

    for (const count of [1, 2, 3, 4]) {
      const anonymousSql = Array.from({ length: count }, () => '"name" = ?').join(' OR ')
      const anonymousBindings = Array.from({ length: count }, () => 'Mohamed')
      await expect(DB.table(users).unsafeWhere(anonymousSql, anonymousBindings).get()).resolves.toEqual([
        { id: 1, name: 'Mohamed', score: 10 },
      ])

      await expect(DB.table(users).unsafeWhere(anonymousSql, anonymousBindings.slice(0, -1)).get()).rejects.toThrow(
        'Raw predicate SQL placeholder count does not match the provided bindings.',
      )

      const numberedSql = Array.from({ length: count }, (_, index) => `"score" = ?${index + 1}`).join(' OR ')
      const numberedBindings = Array.from({ length: count }, (_, index) => index + 10)
      await expect(DB.table(users).unsafeWhere(numberedSql, numberedBindings).get()).resolves.toEqual([
        { id: 1, name: 'Mohamed', score: 10 },
      ])
    }
  })

  it('binds raw fragments in query order without treating SQL literals and comments as parameters', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT)')
    await adapter.execute("INSERT INTO records VALUES (1, 'Alpha'), (2, 'Beta')")
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: {
      default: { adapter, dialect: createDatabaseDialect('sqlite'), security: { allowUnsafeRawSql: true } },
    } }))
    expect(await DB.table('records').unsafeSelect('?2 AS second, ?1 AS first, ?1 AS repeated', ['one', 'two'])
      .where('id', 1).unsafeWhere('name = $1 OR name = $1', ['Alpha'])
      .unsafeOrderBy('CASE WHEN id = ? THEN 0 ELSE 1 END', [1]).get()).toEqual([
      { second: 'two', first: 'one', repeated: 'one' },
    ])
    expect(await DB.table('records').unsafeSelect("'literal ? $1' AS text", [])
      .unsafeWhere('id = ? /* ignored ?1 */ -- ignored $2\n', [2]).get()).toEqual([{ text: 'literal ? $1' }])
  })

  it('supports manual paginator creation helpers', async () => {
    const paginated = createPaginator([{ id: 1 }], {
      total: 1,
      perPage: 15,
      currentPage: 1,
      lastPage: 1,
      from: 1,
      to: 1,
      hasMorePages: false })
    expect(paginated).toEqual({
      data: [{ id: 1 }],
      meta: {
        total: 1,
        perPage: 15,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 1,
        hasMorePages: false } })
    expect(paginated.hasPages()).toBe(false)
    expect(paginated.getPageName()).toBe('page')

    const simple = createSimplePaginator([{ id: 1 }], {
      perPage: 15,
      currentPage: 1,
      from: 1,
      to: 1,
      hasMorePages: false,
      pageName: 'usersPage' })
    expect(simple).toEqual({
      data: [{ id: 1 }],
      meta: {
        perPage: 15,
        pageName: 'usersPage',
        currentPage: 1,
        from: 1,
        to: 1,
        hasMorePages: false } })
    expect(simple.getPageName()).toBe('usersPage')
    expect(simple.hasPages()).toBe(false)
    expect(simple.toJSON()).toEqual({
      data: [{ id: 1 }],
      meta: {
        perPage: 15,
        pageName: 'usersPage',
        currentPage: 1,
        from: 1,
        to: 1,
        hasMorePages: false } })

    const cursor = createCursorPaginator([{ id: 1 }], {
      perPage: 15,
      nextCursor: 'next',
      prevCursor: null,
      cursorName: 'usersCursor' })
    expect(cursor).toEqual({
      data: [{ id: 1 }],
      perPage: 15,
      cursorName: 'usersCursor',
      nextCursor: 'next',
      prevCursor: null })
    expect(cursor.getCursorName()).toBe('usersCursor')
    expect(cursor.nextCursorToken()).toBe('next')

    expect(() => createPaginator([], {
      total: 0,
      perPage: 15,
      currentPage: 1,
      lastPage: 1,
      from: null,
      to: null,
      hasMorePages: false,
      pageName: '' })).toThrow('Page parameter name must be a non-empty string.')

    expect(() => createCursorPaginator([], {
      perPage: 15,
      nextCursor: null,
      prevCursor: null,
      cursorName: '' })).toThrow('Cursor parameter name must be a non-empty string.')
  })

  it('rejects columns that are not defined on metadata-backed tables', async () => {
    const adapter = createTestAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDatabaseDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    await expect(DB.table(users).where('email' as never, 'x@example.com').get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).update({ email: 'x@example.com' })).rejects.toThrow(
      'Column "email" is not defined on table "users".',
    )
  })

  it('rejects malformed identifiers, unsupported operators, and invalid query shapes', async () => {
    const adapter = createTestAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDatabaseDialect('sqlite') } } }))

    await expect(DB.table('users;drop').get()).rejects.toThrow(SecurityError)
    await expect(DB.table('users').where('name', 'contains' as never, 'Mohamed').get()).rejects.toThrow(
      'Operator "contains" is not allowed in safe query mode.',
    )
    await expect(DB.table('users').where('name', undefined).get()).rejects.toThrow(
      'Predicate value for column "name" cannot be undefined.',
    )
    await expect(DB.table('users').where('id', 'in', []).get()).rejects.toThrow(
      'IN predicate for column "id" must be a non-empty array.',
    )
    await expect(DB.table('users').where('id', 'in', [1, undefined] as never).get()).rejects.toThrow(
      'IN predicate for column "id" cannot contain undefined values.',
    )
    await expect(DB.table('users').orderBy('name', 'sideways' as never).get()).rejects.toThrow(
      'Order direction "sideways" is not allowed.',
    )
    await expect(DB.table('users').limit(-1).get()).rejects.toThrow('Limit must be a non-negative integer.')
    await expect(DB.table('users').insert([])).rejects.toThrow('Insert queries must include at least one row.')
    await expect(DB.table('users').insert([{}])).rejects.toThrow('Insert queries must include at least one column.')
    await expect(DB.table('users').insert([{ name: 'Mohamed' }, { active: true }])).rejects.toThrow(
      'Every inserted row must provide the same set of columns.',
    )
    await expect(DB.table('users').insert({ name: undefined })).rejects.toThrow(
      'Insert value for column "name" cannot be undefined.',
    )
    await expect(DB.table('users').update({})).rejects.toThrow('Update queries must include at least one column.')
    await expect(DB.table('users').update({ name: undefined })).rejects.toThrow(
      'Update value for column "name" cannot be undefined.',
    )
    await adapter.initialize()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO users VALUES (1, 'Mohamed')")
    await expect(DB.table('users').sum('name')).rejects.toThrow(
      'Query aggregate "sum" requires numeric values for column "name".',
    )
  })

  it('stores and retrieves hostile values as data while rejecting identifier injection', async () => {
    const adapter = await createRealQueryDatabase()
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER)')
    const users = defineTable('users', { id: column.id(), name: column.string(), active: column.boolean() })
    const payload = 'Mohamed"; DROP TABLE users; --'
    const id = await DB.table(users).insertGetId({ name: payload, active: true })
    expect(await DB.table(users).where('name', payload).pluck('id')).toEqual([id])
    await expect(DB.table(users).select('name;drop' as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).where('name;drop' as never, 'Mohamed').get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).orderBy('name desc; drop' as never).get()).rejects.toThrow(SecurityError)
    expect(await DB.table(users).count()).toBe(1)
    expect(await DB.table(users).value('name')).toBe(payload)
  })


  it('keeps dialect-specific compilers aligned on shared SQL planning rules', () => {
    const postgres = new PostgresQueryCompiler(
      identifier => `"${identifier}"`,
      index => `$${index}`,
    )
    const mysql = new MySQLQueryCompiler(
      identifier => `\`${identifier}\``,
      () => '?',
    )

    expect(postgres.compile({
      kind: 'insert',
      source: { kind: 'table', tableName: 'users' },
      ignoreConflicts: false,
      values: [{ name: 'Mohamed', active: true }] })).toEqual({
      sql: 'INSERT INTO "users" ("name", "active") VALUES ($1, $2)',
      bindings: ['Mohamed', true],
      source: 'query:insert:users' })

    expect(postgres.compile({
      kind: 'upsert',
      source: { kind: 'table', tableName: 'logs' },
      values: [{ id: 1, message: 'ok' }],
      uniqueBy: ['id'],
      updateColumns: ['message'] })).toEqual({
      sql: 'INSERT INTO "logs" ("id", "message") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "message" = EXCLUDED."message"',
      bindings: [1, 'ok'],
      source: 'query:upsert:logs' })

    expect(mysql.compile({
      kind: 'update',
      source: { kind: 'table', tableName: 'users' },
      predicates: [{
        kind: 'comparison',
        column: 'id',
        operator: '=',
        value: 1 }],
      values: { active: false } })).toEqual({
      sql: 'UPDATE `users` SET `active` = ? WHERE `id` = ?',
      bindings: [false, 1],
      source: 'query:update:users' })
  })


  it('keeps binding order deterministic across repeated compilation of complex plans', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      settings: column.json<{ profile: { region: string } }>() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: { adapter: createTestAdapter(), dialect: createDatabaseDialect('postgres') } } }))

    const latestPost = DB.table(posts)
      .select('title')
      .where('posts.userId', 1)
      .where('title', 'like', 'Hello%')
      .limit(1)

    const builder = DB.table(users)
      .select('users.id')
      .addSelectSub(latestPost, 'latestTitle')
      .where('name', 'Mohamed')
      .whereJson('settings->profile->region', 'mena')
      .groupBy('users.id')
      .having('count(*)', '>=', 2)
      .orderBy('users.id')

    const first = builder.toSQL()
    const second = builder.toSQL()

    expect(first).toEqual(second)
    expect(first.bindings).toEqual([1, 'Hello%', 'Mohamed', '"mena"', 2])
  })

  it('fails closed for unsupported query dialects', async () => {
    const adapter = createTestAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: { ...createDatabaseDialect('sqlite'), name: 'oracle' } } } }))

    await expect(DB.table('users').get()).rejects.toThrow(
      'The active query compiler does not support dialect "oracle".',
    )
  })

  it('keeps the compiler fail-closed for unknown runtime plan kinds', () => {
    const compiler = new SQLiteQueryCompiler(
      identifier => `"${identifier}"`,
      index => `?${index}`,
    )

    expect(() => compiler.compile({
      kind: 'mystery',
      source: { kind: 'table', tableName: 'users' } } as never)).toThrow('Unsupported query plan kind "mystery".')
  })
})
