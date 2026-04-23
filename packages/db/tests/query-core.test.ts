import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CompilerError,
  DB,
  MySQLQueryCompiler,
  PostgresQueryCompiler,
  SQLQueryCompiler,
  SecurityError,
  SQLiteQueryCompiler,
  column,
  configureDB,
  createConnectionManager,
  createCursorPaginator,
  createPaginator,
  createSelectQueryPlan,
  createSimplePaginator,
  createTableSource,
  resetDB,
  validateQueryPlan,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult } from '../src'
import { compareChunkValuesAscending, compareChunkValuesDescending } from '../src/query/chunkOrdering'
import { defineTable } from './support/internal'
import type { QueryJsonUpdateOperation } from '../src/query/ast'

class QueryAdapter implements DriverAdapter {
  connected = false
  queryRows: Record<string, unknown>[] = [{ id: 1, name: 'Mohamed' }]
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly executions: Array<{ sql: string, bindings: readonly unknown[] }> = []

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    this.queries.push({ sql, bindings })
    return {
      rows: this.queryRows as TRow[],
      rowCount: this.queryRows.length }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })
    return {
      affectedRows: bindings.length || 1,
      lastInsertId: 9 }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

function createDialect(name: string): Dialect {
  return {
    name,
    capabilities: {
      returning: false,
      savepoints: false,
      concurrentQueries: true,
      workerThreadExecution: false,
      lockForUpdate: false,
      sharedLock: false,
      jsonValueQuery: true,
      jsonContains: false,
      jsonLength: false,
      schemaQualifiedIdentifiers: false,
      nativeUpsert: false,
      ddlAlterSupport: false,
      introspection: true },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    } }
}

function createPostgresDialect(): Dialect {
  return {
    ...createDialect('postgres'),
    capabilities: {
      ...createDialect('postgres').capabilities,
      lockForUpdate: true,
      sharedLock: true },
    createPlaceholder(index: number) {
      return `$${index}`
    } }
}

function createMySqlDialect(): Dialect {
  return {
    ...createDialect('mysql'),
    capabilities: {
      ...createDialect('mysql').capabilities,
      lockForUpdate: true,
      sharedLock: true,
      jsonContains: true,
      jsonLength: true,
      schemaQualifiedIdentifiers: true,
      nativeUpsert: true },
    quoteIdentifier(identifier: string) {
      return `\`${identifier}\``
    },
    createPlaceholder() {
      return '?'
    } }
}

class ExposedSqlCompiler extends SQLQueryCompiler {
  jsonPath(path: readonly string[]) {
    return this.createJsonPathLiteral(path)
  }

  unsupportedJsonUpdate(column: string) {
    return this.compileJsonUpdateOperations(column, [{ kind: 'json-set', path: ['a'], value: 1 }], [])
  }

  unsupportedVectorDistance() {
    return this.compileVectorDistanceExpression('embedding', [1, 2, 3], [])
  }

  unsupportedLock() {
    return this.compileLockClause('update')
  }

  havingExpression(expression: string) {
    return this.compileHavingExpression(expression)
  }

  columnReference(reference: string) {
    return this.compileColumnReference(reference)
  }

  sourceSql(source: ReturnType<typeof createTableSource>) {
    return this.compileSource(source)
  }

  joinSource(join: unknown) {
    return this.compileJoinSource(join as never, [])
  }

  predicateClause(predicates: readonly unknown[]) {
    return this.compilePredicates(predicates as never, [])
  }

  groupPredicate(predicates: readonly unknown[]) {
    return this.compilePredicate({ kind: 'group', boolean: 'and', predicates } as never, [])
  }

  prefix(predicate: unknown, compiled: string, index: number) {
    return this.prefixPredicate(predicate as never, compiled, index)
  }

  updateValue(value: unknown) {
    const bindings: unknown[] = []
    const sql = this.compileUpdateValue('meta', value, bindings)
    return { sql, bindings }
  }

  datePredicate(part: string) {
    return this.compileDatePredicate({ kind: 'date', boolean: 'and', column: 'created_at', part: part as never, operator: '=', value: 'x' }, '?1')
  }

  unsupportedJsonPredicate() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: [], jsonMode: 'value', operator: '=', value: 1 }, [])
  }
}

class ExposedSQLiteCompiler extends SQLiteQueryCompiler {
  insert(ignoreConflicts = false) {
    return this.compile({
      kind: 'insert',
      source: { kind: 'table', tableName: 'users' },
      ignoreConflicts,
      values: [{ name: 'Mohamed', active: true }] })
  }

  datePredicate(part: string) {
    return this.compileDatePredicate({ kind: 'date', boolean: 'and', column: 'created_at', part: part as never, operator: '=', value: 'x' }, '?1')
  }

  jsonValueAtRoot() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: [], jsonMode: 'value', operator: '=', value: 1 }, [])
  }

  jsonValueAtPath() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: ['enabled'], jsonMode: 'value', operator: 'like', value: 1 }, [])
  }

  jsonContainsScalarAtPath() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: ['roles'], jsonMode: 'contains', value: 'admin' }, [])
  }

  jsonContainsObjectAtPath() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: ['profile'], jsonMode: 'contains', value: { enabled: true } }, [])
  }

  jsonLengthAtPath() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: ['roles'], jsonMode: 'length', operator: '>=', value: 2 }, [])
  }

  updateValue(value: unknown) {
    const bindings: unknown[] = []
    const sql = this.compileUpdateValue('meta', value, bindings)
    return { sql, bindings }
  }

  updateValueMany(...operations: readonly QueryJsonUpdateOperation[]) {
    const bindings: unknown[] = []
    const sql = this.compileUpdateValue('meta', operations, bindings)
    return { sql, bindings }
  }

  directJsonPredicate(predicate: Record<string, unknown>) {
    return this.compileJsonPredicate(predicate as never, [])
  }
}

class ExposedPostgresCompiler extends PostgresQueryCompiler {
  datePredicate(part: string) {
    return this.compileDatePredicate({ kind: 'date', boolean: 'and', column: 'created_at', part: part as never, operator: '=', value: 'x' }, '$1')
  }

  jsonValueAtRoot() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: [], jsonMode: 'value', operator: '=', value: 1 }, [])
  }

  jsonContainsAtRoot() {
    return this.compileJsonPredicate({ kind: 'json', boolean: 'and', column: 'meta', path: [], jsonMode: 'contains', value: { a: 1 } }, [])
  }
}

class ExposedMySqlCompiler extends MySQLQueryCompiler {
  datePredicate(part: string) {
    return this.compileDatePredicate({ kind: 'date', boolean: 'and', column: 'created_at', part: part as never, operator: '=', value: 'x' }, '?')
  }
}

describe('query core slice', () => {
  beforeEach(() => {
    resetDB()
  })

  it('compiles and executes immutable select plans through the DB facade', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean() })

    const rows = await DB
      .table(users)
      .select('id', 'name')
      .where('name', 'Mohamed')
      .orderBy('id', 'desc')
      .limit(5)
      .offset(2)
      .get()

    expect(rows).toEqual([{ id: 1, name: 'Mohamed' }])
    expect(adapter.queries).toEqual([{
      sql: 'SELECT "id", "name" FROM "users" WHERE "name" = ?1 ORDER BY "id" DESC LIMIT 5 OFFSET 2',
      bindings: ['Mohamed'] }])

    expect(DB.table(users).select('id').where('name', 'Mohamed').toSQL().metadata?.debug.complexity).toBeGreaterThan(0)
  })

  it('rejects safe compiled queries that exceed the configured maximum query complexity', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite'),
          security: {
            maxQueryComplexity: 3 } } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean() })

    const simpleRows = await DB.table(users).where('id', 1).get()
    expect(simpleRows).toEqual([{ id: 1, name: 'Mohamed' }])

    await expect(
      DB.table(users)
        .select('id', 'name')
        .where('name', 'Mohamed')
        .orderBy('id', 'desc')
        .limit(5)
        .get(),
    ).rejects.toThrow(SecurityError)
  })

  it('supports toSQL, first, and find helpers', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      meta: column.json<Record<string, unknown>>().nullable() })

    const builder = DB.table(users).where('name', 'like', 'Mo%')
    expect(builder.toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" LIKE ?1',
      bindings: ['Mo%'],
      source: 'query:select:users' })
    expect(DB.table('users').toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(await builder.first()).toEqual({ id: 1, name: 'Mohamed' })
    expect(await DB.table(users).sole()).toEqual({ id: 1, name: 'Mohamed' })
    expect(await DB.table(users).valueOrFail('name')).toBe('Mohamed')
    expect(await DB.table(users).soleValue('name')).toBe('Mohamed')
    await expect(DB.table(users).soleValue('email' as never)).rejects.toThrow('Query returned no value for column "email".')

    adapter.queryRows = []
    expect(await DB.table(users).find(1)).toBeUndefined()
    await expect(DB.table(users).sole()).rejects.toThrow('Query expected exactly one row but found 0.')
    await expect(DB.table(users).valueOrFail('name')).rejects.toThrow('Query returned no value for column "name".')
    expect(adapter.queries).toContainEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = ?1 LIMIT 1',
      bindings: [1] })

    expect(DB.table(users).whereNull('id').whereNotNull('name').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" IS NULL AND "name" IS NOT NULL',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).whereJson('meta', '=', 'Mohamed').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE json_extract("meta", \'$\') = ?1',
      bindings: ['Mohamed'],
      source: 'query:select:users' })
    expect(DB.table(users).whereJson('meta->enabled', 'like', 'yes').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE json_extract("meta", \'$.enabled\') LIKE ?1',
      bindings: ['yes'],
      source: 'query:select:users' })
    expect(() => DB.table(users).whereJson('meta->>name', '=', 'Mohamed')).toThrow('Use portable JSON path syntax')

    adapter.queryRows = [{ id: 1, name: 'Mohamed' }, { id: 2, name: 'Amina' }]
    await expect(DB.table(users).sole()).rejects.toThrow('Query expected exactly one row but found 2.')
  })

  it('treats empty grouped callbacks as no-ops on table builders and compiles grouped OR clauses', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    expect(DB.table(users).where(() => undefined).orWhere(() => undefined).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).where('id', 1).orWhere('name', 'B').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = ?1 OR "name" = ?2',
      bindings: [1, 'B'],
      source: 'query:select:users' })

    expect(DB.table(users)
      .where(query => query.where('name', 'A').orWhere('name', 'B'))
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("name" = ?1 OR "name" = ?2)',
      bindings: ['A', 'B'],
      source: 'query:select:users' })

    expect(DB.table('users')
      .where(query => query.where('name', 'A'))
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("name" = ?1)',
      bindings: ['A'],
      source: 'query:select:users' })
  })

  it('exposes redacted debug helpers on table queries', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite'),
          security: {
            redactBindingsInLogs: true } } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    expect(DB.table(users).where('name', 'Mohamed').debug()).toMatchObject({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1',
      bindings: ['[REDACTED]'],
      source: 'query:select:users',
      connectionName: 'default',
      scope: 'root',
      schedulingMode: 'concurrent',
      metadata: {
        kind: 'select',
        resultMode: 'rows',
        selectedShape: {
          mode: 'all',
          columns: [],
          aggregates: [],
          hasRawSelections: false,
          hasSubqueries: false },
        safety: {
          unsafe: false,
          containsRawSql: false },
        debug: {
          tableName: 'users',
          hasJoins: false,
          hasUnions: false,
          hasGrouping: false,
          hasHaving: false,
          complexity: 2,
          intent: 'read',
          transactionAffinity: 'optional',
          streaming: 'buffered',
          connectionName: 'default',
          scope: 'root',
          schedulingMode: 'concurrent' } } })
    expect(DB.table(users).debug()).toMatchObject({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users',
      connectionName: 'default',
      scope: 'root',
      schedulingMode: 'concurrent',
      metadata: {
        kind: 'select',
        resultMode: 'rows',
        selectedShape: {
          mode: 'all',
          columns: [],
          aggregates: [],
          hasRawSelections: false,
          hasSubqueries: false },
        safety: {
          unsafe: false,
          containsRawSql: false },
        debug: {
          tableName: 'users',
          hasJoins: false,
          hasUnions: false,
          hasGrouping: false,
          hasHaving: false,
          complexity: 1,
          intent: 'read',
          transactionAffinity: 'optional',
          streaming: 'buffered',
          connectionName: 'default',
          scope: 'root',
          schedulingMode: 'concurrent' } } })

    const rawBuilder = DB.table(users)
    rawBuilder.toSQL = () => ({
      sql: 'SELECT * FROM "users"',
      bindings: undefined as unknown as unknown[],
      source: 'query:select:users' })
    expect(rawBuilder.debug()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users',
      connectionName: 'default',
      scope: 'root',
      schedulingMode: 'concurrent',
      metadata: undefined })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const builder = DB.table(users).where('name', 'Mohamed')
    expect(builder.dump()).toBe(builder)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1',
      bindings: ['[REDACTED]'],
      source: 'query:select:users',
      connectionName: 'default',
      scope: 'root',
      schedulingMode: 'concurrent',
      metadata: {
        kind: 'select',
        resultMode: 'rows',
        selectedShape: {
          mode: 'all',
          columns: [],
          aggregates: [],
          hasRawSelections: false,
          hasSubqueries: false },
        safety: {
          unsafe: false,
          containsRawSql: false },
        debug: {
          tableName: 'users',
          hasJoins: false,
          hasUnions: false,
          hasGrouping: false,
          hasHaving: false,
          complexity: 2,
          intent: 'read',
          transactionAffinity: 'optional',
          streaming: 'buffered',
          connectionName: 'default',
          scope: 'root',
          schedulingMode: 'concurrent' } } }))
    expect(DB.table(users).select('id').toSQL().metadata).toMatchObject({
      kind: 'select',
      resultMode: 'rows',
      selectedShape: {
        mode: 'projection',
        columns: ['id'],
        aggregates: [],
        hasRawSelections: false,
        hasSubqueries: false },
      safety: {
        unsafe: false,
        containsRawSql: false },
      debug: {
        tableName: 'users',
        hasJoins: false,
        hasUnions: false,
        hasGrouping: false,
        hasHaving: false,
        complexity: 2,
        intent: 'read',
        transactionAffinity: 'optional',
        streaming: 'buffered' } })
    expect(DB.table(users).unsafeSelect('COUNT(*) AS total', []).toSQL().metadata).toMatchObject({
      kind: 'select',
      resultMode: 'rows',
      selectedShape: {
        mode: 'projection',
        columns: [],
        aggregates: [],
        hasRawSelections: true,
        hasSubqueries: false },
      safety: {
        unsafe: true,
        containsRawSql: true },
      debug: {
        tableName: 'users',
        hasJoins: false,
        hasUnions: false,
        hasGrouping: false,
        hasHaving: false,
        complexity: 3,
        intent: 'read',
        transactionAffinity: 'optional',
        streaming: 'buffered' } })
  })

  it('supports conditional and ordering helper ergonomics on table queries', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp() })

    expect(DB.table(users)
      .when(true, query => query.where('name', 'Mohamed'))
      .unless(true, query => query.where('id', 99), query => query.where('id', 1))
      .latest()
      .reorder('name')
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1 AND "id" = ?2 ORDER BY "name" ASC',
      bindings: ['Mohamed', 1],
      source: 'query:select:users' })

    expect(DB.table(users).oldest().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "created_at" ASC',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).inRandomOrder().toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY RANDOM()',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).unless(false, query => query.where('id', 1)).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = ?1',
      bindings: [1],
      source: 'query:select:users' })

    expect(DB.table(users).when(true, () => {}).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).when(false, query => query.where('id', 1)).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).when(false, query => query.where('id', 1), () => {}).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).when(false, query => query.where('id', 1), query => query.where('name', 'fallback')).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1',
      bindings: ['fallback'],
      source: 'query:select:users' })

    expect(DB.table(users).unless(false, () => {}).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).unless(true, query => query.where('id', 1)).toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).orderBy('id', 'desc').reorder().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).where('name', 'Mohamed').orWhere('id', 2).orWhereNull('created_at').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1 OR "id" = ?2 OR "created_at" IS NULL',
      bindings: ['Mohamed', 2],
      source: 'query:select:users' })

    expect(DB.table(users)
      .where(query => query.where('name', 'Mohamed').orWhere('id', 2))
      .whereNotNull('created_at')
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("name" = ?1 OR "id" = ?2) AND "created_at" IS NOT NULL',
      bindings: ['Mohamed', 2],
      source: 'query:select:users' })

    expect(DB.table(users)
      .whereNot(query => query.where('name', 'Mohamed').orWhere('id', 2))
      .orWhereNot(query => query.whereNull('created_at'))
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE NOT ("name" = ?1 OR "id" = ?2) OR NOT ("created_at" IS NULL)',
      bindings: ['Mohamed', 2],
      source: 'query:select:users' })

    expect(DB.table(users).whereLike('name', 'Mo%').orWhereLike('name', 'Am%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" LIKE ?1 OR "name" LIKE ?2',
      bindings: ['Mo%', 'Am%'],
      source: 'query:select:users' })

    expect(DB.table(users).whereAny(['name', 'created_at'], 'like', 'Mo%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("name" LIKE ?1 OR "created_at" LIKE ?2)',
      bindings: ['Mo%', 'Mo%'],
      source: 'query:select:users' })

    expect(DB.table(users).whereAll(['name', 'created_at'], 'like', 'Mo%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("name" LIKE ?1 AND "created_at" LIKE ?2)',
      bindings: ['Mo%', 'Mo%'],
      source: 'query:select:users' })

    expect(DB.table(users).whereNone(['name', 'created_at'], 'like', 'Mo%').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE NOT ("name" LIKE ?1 OR "created_at" LIKE ?2)',
      bindings: ['Mo%', 'Mo%'],
      source: 'query:select:users' })

    expect(DB.table(users)
      .select('name')
      .groupBy('name')
      .having('count(*)', '>=', 2)
      .havingBetween('count(*)', [2, 5])
      .toSQL()).toEqual({
      sql: 'SELECT "name" FROM "users" GROUP BY "name" HAVING COUNT(*) >= ?1 AND COUNT(*) BETWEEN ?2 AND ?3',
      bindings: [2, 2, 5],
      source: 'query:select:users' })

    expect(DB.table(users)
      .select('name')
      .groupBy('name')
      .having('count(*)', 2)
      .toSQL()).toEqual({
      sql: 'SELECT "name" FROM "users" GROUP BY "name" HAVING COUNT(*) = ?1',
      bindings: [2],
      source: 'query:select:users' })

    expect(DB.table(users).whereDate('created_at', '2025-01-01').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE date("created_at") = ?1',
      bindings: ['2025-01-01'],
      source: 'query:select:users' })

    expect(DB.table(users).select('id').addSelect('name').toSQL()).toEqual({
      sql: 'SELECT "id", "name" FROM "users"',
      bindings: [],
      source: 'query:select:users' })
  })

  it('supports string-source primary-key fallback for chunk helpers', async () => {
    const adapter = new QueryAdapter()
    adapter.queryRows = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const seen: number[] = []
    await DB.table('users').chunkById(10, (rows) => {
      seen.push(...rows.map(row => Number(row.id)))
    })
    expect(seen).toEqual([1, 2])
  })

  it('supports distinct, column-comparison, range, set, and insert-get-id helpers', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
      minScore: column.integer(),
      maxScore: column.integer(),
      active: column.boolean() })

    expect(DB.table(users)
      .distinct()
      .select('name')
      .whereColumn('minScore', '<=', 'maxScore')
      .whereIn('id', [1, 2])
      .whereNotIn('score', [7, 8])
      .whereBetween('score', [10, 20])
      .whereNotBetween('id', [30, 40])
      .orderBy('name')
      .toSQL()).toEqual({
      sql: 'SELECT DISTINCT "name" FROM "users" WHERE "minScore" <= "maxScore" AND "id" IN (?1, ?2) AND "score" NOT IN (?3, ?4) AND "score" BETWEEN ?5 AND ?6 AND "id" NOT BETWEEN ?7 AND ?8 ORDER BY "name" ASC',
      bindings: [1, 2, 7, 8, 10, 20, 30, 40],
      source: 'query:select:users' })

    await DB.table(users)
      .whereIn('id', [1, 2, 3])
      .whereNotBetween('score', [5, 9])
      .get()
    expect(adapter.queries.at(-1)).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" IN (?1, ?2, ?3) AND "score" NOT BETWEEN ?4 AND ?5',
      bindings: [1, 2, 3, 5, 9] })

    expect(await DB.table(users).insertGetId({
      name: 'Amina',
      score: 12,
      minScore: 1,
      maxScore: 20,
      active: true })).toBe(9)
  })

  it('compiles insertOrIgnore per dialect', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const sqliteAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: sqliteAdapter,
          dialect: createDialect('sqlite') } } }))

    await DB.table(users).insertOrIgnore({ id: 1, name: 'Mohamed' })
    expect(sqliteAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT OR IGNORE INTO "users" ("id", "name") VALUES (?1, ?2)',
      bindings: [1, 'Mohamed'] })

    await DB.table(users).insertOrIgnore([
      { id: 2, name: 'Amina' },
      { id: 3, name: 'Salma' },
    ])
    expect(sqliteAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT OR IGNORE INTO "users" ("id", "name") VALUES (?1, ?2), (?3, ?4)',
      bindings: [2, 'Amina', 3, 'Salma'] })

    const postgresAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: postgresAdapter,
          dialect: createPostgresDialect() } } }))

    await DB.table(users).insertOrIgnore({ id: 1, name: 'Mohamed' })
    expect(postgresAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "users" ("id", "name") VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING "id"',
      bindings: [1, 'Mohamed'] })
    await expect(DB.table(users).insertGetId({ id: 2, name: 'Amina' })).resolves.toBe(9)
    expect(postgresAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "users" ("id", "name") VALUES ($1, $2) RETURNING "id"',
      bindings: [2, 'Amina'] })

    const mysqlAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: mysqlAdapter,
          dialect: createMySqlDialect() } } }))

    await DB.table(users).insertOrIgnore({ id: 1, name: 'Mohamed' })
    expect(mysqlAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT IGNORE INTO `users` (`id`, `name`) VALUES (?, ?)',
      bindings: [1, 'Mohamed'] })
    await expect(DB.table(users).insertGetId({ id: 2, name: 'Amina' })).resolves.toBe(9)
    expect(mysqlAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO `users` (`id`, `name`) VALUES (?, ?)',
      bindings: [2, 'Amina'] })
  })

  it('compiles upsert per dialect and fails closed for invalid rows', async () => {
    const users = defineTable('users', {
      id: column.id(),
      email: column.string(),
      name: column.string() })

    const sqliteAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: sqliteAdapter,
          dialect: createDialect('sqlite') } } }))

    await DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, ['email'], ['name'])
    expect(sqliteAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "users" ("id", "email", "name") VALUES (?1, ?2, ?3) ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"',
      bindings: [1, 'm@example.com', 'Mohamed'] })

    const postgresAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: postgresAdapter,
          dialect: createPostgresDialect() } } }))

    await DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, ['email'], [])
    expect(postgresAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "users" ("id", "email", "name") VALUES ($1, $2, $3) ON CONFLICT ("email") DO NOTHING RETURNING "id"',
      bindings: [1, 'm@example.com', 'Mohamed'] })

    const mysqlAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: mysqlAdapter,
          dialect: createMySqlDialect() } } }))

    await DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, ['email'], ['name'])
    expect(mysqlAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO `users` (`id`, `email`, `name`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)',
      bindings: [1, 'm@example.com', 'Mohamed'] })

    await DB.table(users).upsert({ id: 2, email: 'a@example.com', name: 'Amina' }, ['email'], [])
    expect(mysqlAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO `users` (`id`, `email`, `name`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `email` = VALUES(`email`)',
      bindings: [2, 'a@example.com', 'Amina'] })

    await expect(DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, [], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, ['missing'], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert([{ id: 1, email: 'm@example.com', name: 'Mohamed' }, { id: 2, email: 'a@example.com' } as never], ['email'], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert([{ id: 1, email: 'm@example.com', name: 'Mohamed' }, { id: 2, email: 'a@example.com', name: undefined as never }], ['email'], ['name'])).rejects.toThrow(SecurityError)
    await expect(DB.table(users).upsert({ id: 1, email: 'm@example.com', name: 'Mohamed' }, ['email'], ['missing'])).rejects.toThrow(SecurityError)
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

  it('covers low-level compiler fallback and dialect helper branches directly', () => {
    const base = new ExposedSqlCompiler(
      identifier => `"${identifier}"`,
      index => `?${index}`,
    )
    const sqlite = new ExposedSQLiteCompiler(
      identifier => `"${identifier}"`,
      index => `?${index}`,
    )
    const postgres = new ExposedPostgresCompiler(
      identifier => `"${identifier}"`,
      index => `$${index}`,
    )
    const mysql = new ExposedMySqlCompiler(
      identifier => `\`${identifier}\``,
      () => '?',
    )

    expect(base.jsonPath(['meta', 'odd-key', 'quote"value'])).toContain('odd-key')
    expect(base.jsonPath(['meta', 'quote"value'])).toContain('\\"')
    expect(() => base.unsupportedJsonUpdate('meta')).toThrow('does not implement JSON update compilation')
    expect(() => base.unsupportedJsonPredicate()).toThrow('does not implement JSON predicate compilation')
    expect(() => base.unsupportedVectorDistance()).toThrow('does not support vector similarity clauses')
    expect(() => base.unsupportedLock()).toThrow('does not support pessimistic lock clauses')
    expect(base.datePredicate('date')).toBe('DATE("created_at") = ?1')
    expect(base.datePredicate('month')).toBe('EXTRACT(MONTH FROM "created_at") = ?1')
    expect(base.datePredicate('day')).toBe('EXTRACT(DAY FROM "created_at") = ?1')
    expect(base.datePredicate('year')).toBe('EXTRACT(YEAR FROM "created_at") = ?1')
    expect(base.datePredicate('time')).toBe('TIME("created_at") = ?1')
    expect(base.havingExpression('sum(score)')).toBe('SUM("score")')
    expect(base.havingExpression('name')).toBe('"name"')
    expect(base.columnReference('users.name')).toBe('"users"."name"')
    expect(base.sourceSql(createTableSource('users as u'))).toBe('"users" AS "u"')
    expect(base.joinSource({ table: 'users' })).toBe('"users"')
    expect(base.predicateClause([
      { kind: 'comparison', boolean: 'and', column: 'name', operator: '=', value: 'A' },
      { kind: 'comparison', boolean: 'or', column: 'name', operator: '=', value: 'B' },
    ])).toContain('OR "name" = ?2')
    expect(base.groupPredicate([
      { kind: 'comparison', boolean: 'and', column: 'name', operator: '=', value: 'A' },
      { kind: 'comparison', boolean: 'or', column: 'name', operator: '=', value: 'B' },
    ])).toContain('OR "name" = ?2')
    expect(base.prefix({ kind: 'comparison', column: 'name', operator: '=', value: 'B' }, '"name" = ?1', 1)).toBe('AND "name" = ?1')
    expect(base.prefix({ kind: 'comparison', boolean: 'or', column: 'name', operator: '=', value: 'B' }, '"name" = ?1', 1)).toBe('OR "name" = ?1')
    expect(base.joinSource({ subquery: createSelectQueryPlan(createTableSource('users')), alias: 'sub' })).toContain('AS "sub"')
    expect(() => base.joinSource({ subquery: createSelectQueryPlan(createTableSource('users')), alias: 'sub', lateral: true })).toThrow(
      'does not support lateral joins',
    )
    expect(sqlite.updateValue({ kind: 'json-set', path: ['enabled'], value: true })).toEqual({
      sql: `json_set(COALESCE("meta", json('{}')), '$.enabled', json(?1))`,
      bindings: ['true'] })
    expect(sqlite.updateValueMany(
      { kind: 'json-set', path: ['profile', 'region'], value: 'eu' },
      { kind: 'json-set', path: ['flags', 'beta'], value: true },
    )).toEqual({
      sql: `json_set(json_set(COALESCE("meta", json('{}')), '$.profile.region', json(?1)), '$.flags.beta', json(?2))`,
      bindings: ['"eu"', 'true'] })
    expect(sqlite.insert()).toEqual({
      sql: 'INSERT INTO "users" ("name", "active") VALUES (?1, ?2)',
      bindings: ['Mohamed', true],
      source: 'query:insert:users' })
    expect(sqlite.insert(true)).toEqual({
      sql: 'INSERT OR IGNORE INTO "users" ("name", "active") VALUES (?1, ?2)',
      bindings: ['Mohamed', true],
      source: 'query:insert:users' })

    expect(sqlite.datePredicate('date')).toBe('date("created_at") = ?1')
    expect(sqlite.datePredicate('time')).toBe('time("created_at") = ?1')
    expect(sqlite.datePredicate('year')).toBe(`strftime('%Y', "created_at") = ?1`)
    expect(sqlite.datePredicate('month')).toBe(`strftime('%m', "created_at") = ?1`)
    expect(sqlite.datePredicate('day')).toBe(`strftime('%d', "created_at") = ?1`)
    expect(sqlite.jsonValueAtRoot()).toBe(`json_extract("meta", '$') = ?1`)
    expect(sqlite.directJsonPredicate({
      kind: 'json',
      boolean: 'and',
      column: 'meta',
      path: [],
      jsonMode: 'value',
      operator: '=',
      value: 1 })).toBe(`json_extract("meta", '$') = ?1`)
    expect(sqlite.jsonValueAtRoot()).toContain(`json_extract("meta", '$') = ?1`)
    expect(sqlite.jsonValueAtPath()).toContain(`json_extract("meta", '$.enabled') LIKE ?1`)
    expect(sqlite.jsonContainsScalarAtPath()).toContain(`EXISTS (SELECT 1 FROM json_each(json_extract("meta", '$.roles')) WHERE value = ?1)`)
    expect(sqlite.jsonContainsObjectAtPath()).toContain(`json_extract("meta", '$.profile') = json(?1)`)
    expect(sqlite.jsonLengthAtPath()).toContain(`json_array_length(json_extract("meta", '$.roles')) >= ?1`)
    expect(() => sqlite.datePredicate('unknown')).toThrow('Unsupported date predicate part')
    expect(new SQLiteQueryCompiler(identifier => `"${identifier}"`, index => `?${index}`).compile({
      kind: 'select',
      source: createTableSource(defineTable('users', { meta: column.json<Record<string, unknown>>() })),
      distinct: false,
      selections: [],
      joins: [],
      unions: [],
      predicates: [{ kind: 'json', column: 'meta', path: [], jsonMode: 'value', operator: '=', value: 'x' }],
      groupBy: [],
      having: [],
      orderBy: [] } as never).sql).toContain('json_extract("meta", \'$\') = ?1')

    expect(postgres.datePredicate('date')).toBe('CAST("created_at" AS DATE) = $1')
    expect(postgres.datePredicate('time')).toBe('CAST("created_at" AS TIME) = $1')
    expect(postgres.datePredicate('year')).toContain('EXTRACT(YEAR')
    expect(postgres.datePredicate('month')).toContain('EXTRACT(MONTH')
    expect(postgres.datePredicate('day')).toContain('EXTRACT(DAY')
    expect(() => postgres.datePredicate('unknown')).toThrow('Unsupported date predicate part')
    expect(postgres.jsonValueAtRoot()).toContain(`#>> '{}'`)
    expect(postgres.jsonContainsAtRoot()).toContain('::jsonb')

    expect(mysql.datePredicate('date')).toBe('DATE(`created_at`) = ?')
    expect(mysql.datePredicate('time')).toBe('TIME(`created_at`) = ?')
    expect(mysql.datePredicate('year')).toContain('EXTRACT(YEAR')
    expect(mysql.datePredicate('month')).toContain('EXTRACT(MONTH')
    expect(mysql.datePredicate('day')).toContain('EXTRACT(DAY')
    expect(() => mysql.datePredicate('unknown')).toThrow('Unsupported date predicate part')
  })

  it('covers chunk ordering helpers directly', () => {
    expect(compareChunkValuesAscending(1, 1)).toBe(0)
    expect(compareChunkValuesAscending(undefined, 1)).toBe(-1)
    expect(compareChunkValuesAscending(1, undefined)).toBe(1)
    expect(compareChunkValuesAscending(1, 2)).toBe(-1)
    expect(compareChunkValuesAscending(2, 1)).toBe(1)

    expect(compareChunkValuesDescending(1, 1)).toBe(0)
    expect(compareChunkValuesDescending(undefined, 1)).toBe(1)
    expect(compareChunkValuesDescending(1, undefined)).toBe(-1)
    expect(compareChunkValuesDescending(1, 2)).toBe(1)
    expect(compareChunkValuesDescending(2, 1)).toBe(-1)
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

  it('supports increment and decrement with extra payloads', async () => {
    const adapter = new QueryAdapter()
    adapter.queryRows = [
      { id: 1, score: 10 },
      { id: 2, score: 20 },
    ]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
      active: column.boolean() })

    const incremented = await DB.table(users).where('active', true).increment('score', 2, { name: 'Boosted' })
    expect(incremented.affectedRows).toBe(8)
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "users" SET "name" = ?1, "score" = ?2 WHERE "active" = ?3 AND "id" = ?4',
        bindings: ['Boosted', 12, 1, 1] },
      {
        sql: 'UPDATE "users" SET "name" = ?1, "score" = ?2 WHERE "active" = ?3 AND "id" = ?4',
        bindings: ['Boosted', 22, 1, 2] },
    ])

    adapter.executions.length = 0
    adapter.queryRows = [{ id: 1, score: 9 }]

    const decremented = await DB.table(users).where('id', 1).decrement('score', 4, { name: 'Lowered' })
    expect(decremented.affectedRows).toBe(4)
    expect(adapter.executions).toEqual([{
      sql: 'UPDATE "users" SET "name" = ?1, "score" = ?2 WHERE "id" = ?3 AND "id" = ?4',
      bindings: ['Lowered', 5, 1, 1] }])

    adapter.queryRows = [{ id: 1, score: 'bad' as never }]
    await expect(DB.table(users).increment('score', 1)).rejects.toThrow(CompilerError)
    await expect(DB.table(users).increment('score', Number.NaN)).rejects.toThrow(SecurityError)

    adapter.executions.length = 0
    adapter.queryRows = [{ id: 3, score: 15 }]

    const incrementedFromStringTable = await DB.table('users').where('id', 3).increment('score', 5)
    expect(incrementedFromStringTable.affectedRows).toBe(3)
    expect(adapter.executions).toEqual([{
      sql: 'UPDATE "users" SET "score" = ?1 WHERE "id" = ?2 AND "id" = ?3',
      bindings: [20, 3, 3],
    }])
  })

  it('falls back for numeric adjustments when the driver omits affected row counts', async () => {
    class SparseExecutionAdapter extends QueryAdapter {
      override async execute(sql: string, bindings: readonly unknown[] = []): Promise<DriverExecutionResult> {
        this.executions.push({ sql, bindings })
        return { lastInsertId: 99 }
      }
    }

    const adapter = new SparseExecutionAdapter()
    adapter.queryRows = [{ id: 1, score: 10 }]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      slug: column.string() })

    expect((DB.table(users) as unknown as { resolvePrimaryKeyColumn(): string }).resolvePrimaryKeyColumn()).toBe('id')
  })

  it('falls back to zero affected rows for numeric adjustments when the driver omits counters', async () => {
    class SparseExecutionAdapter extends QueryAdapter {
      override async execute(sql: string, bindings: readonly unknown[] = []): Promise<DriverExecutionResult> {
        this.executions.push({ sql, bindings })
        return { lastInsertId: 99 }
      }
    }

    const adapter = new SparseExecutionAdapter()
    adapter.queryRows = [{ id: 1, score: 10 }]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      score: column.integer() })

    const result = await DB.table(users).increment('score', 1)
    expect(result).toEqual({ affectedRows: 0, lastInsertId: 99 })
  })

  it('compiles date-part helpers per dialect', () => {
    const users = defineTable('users', {
      id: column.id(),
      created_at: column.timestamp() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    expect(DB.table(users)
      .whereDate('created_at', '2026-03-25')
      .whereMonth('created_at', 3)
      .whereDay('created_at', 25)
      .whereYear('created_at', 2026)
      .whereTime('created_at', '10:30:00')
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE date("created_at") = ?1 AND strftime('%m', "created_at") = ?2 AND strftime('%d', "created_at") = ?3 AND strftime('%Y', "created_at") = ?4 AND time("created_at") = ?5`,
      bindings: ['2026-03-25', 3, 25, 2026, '10:30:00'],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createPostgresDialect() } } }))

    expect(DB.table(users).whereYear('created_at', 2026).whereDate('created_at', '2026-03-25').toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE EXTRACT(YEAR FROM "created_at") = $1 AND CAST("created_at" AS DATE) = $2',
      bindings: [2026, '2026-03-25'],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createMySqlDialect() } } }))

    expect(DB.table(users).whereMonth('created_at', 3).whereTime('created_at', '10:30:00').toSQL()).toEqual({
      sql: 'SELECT * FROM `users` WHERE EXTRACT(MONTH FROM `created_at`) = ? AND TIME(`created_at`) = ?',
      bindings: [3, '10:30:00'],
      source: 'query:select:users' })

    expect(DB.table(users).inRandomOrder().toSQL()).toEqual({
      sql: 'SELECT * FROM `users` ORDER BY RAND()',
      bindings: [],
      source: 'query:select:users' })
  })

  it('compiles pessimistic lock clauses per dialect and degrades SQLite locks to plain selects', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createPostgresDialect() } } }))

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
          adapter: new QueryAdapter(),
          dialect: createMySqlDialect() } } }))

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
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    expect(DB.table(users).lockForUpdate().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
    expect(DB.table(users).sharedLock().toSQL()).toEqual({
      sql: 'SELECT * FROM "users"',
      bindings: [],
      source: 'query:select:users' })
  })

  it('compiles EXISTS and NOT EXISTS subqueries', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string(),
      userId: column.integer() })

    const subquery = DB.table(posts).select('id').where('userId', 1)

    expect(DB.table(users).whereExists(subquery).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE EXISTS (SELECT "id" FROM "posts" WHERE "userId" = ?1)',
      bindings: [1],
      source: 'query:select:users' })

    expect(DB.table(users).whereNotExists(subquery).orWhereExists(DB.table(posts).where('title', 'like', 'Hello%')).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE NOT EXISTS (SELECT "id" FROM "posts" WHERE "userId" = ?1) OR EXISTS (SELECT * FROM "posts" WHERE "title" LIKE ?2)',
      bindings: [1, 'Hello%'],
      source: 'query:select:users' })
  })

  it('compiles scalar and set subquery predicates', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      score: column.integer(),
      status: column.string() })
    const scores = defineTable('scores', {
      id: column.id(),
      userId: column.integer(),
      amount: column.integer() })

    const scalarSubquery = DB.table(scores).select('amount').where('userId', 1).limit(1)
    const setSubquery = DB.table(scores).select('userId').where('amount', '>', 10)

    expect(DB.table(users).whereSub('score', '>=', scalarSubquery).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "score" >= (SELECT "amount" FROM "scores" WHERE "userId" = ?1 LIMIT 1)',
      bindings: [1],
      source: 'query:select:users' })

    expect(DB.table(users).whereInSub('id', setSubquery).orWhereSub('status', '=', DB.table(scores).select('amount').where('id', 1).limit(1)).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" IN (SELECT "userId" FROM "scores" WHERE "amount" > ?1) OR "status" = (SELECT "amount" FROM "scores" WHERE "id" = ?2 LIMIT 1)',
      bindings: [10, 1],
      source: 'query:select:users' })
  })

  it('compiles inner, left, right, and cross joins through the safe compiler path', async () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    expect(DB.table(users)
      .join('posts', 'users.id', '=', 'posts.userId')
      .leftJoin('profiles', 'profiles.userId', '=', 'users.id')
      .where('users.id', 1)
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" INNER JOIN "posts" ON "users"."id" = "posts"."userId" LEFT JOIN "profiles" ON "profiles"."userId" = "users"."id" WHERE "users"."id" = ?1',
      bindings: [1],
      source: 'query:select:users' })

    expect(DB.table(users)
      .rightJoin('teams', 'teams.ownerId', '=', 'users.id')
      .crossJoin('countries')
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" RIGHT JOIN "teams" ON "teams"."ownerId" = "users"."id" CROSS JOIN "countries"',
      bindings: [],
      source: 'query:select:users' })

    await expect(
      DB.table(users).join('bad table' as never, 'users.id', '=', 'posts.userId').get(),
    ).rejects.toThrow(SecurityError)
    await expect(
      DB.table(users).join('posts', 'users.id', 'in' as never, 'posts.userId').get(),
    ).rejects.toThrow(SecurityError)
    await expect(
      DB.table(users).join('posts', 'users.id;', '=', 'posts.userId').get(),
    ).rejects.toThrow(SecurityError)
  })

  it('compiles union and union all queries through the safe compiler path', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string() })

    const activeUsers = DB.table(users).where('status', 'active').select('id', 'name')
    const inactiveUsers = DB.table(users).where('status', 'inactive').select('id', 'name')
    const archivedUsers = DB.table(users).where('status', 'archived').select('id', 'name')

    expect(activeUsers.union(inactiveUsers).toSQL()).toEqual({
      sql: 'SELECT "id", "name" FROM "users" WHERE "status" = ?1 UNION SELECT "id", "name" FROM "users" WHERE "status" = ?2',
      bindings: ['active', 'inactive'],
      source: 'query:select:users' })

    expect(activeUsers
      .unionAll(archivedUsers)
      .orderBy('name')
      .limit(10)
      .toSQL()).toEqual({
      sql: 'SELECT "id", "name" FROM "users" WHERE "status" = ?1 UNION ALL SELECT "id", "name" FROM "users" WHERE "status" = ?2 ORDER BY "name" ASC LIMIT 10',
      bindings: ['active', 'archived'],
      source: 'query:select:users' })
  })

  it('compiles subquery joins and rejects missing aliases', async () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    const recentPosts = DB.table(posts).select('userId').where('title', 'like', 'Hello%')

    expect(DB.table(users)
      .joinSub(recentPosts, 'recent_posts', 'recent_posts.userId', '=', 'users.id')
      .leftJoinSub(DB.table(posts).select('userId').where('title', 'like', 'World%'), 'world_posts', 'world_posts.userId', '=', 'users.id')
      .toSQL()).toEqual({
      sql: 'SELECT * FROM "users" INNER JOIN (SELECT "userId" FROM "posts" WHERE "title" LIKE ?1) AS "recent_posts" ON "recent_posts"."userId" = "users"."id" LEFT JOIN (SELECT "userId" FROM "posts" WHERE "title" LIKE ?2) AS "world_posts" ON "world_posts"."userId" = "users"."id"',
      bindings: ['Hello%', 'World%'],
      source: 'query:select:users' })

    await expect(
      DB.table(users).joinSub(recentPosts, '' as never, 'recent_posts.userId', '=', 'users.id').get(),
    ).rejects.toThrow(SecurityError)
  })

  it('compiles safe select aliases and rejects malformed aliases', async () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string() })

    expect(DB.table(users).select('name as displayName', 'status').toSQL()).toEqual({
      sql: 'SELECT "name" AS "displayName", "status" FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    expect(DB.table(users).select('users.name as displayName').toSQL()).toEqual({
      sql: 'SELECT "users"."name" AS "displayName" FROM "users"',
      bindings: [],
      source: 'query:select:users' })

    await expect(
      DB.table(users).select('name as bad alias' as never).get(),
    ).rejects.toThrow(SecurityError)
  })

  it('supports aliased sources through DB.table(...) and from(...)', async () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    expect(DB.table('users as u').where('u.id', 1).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" AS "u" WHERE "u"."id" = ?1',
      bindings: [1],
      source: 'query:select:users' })

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    expect(DB.table(users).from('users as u').select('u.name as displayName').toSQL()).toEqual({
      sql: 'SELECT "u"."name" AS "displayName" FROM "users" AS "u"',
      bindings: [],
      source: 'query:select:users' })

    await expect(
      DB.table('users as bad alias').get(),
    ).rejects.toThrow(SecurityError)
  })

  it('compiles subquery selections safely', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string() })

    const latestPost = DB.table(posts).select('title').where('userId', 1).limit(1)

    expect(DB.table(users).selectSub(latestPost, 'latestTitle').toSQL()).toEqual({
      sql: 'SELECT (SELECT "title" FROM "posts" WHERE "userId" = ?1 LIMIT 1) AS "latestTitle" FROM "users"',
      bindings: [1],
      source: 'query:select:users' })

    expect(DB.table(users).select('name').addSelectSub(latestPost, 'latestTitle').toSQL()).toEqual({
      sql: 'SELECT "name", (SELECT "title" FROM "posts" WHERE "userId" = ?1 LIMIT 1) AS "latestTitle" FROM "users"',
      bindings: [1],
      source: 'query:select:users' })
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
          adapter: new QueryAdapter(),
          dialect: createPostgresDialect() } } }))

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
          adapter: new QueryAdapter(),
          dialect: createMySqlDialect() } } }))

    expect(DB.table(users).joinLateral(lateralSubquery, 'latest_post').toSQL()).toEqual({
      sql: 'SELECT * FROM `users` INNER JOIN LATERAL (SELECT `title` FROM `posts` WHERE `posts`.`userId` = `users`.`id` LIMIT 1) `latest_post` ON TRUE',
      bindings: [],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

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
          adapter: new QueryAdapter(),
          dialect: createPostgresDialect() } } }))

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
          adapter: new QueryAdapter(),
          dialect: createMySqlDialect() } } }))

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
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

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
          adapter: new QueryAdapter(),
          dialect: createPostgresDialect() } } }))

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
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    expect(() => DB.table(documents).whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.4).toSQL()).toThrow(CompilerError)

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createMySqlDialect() } } }))

    expect(() => DB.table(documents).whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.4).toSQL()).toThrow(CompilerError)
  })

  it('compiles JSON helpers per dialect and rejects malformed JSON paths', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      settings: column.json() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

    expect(DB.table(users)
      .whereJson('settings->profile->region', 'eu')
      .whereJsonContains('settings->tags', 'beta')
      .whereJsonLength('settings->tags', '>=', 2)
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE json_extract("settings", '$.profile.region') = ?1 AND EXISTS (SELECT 1 FROM json_each(json_extract("settings", '$.tags')) WHERE value = ?2) AND json_array_length(json_extract("settings", '$.tags')) >= ?3`,
      bindings: ['eu', 'beta', 2],
      source: 'query:select:users' })

    expect(DB.table(users)
      .where('settings->profile->region', 'eu')
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE json_extract("settings", '$.profile.region') = ?1`,
      bindings: ['eu'],
      source: 'query:select:users' })

    expect(DB.table(users)
      .whereJsonContains('settings', { region: 'eu' })
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE json_extract("settings", '$') = json(?1)`,
      bindings: ['{"region":"eu"}'],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createPostgresDialect() } } }))

    expect(DB.table(users)
      .whereJson('settings->profile->region', 'eu')
      .whereJsonContains('settings->tags', ['beta'])
      .whereJsonLength('settings->tags', 2)
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE ("settings")::jsonb #>> '{profile,region}' = $1 AND jsonb_extract_path(("settings")::jsonb, 'tags') @> $2::jsonb AND jsonb_array_length(jsonb_extract_path(("settings")::jsonb, 'tags')) = $3`,
      bindings: ['eu', '["beta"]', 2],
      source: 'query:select:users' })

    expect(DB.table(users)
      .where('settings->profile->region', 'eu')
      .toSQL()).toEqual({
      sql: `SELECT * FROM "users" WHERE ("settings")::jsonb #>> '{profile,region}' = $1`,
      bindings: ['eu'],
      source: 'query:select:users' })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new QueryAdapter(),
          dialect: createMySqlDialect() } } }))

    expect(DB.table(users)
      .whereJson('settings->profile->region', 'eu')
      .whereJsonContains('settings->tags', 'beta')
      .whereJsonLength('settings', '>=', 1)
      .toSQL()).toEqual({
      sql: `SELECT * FROM \`users\` WHERE JSON_UNQUOTE(JSON_EXTRACT(\`settings\`, '$.profile.region')) = ? AND JSON_CONTAINS(JSON_EXTRACT(\`settings\`, '$.tags'), CAST(? AS JSON)) AND JSON_LENGTH(JSON_EXTRACT(\`settings\`, '$')) >= ?`,
      bindings: ['eu', '"beta"', 1],
      source: 'query:select:users' })

    expect(DB.table(users)
      .where('settings->profile->region', 'eu')
      .toSQL()).toEqual({
      sql: `SELECT * FROM \`users\` WHERE JSON_UNQUOTE(JSON_EXTRACT(\`settings\`, '$.profile.region')) = ?`,
      bindings: ['eu'],
      source: 'query:select:users' })

    expect(DB.table(defineTable('analytics.users', {
      id: column.id(),
      settings: column.json() }))
      .whereJson('settings->profile->region', 'eu')
      .toSQL()).toEqual({
      sql: `SELECT * FROM \`analytics\`.\`users\` WHERE JSON_UNQUOTE(JSON_EXTRACT(\`settings\`, '$.profile.region')) = ?`,
      bindings: ['eu'],
      source: 'query:select:analytics.users' })

    expect(() => DB.table(users).whereJson('settings->', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('->profile' as never, 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('   ' as never, 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->>profile', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).whereJsonContains('name->profile', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(users).where('name->profile', 'eu')).toThrow(SecurityError)
    await expect(DB.table(users).whereJsonLength('settings->tags', 'like' as never, 2).get()).rejects.toThrow(SecurityError)
    expect(() => DB.table(users).whereJson('settings->profile', { region: 'eu' } as never)).toThrow(SecurityError)
  })

  it('compiles nested JSON updates per dialect and rejects unsafe update payloads', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      settings: column.json() })

    const sqliteAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: sqliteAdapter,
          dialect: createDialect('sqlite') } } }))

    await DB.table(users)
      .where('id', 1)
      .update({
        'settings->profile->region': 'eu',
        'settings->flags->beta': true })

    expect(sqliteAdapter.executions.at(-1)).toEqual({
      sql: `UPDATE "users" SET "settings" = json_set(json_set(COALESCE("settings", json('{}')), '$.profile.region', json(?1)), '$.flags.beta', json(?2)) WHERE "id" = ?3`,
      bindings: ['"eu"', 'true', 1] })

    const postgresAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: postgresAdapter,
          dialect: createPostgresDialect() } } }))

    await DB.table(users)
      .where('id', 1)
      .update({
        'settings->profile->region': 'eu',
        'settings->flags->beta': true })

    expect(postgresAdapter.executions.at(-1)).toEqual({
      sql: `UPDATE "users" SET "settings" = jsonb_set(jsonb_set(COALESCE(("settings")::jsonb, '{}'::jsonb), '{profile,region}', CAST($1 AS jsonb), true), '{flags,beta}', CAST($2 AS jsonb), true) WHERE "id" = $3`,
      bindings: ['"eu"', 'true', 1] })

    const mysqlAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: mysqlAdapter,
          dialect: createMySqlDialect() } } }))

    await DB.table(users)
      .where('id', 1)
      .update({
        'settings->profile->region': 'eu',
        'settings->flags->beta': true })

    expect(mysqlAdapter.executions.at(-1)).toEqual({
      sql: `UPDATE \`users\` SET \`settings\` = JSON_SET(JSON_SET(COALESCE(\`settings\`, JSON_OBJECT()), '$.profile.region', CAST(? AS JSON)), '$.flags.beta', CAST(? AS JSON)) WHERE \`id\` = ?`,
      bindings: ['"eu"', 'true', 1] })

    await expect(DB.table(users).update({
      'settings->profile->region': undefined })).rejects.toThrow(SecurityError)
    await expect(DB.table(users).update({
      'settings': {},
      'settings->profile->region': 'eu' })).rejects.toThrow(SecurityError)
    await expect(DB.table(users).update({
      'name->profile': 'eu' })).rejects.toThrow(SecurityError)
    await expect(DB.table(users).updateJson('settings->profile->region', 'mena')).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 9 })
  })

  it('normalizes direct table writes from declared column metadata', async () => {
    const capabilities = defineTable('capability_samples', {
      id: column.id(),
      title: column.string(),
      payload: column.json(),
      is_enabled: column.boolean(),
      published_at: column.datetime(),
    })

    const sqliteAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: sqliteAdapter,
          dialect: createDialect('sqlite'),
        },
      },
    }))

    await DB.table(capabilities).insert({
      title: 'Matrix',
      payload: { ok: true },
      is_enabled: true,
      published_at: new Date('2026-03-31T12:00:00.000Z'),
    })

    expect(sqliteAdapter.executions.at(-1)).toEqual({
      sql: 'INSERT INTO "capability_samples" ("title", "payload", "is_enabled", "published_at") VALUES (?1, ?2, ?3, ?4)',
      bindings: ['Matrix', '{"ok":true}', 1, '2026-03-31T12:00:00.000Z'],
    })
  })

  it('supports lazy and cursor iteration on table queries', async () => {
    const adapter = new QueryAdapter()
    adapter.queryRows = [
      { id: 1, name: 'Mohamed' },
      { id: 2, name: 'Amina' },
      { id: 3, name: 'Layla' },
    ]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const lazyNames: string[] = []
    for await (const row of DB.table(users).orderBy('id').lazy(2)) {
      lazyNames.push(String(row.name))
    }

    const cursorNames: string[] = []
    for await (const row of DB.table(users).orderBy('id').cursor()) {
      cursorNames.push(String(row.name))
    }

    expect(lazyNames).toEqual(['Mohamed', 'Amina', 'Layla'])
    expect(cursorNames).toEqual(['Mohamed', 'Amina', 'Layla'])
    await expect((async () => {
      for await (const _ of DB.table(users).lazy(0)) {
        void _
      }
    })()).rejects.toThrow(SecurityError)
  })

  it('exposes DB.raw as an explicit unsafe statement constructor', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite'),
          security: { allowUnsafeRawSql: true } } } }))

    const statement = DB.raw('select * from users where id = ?', [7], 'query:test')
    expect(statement).toEqual({
      unsafe: true,
      sql: 'select * from users where id = ?',
      bindings: [7],
      source: 'query:test' })

    await DB.unsafeQuery(statement)
    expect(adapter.queries.at(-1)).toEqual({
      sql: 'select * from users where id = ?',
      bindings: [7] })
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
          adapter: new QueryAdapter(),
          dialect: createDialect('sqlite') } } }))

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

  it('compiles inserts, updates, and deletes through the same safe compiler path', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite-basic') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean() })

    const compiler = (DB.table(users) as unknown as { getCompiler(): SQLQueryCompiler }).getCompiler()
    const insertStatement = compiler.compile({
      kind: 'insert',
      source: createTableSource(users),
      ignoreConflicts: false,
      values: [{ name: 'Preview', active: true }] })
    const updateStatement = compiler.compile({
      kind: 'update',
      source: createTableSource(users),
      predicates: [],
      values: { active: true } })
    const deleteStatement = compiler.compile({
      kind: 'delete',
      source: createTableSource(users),
      predicates: [] })

    expect(insertStatement.metadata).toMatchObject({
      kind: 'insert',
      resultMode: 'write',
      selectedShape: {
        mode: 'write',
        columns: [],
        aggregates: [],
        hasRawSelections: false,
        hasSubqueries: false },
      safety: {
        unsafe: false,
        containsRawSql: false },
      debug: {
        tableName: 'users',
        hasJoins: false,
        hasUnions: false,
        hasGrouping: false,
        hasHaving: false,
        complexity: 3,
        intent: 'write',
        transactionAffinity: 'required',
        streaming: 'buffered' } })
    expect(updateStatement.metadata).toMatchObject({
      kind: 'update',
      resultMode: 'write',
      selectedShape: {
        mode: 'write',
        columns: [],
        aggregates: [],
        hasRawSelections: false,
        hasSubqueries: false },
      safety: {
        unsafe: false,
        containsRawSql: false },
      debug: {
        tableName: 'users',
        hasJoins: false,
        hasUnions: false,
        hasGrouping: false,
        hasHaving: false,
        complexity: 2,
        intent: 'write',
        transactionAffinity: 'required',
        streaming: 'buffered' } })
    expect(deleteStatement.metadata).toMatchObject({
      kind: 'delete',
      resultMode: 'write',
      selectedShape: {
        mode: 'write',
        columns: [],
        aggregates: [],
        hasRawSelections: false,
        hasSubqueries: false },
      safety: {
        unsafe: false,
        containsRawSql: false },
      debug: {
        tableName: 'users',
        hasJoins: false,
        hasUnions: false,
        hasGrouping: false,
        hasHaving: false,
        complexity: 1,
        intent: 'write',
        transactionAffinity: 'required',
        streaming: 'buffered' } })

    await DB.table(users).insert([
      { name: 'Mohamed', active: true },
      { name: 'Amina', active: false },
    ])
    await DB.table(users).where('id', 5).update({ active: true })
    await DB.table(users).where('id', 6).delete()

    expect(adapter.executions).toEqual([
      {
        sql: 'INSERT INTO "users" ("name", "active") VALUES (?1, ?2), (?3, ?4)',
        bindings: ['Mohamed', 1, 'Amina', 0] },
      {
        sql: 'UPDATE "users" SET "active" = ?1 WHERE "id" = ?2',
        bindings: [1, 5] },
      {
        sql: 'DELETE FROM "users" WHERE "id" = ?1',
        bindings: [6] },
    ])

    await DB.table('users').insert({ name: 'Solo' })
    expect(adapter.executions[3]).toEqual({
      sql: 'INSERT INTO "users" ("name") VALUES (?1)',
      bindings: ['Solo'] })
  })

  it('supports aggregate and scalar retrieval helpers on table queries', async () => {
    const adapter = new QueryAdapter()
    adapter.queryRows = [
      { id: 1, name: 'Mohamed', score: 10 },
      { id: 2, name: 'Amina', score: 20 },
      { id: 3, name: 'Salma', score: 30 },
    ]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer() })

    expect(await DB.table(users).count()).toBe(3)
    expect(await DB.table(users).exists()).toBe(true)
    expect(await DB.table(users).doesntExist()).toBe(false)
    expect(await DB.table(users).pluck('name')).toEqual(['Mohamed', 'Amina', 'Salma'])
    expect(await DB.table(users).value('name')).toBe('Mohamed')
    expect(await DB.table(users).sum('score')).toBe(60)
    expect(await DB.table(users).avg('score')).toBe(20)
    expect(await DB.table(users).min('score')).toBe(10)
    expect(await DB.table(users).max('score')).toBe(30)

    adapter.queryRows = []
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

  it('supports typed grouped aggregate selections on table queries', async () => {
    const adapter = new QueryAdapter()
    adapter.queryRows = [
      { name: 'Mohamed', total: 2, totalScore: 40, averageScore: 20, minimumScore: 10, maximumScore: 30 },
      { name: 'Amina', total: 1, totalScore: 20, averageScore: 20, minimumScore: 20, maximumScore: 20 },
    ]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer() })

    expect(DB.table(users)
      .select('name')
      .addSelectCount('total')
      .addSelectSum('totalScore', 'score')
      .addSelectAvg('averageScore', 'score')
      .addSelectMin('minimumScore', 'score')
      .addSelectMax('maximumScore', 'score')
      .groupBy('name')
      .orderBy('name')
      .toSQL()).toEqual({
      sql: 'SELECT "name", COUNT(*) AS "total", SUM("score") AS "totalScore", AVG("score") AS "averageScore", MIN("score") AS "minimumScore", MAX("score") AS "maximumScore" FROM "users" GROUP BY "name" ORDER BY "name" ASC',
      bindings: [],
      source: 'query:select:users',
      unsafe: undefined })

    await expect(DB.table(users)
      .selectCount('total')
      .groupBy('missing' as never)
      .get()).rejects.toThrow(SecurityError)

    expect(await DB.table(users)
      .select('name')
      .addSelectCount('total')
      .addSelectSum('totalScore', 'score')
      .addSelectAvg('averageScore', 'score')
      .addSelectMin('minimumScore', 'score')
      .addSelectMax('maximumScore', 'score')
      .groupBy('name')
      .orderBy('name')
      .get()).toEqual([
      { name: 'Mohamed', total: 2, totalScore: 40, averageScore: 20, minimumScore: 10, maximumScore: 30 },
      { name: 'Amina', total: 1, totalScore: 20, averageScore: 20, minimumScore: 20, maximumScore: 20 },
    ])

    expect(DB.table(users).selectMin('minimumScore', 'score').toSQL()).toEqual({
      sql: 'SELECT MIN("score") AS "minimumScore" FROM "users"',
      bindings: [],
      source: 'query:select:users',
      unsafe: undefined })
    expect(DB.table(users).selectMax('maximumScore', 'score').toSQL()).toEqual({
      sql: 'SELECT MAX("score") AS "maximumScore" FROM "users"',
      bindings: [],
      source: 'query:select:users',
      unsafe: undefined })
    expect(DB.table(users).selectCount().toSQL()).toEqual({
      sql: 'SELECT COUNT(*) AS "count" FROM "users"',
      bindings: [],
      source: 'query:select:users',
      unsafe: undefined })
    expect(DB.table(users).select('name').addSelectCount().toSQL()).toEqual({
      sql: 'SELECT "name", COUNT(*) AS "count" FROM "users"',
      bindings: [],
      source: 'query:select:users',
      unsafe: undefined })
    expect(DB.table(users).selectSum('totalScore', 'score').toSQL()).toEqual({
      sql: 'SELECT SUM("score") AS "totalScore" FROM "users"',
      bindings: [],
      source: 'query:select:users',
      unsafe: undefined })
    expect(DB.table(users).selectAvg('averageScore', 'score').toSQL()).toEqual({
      sql: 'SELECT AVG("score") AS "averageScore" FROM "users"',
      bindings: [],
      source: 'query:select:users',
      unsafe: undefined })
  })

  it('supports pagination and chunking on table queries', async () => {
    const adapter = new QueryAdapter()
    adapter.queryRows = [
      { id: 1, name: 'Mohamed' },
      { id: 2, name: 'Amina' },
      { id: 3, name: 'Salma' },
      { id: 4, name: 'Youssef' },
      { id: 5, name: 'Nada' },
    ]

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    const defaultOrderedCursorPage = await DB.table(users).cursorPaginate(1)
    expect(defaultOrderedCursorPage.data).toEqual([{ id: 1, name: 'Mohamed' }])

    expect(DB.table(users).orderBy('id').forPage(2, 2).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "id" ASC LIMIT 2 OFFSET 2',
      bindings: [],
      source: 'query:select:users' })
    expect(DB.table(users).orderBy('id').skip(1).take(2).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "id" ASC LIMIT 2 OFFSET 1',
      bindings: [],
      source: 'query:select:users' })

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
    expect(firstCursorPage.nextCursorToken()).toBe(firstCursorPage.nextCursor)
    expect(firstCursorPage.previousCursorToken()).toBeNull()
    expect(firstCursorPage.toJSON()).toEqual({
      data: firstCursorPage.data,
      perPage: firstCursorPage.perPage,
      cursorName: 'cursor',
      nextCursor: firstCursorPage.nextCursor,
      prevCursor: null })

    const secondCursorPage = await DB.table(users).orderBy('id').cursorPaginate(2, firstCursorPage.nextCursor)
    expect(secondCursorPage.data).toEqual([
      { id: 3, name: 'Salma' },
      { id: 4, name: 'Youssef' },
    ])
    expect(secondCursorPage.prevCursor).toBe(firstCursorPage.nextCursor)

    const lastCursorPage = await DB.table(users).orderBy('id').cursorPaginate(10)
    expect(lastCursorPage.nextCursor).toBeNull()

    const customPaginated = await DB.table(users).orderBy('id').paginate(2, 1, { pageName: ' usersPage ' })
    expect(customPaginated.meta.pageName).toBe('usersPage')
    const customSimple = await DB.table(users).orderBy('id').simplePaginate(2, 1, { pageName: ' usersPage ' })
    expect(customSimple.meta.pageName).toBe('usersPage')
    const customCursor = await DB.table(users).orderBy('id').cursorPaginate(2, null, { cursorName: ' usersCursor ' })
    expect(customCursor.cursorName).toBe('usersCursor')

    const chunked: number[][] = []
    await DB.table(users).chunk(2, (rows) => {
      chunked.push(rows.map(row => row.id as number))
    })
    expect(chunked).toEqual([[1, 2], [3, 4], [5]])

    const stoppedChunks: number[][] = []
    await DB.table(users).chunkById(2, (rows, page) => {
      stoppedChunks.push(rows.map(row => row.id as number))
      return page < 2
    })
    expect(stoppedChunks).toEqual([[1, 2], [3, 4]])

    const stoppedPages: number[][] = []
    await DB.table(users).chunk(2, (rows, page) => {
      stoppedPages.push(rows.map(row => row.id as number))
      return page < 2
    })
    expect(stoppedPages).toEqual([[1, 2], [3, 4]])

    adapter.queryRows = [
      { id: 1, sortKey: 1, name: 'Equal A' },
      { id: 2, sortKey: null, name: 'Null' },
      { id: 3, sortKey: 1, name: 'Equal B' },
      { id: 4, name: 'Missing' },
      { id: 5, sortKey: 2, name: 'Two' },
    ]
    const sortedEdgeChunks: string[][] = []
    await DB.table('users').chunkById(10, (rows) => {
      sortedEdgeChunks.push(rows.map(row => row.name as string))
    }, 'sortKey')
    expect(sortedEdgeChunks).toEqual([['Missing', 'Null', 'Equal A', 'Equal B', 'Two']])

    adapter.queryRows = [
      { id: 10, sortKey: 2, name: 'Two' },
      { id: 11, sortKey: 1, name: 'One' },
    ]
    const descendingInputSorted: string[][] = []
    await DB.table('users').chunkById(10, (rows) => {
      descendingInputSorted.push(rows.map(row => row.name as string))
    }, 'sortKey')
    expect(descendingInputSorted).toEqual([['One', 'Two']])

    const descendingChunks: string[][] = []
    await DB.table('users').chunkByIdDesc(10, (rows) => {
      descendingChunks.push(rows.map(row => row.name as string))
    }, 'sortKey')
    expect(descendingChunks).toEqual([['Two', 'One']])

    const stoppedDescendingChunks: string[][] = []
    await DB.table('users').chunkByIdDesc(1, (rows, page) => {
      stoppedDescendingChunks.push(rows.map(row => row.name as string))
      return page < 2
    }, 'sortKey')
    expect(stoppedDescendingChunks).toEqual([['Two'], ['One']])

    adapter.queryRows = [
      { id: 20, sortKey: 1, name: 'Equal A' },
      { id: 21, sortKey: 1, name: 'Equal B' },
      { id: 22, sortKey: null, name: 'Null' },
      { id: 23, name: 'Missing' },
    ]
    const descendingBranchCoverage: string[][] = []
    await DB.table('users').chunkByIdDesc(10, (rows) => {
      descendingBranchCoverage.push(rows.map(row => row.name as string))
    }, 'sortKey')
    expect(descendingBranchCoverage).toEqual([['Equal A', 'Equal B', 'Null', 'Missing']])
    expect((DB.table('users') as unknown as { resolvePrimaryKeyColumn(): string }).resolvePrimaryKeyColumn()).toBe('id')
  })

  it('rejects malformed pagination and cursor inputs on table queries', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    await expect(DB.table('users').paginate(0, 1)).rejects.toThrow('Per-page value must be a positive integer.')
    await expect(DB.table('users').simplePaginate(1, 0)).rejects.toThrow('Page must be a positive integer.')
    await expect(DB.table('users').cursorPaginate(2, 'broken')).rejects.toThrow('Cursor is malformed.')
    await expect(DB.table('users').paginate(1, 1, { pageName: '' })).rejects.toThrow('Page parameter name must be a non-empty string.')
    await expect(DB.table('users').cursorPaginate(1, null, { cursorName: '' })).rejects.toThrow('Cursor parameter name must be a non-empty string.')
    await expect(DB.table('users').cursorPaginate(1)).rejects.toThrow('Cursor pagination requires an explicit stable orderBy clause.')
    await expect(DB.table('users').inRandomOrder().cursorPaginate(1)).rejects.toThrow('Cursor pagination cannot use random ordering.')
    const malformedCursor = Buffer.from(JSON.stringify({ offset: 'bad' }), 'utf8').toString('base64url')
    await expect(DB.table('users').cursorPaginate(2, malformedCursor)).rejects.toThrow('Cursor is malformed.')
    await expect(DB.table('users').chunk(0, () => undefined)).rejects.toThrow('Chunk size must be a positive integer.')
    await expect(DB.table('users').chunkById(0, () => undefined)).rejects.toThrow('Chunk size must be a positive integer.')
  })

  it('supports explicit unsafe raw builder APIs with policy enforcement', async () => {
    const deniedAdapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: deniedAdapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer() })

    const unsafeBuilder = DB.table(users)
      .unsafeSelect('COUNT(*) AS "total"', [])
      .unsafeWhere('"name" = ?1', ['Mohamed'])
      .unsafeOrderBy('"total" DESC', [])

    expect(DB.table(users)
      .unsafeSelect('"name"', [])
      .addUnsafeSelect('COUNT(*) AS "total"', [])
      .toSQL()).toEqual({
      sql: 'SELECT "name", COUNT(*) AS "total" FROM "users"',
      bindings: [],
      source: 'query:select:users',
      unsafe: true })

    expect(unsafeBuilder.toSQL()).toEqual({
      sql: 'SELECT COUNT(*) AS "total" FROM "users" WHERE "name" = ?1 ORDER BY "total" DESC',
      bindings: ['Mohamed'],
      source: 'query:select:users',
      unsafe: true })

    await expect(unsafeBuilder.get()).rejects.toThrow(
      'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().',
    )

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: deniedAdapter,
          dialect: createDialect('sqlite'),
          security: { allowUnsafeRawSql: true } } } }))

    deniedAdapter.queryRows = [{ total: 1 }]
    expect(await DB.table(users)
      .unsafeSelect('COUNT(*) AS "total"', [])
      .unsafeWhere('"name" = ?1', ['Mohamed'])
      .unsafeOrderBy('"total" DESC', [])
      .get()).toEqual([{ total: 1 }])
    deniedAdapter.queryRows = [{ id: 1, name: 'Mohamed', meta: { city: 'Cairo' }, active: true, score: 10 }]
    expect(await DB.table(users)
      .unsafeWhere('"name" = ?', ['Mohamed'])
      .get()).toEqual([{ id: 1, name: 'Mohamed', meta: { city: 'Cairo' }, active: true, score: 10 }])

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

    deniedAdapter.queryRows = [{ id: 1, name: 'Mohamed', meta: { city: 'Cairo' }, active: true, score: 10 }]
    for (const count of [1, 2, 3, 4]) {
      const anonymousSql = Array.from({ length: count }, () => '"name" = ?').join(' OR ')
      const anonymousBindings = Array.from({ length: count }, () => 'Mohamed')
      await expect(DB.table(users).unsafeWhere(anonymousSql, anonymousBindings).get()).resolves.toEqual([
        { id: 1, name: 'Mohamed', meta: { city: 'Cairo' }, active: true, score: 10 },
      ])

      await expect(DB.table(users).unsafeWhere(anonymousSql, anonymousBindings.slice(0, -1)).get()).rejects.toThrow(
        'Raw predicate SQL placeholder count does not match the provided bindings.',
      )

      const numberedSql = Array.from({ length: count }, (_, index) => `"score" = ?${index + 1}`).join(' OR ')
      const numberedBindings = Array.from({ length: count }, (_, index) => index + 1)
      await expect(DB.table(users).unsafeWhere(numberedSql, numberedBindings).get()).resolves.toEqual([
        { id: 1, name: 'Mohamed', meta: { city: 'Cairo' }, active: true, score: 10 },
      ])
    }
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
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    await expect(DB.table(users).where('email' as never, 'x@example.com').get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).update({ email: 'x@example.com' })).rejects.toThrow(
      'Column "email" is not defined on table "users".',
    )
  })

  it('rejects malformed identifiers, unsupported operators, and invalid query shapes', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

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
    adapter.queryRows = [{ id: 1, name: 'Mohamed' }]
    await expect(DB.table('users').sum('name')).rejects.toThrow(
      'Query aggregate "sum" requires numeric values for column "name".',
    )
  })

  it('treats hostile values as bindings and rejects identifier injection attempts', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('sqlite') } } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean() })

    const payload = `Mohamed"; DROP TABLE users; --`
    await DB.table(users).where('name', payload).get()
    expect(adapter.queries[0]).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = ?1',
      bindings: [payload] })

    await expect(DB.table(users).select('name;drop' as never).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).where('name;drop' as never, 'Mohamed').get()).rejects.toThrow(SecurityError)
    await expect(DB.table(users).orderBy('name desc; drop' as never).get()).rejects.toThrow(SecurityError)
  })

  it('compiles and executes through the Postgres and MySQL query compilers', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createPostgresDialect() } } }))

    await DB.table('users').where('name', 'Mohamed').get()
    expect(adapter.queries[0]).toEqual({
      sql: 'SELECT * FROM "users" WHERE "name" = $1',
      bindings: ['Mohamed'] })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createMySqlDialect() } } }))

    await DB.table('users').where('name', 'Mohamed').get()
    expect(adapter.queries[1]).toEqual({
      sql: 'SELECT * FROM `users` WHERE `name` = ?',
      bindings: ['Mohamed'] })
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

  it('keeps cross-dialect SQL snapshots stable for a representative complex query', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean(),
      settings: column.json<{ profile: { region: string } }>() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: { adapter: new QueryAdapter(), dialect: createDialect('sqlite') } } }))

    const sqliteSnapshot = DB.table(users)
      .select('users.id', 'users.name as displayName')
      .addSelectCount('postCount')
      .where('users.active', true)
      .whereJson('users.settings->profile->region', 'mena')
      .groupBy('users.id', 'users.name')
      .having('count(*)', '>=', 1)
      .orderBy('users.id', 'desc')
      .limit(5)
      .toSQL()
    expect(JSON.stringify(sqliteSnapshot, null, 2)).toMatchInlineSnapshot(`
      "{
        "sql": "SELECT \\"users\\".\\"id\\", \\"users\\".\\"name\\" AS \\"displayName\\", COUNT(*) AS \\"postCount\\" FROM \\"users\\" WHERE \\"users\\".\\"active\\" = ?1 AND json_extract(\\"users\\".\\"settings\\", '$.profile.region') = ?2 GROUP BY \\"users\\".\\"id\\", \\"users\\".\\"name\\" HAVING COUNT(*) >= ?3 ORDER BY \\"users\\".\\"id\\" DESC LIMIT 5",
        "bindings": [
          true,
          "mena",
          1
        ],
        "source": "query:select:users"
      }"
    `)

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: { adapter: new QueryAdapter(), dialect: createPostgresDialect() } } }))

    const postgresSnapshot = DB.table(users)
      .select('users.id', 'users.name as displayName')
      .addSelectCount('postCount')
      .where('users.active', true)
      .whereJson('users.settings->profile->region', 'mena')
      .groupBy('users.id', 'users.name')
      .having('count(*)', '>=', 1)
      .orderBy('users.id', 'desc')
      .limit(5)
      .toSQL()
    expect(JSON.stringify(postgresSnapshot, null, 2)).toMatchInlineSnapshot(`
      "{
        "sql": "SELECT \\"users\\".\\"id\\", \\"users\\".\\"name\\" AS \\"displayName\\", COUNT(*) AS \\"postCount\\" FROM \\"users\\" WHERE \\"users\\".\\"active\\" = $1 AND (\\"users\\".\\"settings\\")::jsonb #>> '{profile,region}' = $2 GROUP BY \\"users\\".\\"id\\", \\"users\\".\\"name\\" HAVING COUNT(*) >= $3 ORDER BY \\"users\\".\\"id\\" DESC LIMIT 5",
        "bindings": [
          true,
          "mena",
          1
        ],
        "source": "query:select:users"
      }"
    `)

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: { adapter: new QueryAdapter(), dialect: createMySqlDialect() } } }))

    const mysqlSnapshot = DB.table(users)
      .select('users.id', 'users.name as displayName')
      .addSelectCount('postCount')
      .where('users.active', true)
      .whereJson('users.settings->profile->region', 'mena')
      .groupBy('users.id', 'users.name')
      .having('count(*)', '>=', 1)
      .orderBy('users.id', 'desc')
      .limit(5)
      .toSQL()
    expect(JSON.stringify(mysqlSnapshot, null, 2)).toMatchInlineSnapshot(`
      "{
        "sql": "SELECT \`users\`.\`id\`, \`users\`.\`name\` AS \`displayName\`, COUNT(*) AS \`postCount\` FROM \`users\` WHERE \`users\`.\`active\` = ? AND JSON_UNQUOTE(JSON_EXTRACT(\`users\`.\`settings\`, '$.profile.region')) = ? GROUP BY \`users\`.\`id\`, \`users\`.\`name\` HAVING COUNT(*) >= ? ORDER BY \`users\`.\`id\` DESC LIMIT 5",
        "bindings": [
          true,
          "mena",
          1
        ],
        "source": "query:select:users"
      }"
    `)
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
        default: { adapter: new QueryAdapter(), dialect: createPostgresDialect() } } }))

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
    expect(first.bindings).toEqual([1, 'Hello%', 'Mohamed', 'mena', 2])
  })

  it('fails closed for unsupported query dialects', async () => {
    const adapter = new QueryAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect('oracle') } } }))

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
