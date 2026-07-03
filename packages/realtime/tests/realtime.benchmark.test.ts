import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import {
  belongsTo,
  belongsToMany,
  column,
  configureDB,
  createCapabilities,
  createConnectionManager,
  createDatabase,
  defineGeneratedTable,
  defineModel,
  hasMany,
  hasOne,
  queryCacheInternals,
  recordDatabaseQueryDependencies,
  resetDatabaseDependencyInvalidationListeners,
  resetDB,
} from '@holo-js/db'
import type {
  DatabaseContext,
  CursorPaginatedResult,
  Dialect,
  DriverAdapter,
  DriverExecutionResult,
  DriverQueryResult,
  SimplePaginatedResult,
} from '@holo-js/db'
import { field, schema } from '@holo-js/validation'
import { recordDatabaseQueryObservation, type DatabaseMutationEvent } from '../../db/src/cache'
import {
  defineRealtimeMutation,
  configureRealtimeClientTransport,
  defineRealtimeQuery,
  getRealtimeQueryStore,
  realtimeClientInternals,
  resetRealtimeClientRuntime,
  type RealtimeAuthRequestAccessors,
  type RealtimeClientTransport,
  type RealtimeSubscriptionSnapshot,
} from '../src/index'
import {
  configureRealtimeRuntime,
  executeRealtimeMutation,
  realtimeRuntimeInternals,
  resetRealtimeRuntime,
  subscribeRealtimeQuery,
} from '../src/server'
import {
  compactPatchOperations,
  createSplicePatchOperation,
} from '../src/runtime/patch-operations'
import { collectRelevantMutationTargets } from '../src/runtime/query-relevant-mutations'
import type { DatabaseMutationEvent as RuntimeDatabaseMutationEvent } from '../src/runtime/dependencies'
import type { BackfillCache, QueryPatchTarget } from '../src/runtime/query-state'

type BenchmarkMetrics = {
  readonly durationMs: number
  readonly emittedSnapshots: number
  readonly queryExecutions: number
  readonly scenario: string
  readonly sharedQueries: number
  readonly subscriptions: number
}

type BenchmarkCounters = {
  emittedSnapshots: number
  queryExecutions: number
}

type BenchmarkPatchInvalidation = Parameters<typeof realtimeRuntimeInternals.handleDatabaseInvalidation>[0] & {
  readonly mutations: readonly DatabaseMutationEvent[]
}

type BenchmarkPatchOperation =
  | {
    readonly op: 'replace'
    readonly path: readonly (string | number)[]
    readonly value: unknown
  }
  | {
    readonly op: 'replace'
    readonly path: readonly (string | number)[]
    readonly valueKind: 'undefined'
  }
  | {
    readonly op: 'merge'
    readonly path: readonly (string | number)[]
    readonly fields: Readonly<Record<string, unknown>>
  }
  | {
    readonly op: 'splice'
    readonly path: readonly (string | number)[]
    readonly index: number
    readonly deleteCount: number
    readonly values: readonly unknown[]
  }
  | {
    readonly op: 'move'
    readonly path: readonly (string | number)[]
    readonly from: number
    readonly to: number
  }

type BenchmarkPatch = {
  readonly dependencies?: readonly string[]
  readonly operations: readonly BenchmarkPatchOperation[]
  readonly version: number
}

type BenchmarkPostRow = {
  readonly author_id?: number | null
  readonly id: number
  readonly priority?: number
  readonly score?: number
  readonly title: string
  readonly user_id: number
}

type BenchmarkAuthorRow = {
  readonly id: number
  readonly name: string
}

type BenchmarkTagRow = {
  readonly id: number
  readonly name: string
}

type BenchmarkRelationTagRow = BenchmarkTagRow & {
  readonly pivot: {
    readonly weight: number
  }
}

type BenchmarkPostWithTagsRow = BenchmarkPostRow & {
  readonly tags: readonly BenchmarkRelationTagRow[]
}

type BenchmarkPostTagRow = {
  readonly id: number
  readonly postId: number
  readonly tagId: number
  readonly weight?: number
}

type BenchmarkModelTables = {
  readonly authors?: readonly BenchmarkAuthorRow[]
  readonly posts: readonly BenchmarkPostRow[]
  readonly post_tags?: readonly BenchmarkPostTagRow[]
  readonly tags?: readonly BenchmarkTagRow[]
}

type BenchmarkPaginatedRows = {
  readonly data: readonly BenchmarkPostRow[]
  readonly meta: {
    readonly currentPage: number
    readonly from: number | null
    readonly hasMorePages: boolean
    readonly lastPage: number
    readonly pageName: string
    readonly perPage: number
    readonly to: number | null
    readonly total: number
  }
}

type BenchmarkSimplePaginatedRows = {
  readonly data: readonly BenchmarkPostRow[]
  readonly meta: {
    readonly currentPage: number
    readonly from: number | null
    readonly hasMorePages: boolean
    readonly pageName: string
    readonly perPage: number
    readonly to: number | null
  }
}

type BenchmarkCursorPaginatedRows = {
  readonly cursorName: string
  readonly data: readonly BenchmarkPostRow[]
  readonly nextCursor: string | null
  readonly perPage: number
  readonly prevCursor: string | null
}

type BenchmarkPaginatedAuthorAggregates = {
  readonly data: readonly Readonly<Record<string, unknown>>[]
  readonly meta: BenchmarkPaginatedRows['meta']
}

type BenchmarkWidePostRow = BenchmarkPostRow & {
  readonly field_1: string
  readonly field_2: string
  readonly field_3: string
  readonly field_4: string
  readonly field_5: string
  readonly field_6: string
  readonly field_7: string
  readonly field_8: string
  readonly field_9: string
}

const connectionName = 'main'
const tableName = 'posts'
const subscriptionCount = 1_000
const sharedQueryCount = 100
const patchRowCount = 1_000
const longBenchmarkTimeoutMs = 20_000

const benchmarkModelDialect: Dialect = {
  name: 'sqlite',
  capabilities: createCapabilities(),
  quoteIdentifier(identifier: string): string {
    return `"${identifier}"`
  },
  createPlaceholder(): string {
    return '?'
  },
}

const benchmarkReturningDialect: Dialect = {
  ...benchmarkModelDialect,
  capabilities: createCapabilities({ returning: true }),
}

class BenchmarkModelAdapter implements DriverAdapter {
  private connected = false
  private readonly tables: BenchmarkModelTables
  readonly executions: Array<{ readonly sql: string, readonly bindings: readonly unknown[] }> = []
  readonly queries: Array<{ readonly sql: string, readonly bindings: readonly unknown[] }> = []

  constructor(rowsOrTables: readonly BenchmarkPostRow[] | BenchmarkModelTables) {
    this.tables = 'posts' in rowsOrTables ? rowsOrTables : { posts: rowsOrTables }
  }

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
    const groupedRows = this.queryGroupedRowNumberRows(sql, bindings)
    if (groupedRows) {
      return {
        rows: groupedRows as TRow[],
        rowCount: groupedRows.length,
      }
    }

    const table = this.readTableName(sql)
    const rows = [...this.filterRows(sql, bindings, this.readRows(table))]
    rows.sort((left, right) => this.compareRows(sql, left, right))
    const window = this.readRowsWindow(sql, bindings)
    const windowedRows = typeof window.limit === 'number'
      ? rows.slice(window.offset, window.offset + window.limit)
      : rows.slice(window.offset)
    return {
      rows: this.projectRows(sql, bindings, windowedRows) as TRow[],
      rowCount: windowedRows.length,
    }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })

    return {
      affectedRows: 1,
    }
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  private queryGroupedRowNumberRows(
    sql: string,
    bindings: readonly unknown[],
  ): Readonly<Record<string, unknown>>[] | undefined {
    if (!sql.includes('ROW_NUMBER() OVER (PARTITION BY')) {
      return undefined
    }

    const table = this.readTableName(sql)
    const partitionColumn = sql.match(/ROW_NUMBER\(\) OVER \(PARTITION BY "([^"]+)"/)?.[1]
    const rowNumberAlias = sql.match(/ROW_NUMBER\(\) OVER \(PARTITION BY "[^"]+" ORDER BY .+?\) AS "([^"]+)"/)?.[1]
    const groupAlias = partitionColumn
      ? sql.match(new RegExp(`"${partitionColumn}" AS "([^"]+)"`))?.[1]
      : undefined
    const orderBy = sql.match(/ROW_NUMBER\(\) OVER \(PARTITION BY "[^"]+" ORDER BY (.+?)\) AS/)?.[1]
    const innerWhere = this.readGroupedRowNumberInnerWhere(sql, table)
    const selection = sql.match(/^SELECT \* FROM \(SELECT (.+), ROW_NUMBER\(\)/)?.[1]
    if (!partitionColumn || !rowNumberAlias || !groupAlias || !orderBy || !innerWhere || !selection) {
      return undefined
    }

    const rows = this.filterRows(`SELECT * FROM "${table}" WHERE ${innerWhere}`, bindings, this.readRows(table))
    const groups = new Map<unknown, Readonly<Record<string, unknown>>[]>()
    for (const row of rows) {
      const key = row[partitionColumn]
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }

    const window = this.readGroupedRowNumberWindow(sql, bindings, innerWhere)
    const result: Readonly<Record<string, unknown>>[] = []
    for (const [key, group] of groups) {
      const sortedGroup = [...group].sort((left, right) => this.compareOrderByExpression(orderBy, left, right))
      for (let index = 0; index < sortedGroup.length; index += 1) {
        const rowNumber = index + 1
        if (rowNumber <= window.lowerBound || rowNumber > window.upperBound) {
          continue
        }

        const row = sortedGroup[index]
        if (!row) {
          return undefined
        }

        result.push(Object.freeze({
          ...this.projectGroupedRowNumberSelection(selection, row),
          [groupAlias]: key,
          [rowNumberAlias]: rowNumber,
        }))
      }
    }

    return result.sort((left, right) => {
      const groupComparison = this.compareValues(left[groupAlias], right[groupAlias])
      if (typeof groupComparison === 'number' && groupComparison !== 0) {
        return groupComparison
      }

      const leftRowNumber = left[rowNumberAlias]
      const rightRowNumber = right[rowNumberAlias]
      return typeof leftRowNumber === 'number' && typeof rightRowNumber === 'number'
        ? leftRowNumber - rightRowNumber
        : 0
    })
  }

  private readGroupedRowNumberInnerWhere(sql: string, table: keyof BenchmarkModelTables): string | undefined {
    const startMarker = ` FROM "${table}" WHERE `
    const start = sql.indexOf(startMarker)
    if (start < 0) {
      return undefined
    }

    const whereStart = start + startMarker.length
    const whereEnd = sql.indexOf(') AS "', whereStart)
    return whereEnd > whereStart ? sql.slice(whereStart, whereEnd) : undefined
  }

  private readGroupedRowNumberWindow(
    sql: string,
    bindings: readonly unknown[],
    innerWhere: string,
  ): { readonly lowerBound: number, readonly upperBound: number } {
    const innerBindingCount = this.countPlaceholders(innerWhere)
    const outerBindings = bindings.slice(innerBindingCount)
    if (sql.includes('" > ?')) {
      return {
        lowerBound: Number(outerBindings[0]),
        upperBound: Number(outerBindings[1]),
      }
    }

    return {
      lowerBound: 0,
      upperBound: Number(outerBindings[0]),
    }
  }

  private countPlaceholders(sql: string): number {
    return sql.match(/\?/g)?.length ?? 0
  }

  private projectGroupedRowNumberSelection(
    selection: string,
    row: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (selection.startsWith('*, ')) {
      return { ...row }
    }

    const projected: Record<string, unknown> = {}
    for (const part of selection.split(', ')) {
      const match = part.match(/^"([^"]+)"(?: AS "([^"]+)")?$/)
      if (match) {
        projected[match[2] ?? match[1]!] = row[match[1]!]
      }
    }

    return projected
  }

  private compareOrderByExpression(
    orderBy: string,
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
  ): number {
    for (const order of orderBy.split(', ')) {
      const match = order.match(/^"([^"]+)" (ASC|DESC)$/)
      if (!match) {
        continue
      }

      const column = match[1]!
      const direction = match[2]
      const comparison = this.compareValues(left[column], right[column])
      if (typeof comparison === 'number' && comparison !== 0) {
        return direction === 'DESC' ? -comparison : comparison
      }
    }

    return 0
  }

  private readTableName(sql: string): keyof BenchmarkModelTables {
    const tableName = sql.match(/ FROM "([^"]+)"/)?.[1]
    return tableName && tableName in this.tables
      ? tableName as keyof BenchmarkModelTables
      : 'posts'
  }

  private readRows(table: keyof BenchmarkModelTables): readonly Readonly<Record<string, unknown>>[] {
    return this.tables[table] ?? []
  }

  private filterRows(
    sql: string,
    bindings: readonly unknown[],
    rows: readonly Readonly<Record<string, unknown>>[],
  ): readonly Readonly<Record<string, unknown>>[] {
    const where = sql.match(/ WHERE (.+?)( GROUP BY| ORDER BY| LIMIT| OFFSET|$)/)?.[1]
    if (!where) {
      return rows
    }

    const clauses = where.split(' AND ')
    return rows.filter((row) => {
      let bindingIndex = 0
      return clauses.every((clause) => {
        const inMatch = clause.match(/^"([^"]+)" (NOT IN|IN) \((.+)\)$/)
        if (inMatch) {
          const column = inMatch[1]
          const operator = inMatch[2]
          const indexes = inMatch[3]!.split(', ').map((placeholder, index) => {
            const rawIndex = placeholder.replace('?', '')
            return rawIndex ? Number(rawIndex) - 1 : bindingIndex + index
          })
          const present = indexes.map(index => bindings[index]).includes(row[column!])
          bindingIndex += indexes.length
          return operator === 'IN' ? present : !present
        }

        const comparisonMatch = clause.match(/^"([^"]+)" (=|!=|<>|>=|>|<=|<|LIKE) \?(\d*)$/)
        if (!comparisonMatch) {
          return true
        }

        const column = comparisonMatch[1]
        const operator = comparisonMatch[2]
        const rawIndex = comparisonMatch[3]
        const valueIndex = rawIndex ? Number(rawIndex) - 1 : bindingIndex
        bindingIndex += 1
        return this.applyPredicate(row[column!], operator!, bindings[valueIndex])
      })
    })
  }

  private compareValues(left: unknown, right: unknown): number | undefined {
    if (typeof left === 'number' && typeof right === 'number') {
      return left === right ? 0 : left < right ? -1 : 1
    }

    if (typeof left === 'string' && typeof right === 'string') {
      const comparison = left.localeCompare(right)
      return comparison === 0 ? 0 : comparison < 0 ? -1 : 1
    }

    if (left === right) {
      return 0
    }

    return undefined
  }

  private applyPredicate(left: unknown, operator: string, right: unknown): boolean {
    switch (operator) {
      case '=':
        return left === right
      case '!=':
      case '<>':
        return left !== right
      case '>':
      case '>=':
      case '<':
      case '<=': {
        const comparison = this.compareValues(left, right)
        if (typeof comparison === 'undefined') {
          return false
        }

        if (operator === '>') {
          return comparison > 0
        }
        if (operator === '>=') {
          return comparison >= 0
        }
        if (operator === '<') {
          return comparison < 0
        }
        return comparison <= 0
      }
      case 'LIKE': {
        const pattern = String(right)
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
        return new RegExp(`^${pattern}$`).test(String(left ?? ''))
      }
      default:
        return false
    }
  }

  private compareRows(
    sql: string,
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
  ): number {
    const orderMatch = sql.match(/ ORDER BY "([^"]+)" (ASC|DESC)/)
    if (!orderMatch) {
      return 0
    }

    const columnName = orderMatch[1]!
    const direction = orderMatch[2]
    const leftValue = left[columnName]
    const rightValue = right[columnName]
    if (typeof leftValue !== 'number' || typeof rightValue !== 'number') {
      return 0
    }

    return direction === 'DESC' ? rightValue - leftValue : leftValue - rightValue
  }

  private readRowsWindow(sql: string, bindings: readonly unknown[]): { readonly limit?: number, readonly offset: number } {
    const limitMatch = / LIMIT (?:\?(\d*)|(\d+))/.exec(sql)
    const offsetMatch = / OFFSET (?:\?(\d*)|(\d+))/.exec(sql)
    return {
      limit: limitMatch ? this.readWindowValue(sql, bindings, limitMatch, ' LIMIT ') : undefined,
      offset: offsetMatch ? this.readWindowValue(sql, bindings, offsetMatch, ' OFFSET ') : 0,
    }
  }

  private readWindowValue(
    sql: string,
    bindings: readonly unknown[],
    match: RegExpExecArray,
    prefix: string,
  ): number {
    const literal = match[2]
    if (literal) {
      return Number(literal)
    }

    const rawIndex = match[1]
    const bindingIndex = rawIndex
      ? Number(rawIndex) - 1
      : sql.slice(0, match.index + prefix.length).split('?').length - 1
    return Number(bindings[bindingIndex])
  }

  private projectRows(
    sql: string,
    bindings: readonly unknown[],
    rows: readonly Readonly<Record<string, unknown>>[],
  ): Readonly<Record<string, unknown>>[] {
    const rawSelection = sql.match(/^SELECT (.+?) FROM /)?.[1]
    if (!rawSelection || rawSelection === '*') {
      return rows.map(row => ({ ...row }))
    }

    const groupColumns = this.readGroupColumns(sql)
    if (groupColumns.length > 0) {
      const groupedRows = this.projectGroupedRows(sql, bindings, rawSelection, groupColumns, rows)
      if (groupedRows) {
        return groupedRows
      }
    }

    const aggregate = this.projectAggregateRows(rawSelection, rows)
    if (aggregate) {
      return aggregate
    }

    const selections = rawSelection.split(', ').map((selection) => {
      const match = selection.match(/^"([^"]+)"(?: AS "([^"]+)")?$/)
      return match
        ? { column: match[1]!, resultKey: match[2] ?? match[1]! }
        : undefined
    })
    if (selections.some(selection => !selection)) {
      return rows.map(row => ({ ...row }))
    }

    return rows.map((row) => {
      const projected: Record<string, unknown> = {}
      for (const selection of selections) {
        projected[selection!.resultKey] = row[selection!.column]
      }
      return projected
    })
  }

  private readGroupColumns(sql: string): readonly string[] {
    const groupBy = sql.match(/ GROUP BY (.+?)( HAVING| ORDER BY| LIMIT| OFFSET|$)/)?.[1]
    if (!groupBy) {
      return []
    }

    const columns = groupBy.split(', ').map((column) => {
      return column.match(/^"([^"]+)"$/)?.[1]
    })
    return columns.every((column): column is string => Boolean(column))
      ? Object.freeze(columns)
      : []
  }

  private readHavingCountMatcher(sql: string, bindings: readonly unknown[]): ((count: number) => boolean) | undefined {
    const match = sql.match(/ HAVING COUNT\(\*\) (=|!=|<>|>=|>|<=|<) \?(\d*)/)
    if (!match) {
      return undefined
    }

    const operator = match[1]!
    const rawIndex = match[2]
    const bindingIndex = rawIndex ? Number(rawIndex) - 1 : bindings.length - 1
    return count => this.applyPredicate(count, operator, bindings[bindingIndex])
  }

  private createGroupKey(
    row: Readonly<Record<string, unknown>>,
    columns: readonly string[],
  ): string {
    return JSON.stringify(columns.map(column => row[column]))
  }

  private projectGroupedRows(
    sql: string,
    bindings: readonly unknown[],
    rawSelection: string,
    groupColumns: readonly string[],
    rows: readonly Readonly<Record<string, unknown>>[],
  ): Readonly<Record<string, unknown>>[] | undefined {
    const groupedRows = new Map<string, Readonly<Record<string, unknown>>[]>()
    const groupValues = new Map<string, readonly unknown[]>()
    for (const row of rows) {
      const key = this.createGroupKey(row, groupColumns)
      const values = groupValues.get(key) ?? Object.freeze(groupColumns.map(column => row[column]))
      const group = groupedRows.get(key) ?? []
      group.push(row)
      groupedRows.set(key, group)
      groupValues.set(key, values)
    }

    const results: Readonly<Record<string, unknown>>[] = []
    const matchesHaving = this.readHavingCountMatcher(sql, bindings)
    for (const [key, group] of groupedRows) {
      if (matchesHaving && !matchesHaving(group.length)) {
        continue
      }

      const projected: Record<string, unknown> = {}
      const values = groupValues.get(key)
      if (!values) {
        return undefined
      }

      for (let index = 0; index < groupColumns.length; index += 1) {
        projected[groupColumns[index]!] = values[index]
      }

      if (!this.projectAggregateSelections(rawSelection, group, projected, groupColumns)) {
        return undefined
      }

      results.push(projected)
    }

    return results
  }

  private projectAggregateSelections(
    rawSelection: string,
    rows: readonly Readonly<Record<string, unknown>>[],
    target: Record<string, unknown>,
    groupColumns: readonly string[] = [],
  ): boolean {
    for (const selection of rawSelection.split(', ')) {
      const columnSelection = selection.match(/^"([^"]+)"(?: AS "([^"]+)")?$/)
      if (columnSelection) {
        const column = columnSelection[1]!
        const resultKey = columnSelection[2] ?? column
        if (!groupColumns.includes(column)) {
          return false
        }

        target[resultKey] = rows[0]?.[column]
        continue
      }

      const match = selection.match(/^(COUNT|SUM|AVG|MIN|MAX)\((\*|"([^"]+)")\) AS "([^"]+)"$/)
      if (!match) {
        return false
      }

      const aggregate = match[1]
      const column = match[3]
      const alias = match[4]!
      if (aggregate === 'COUNT') {
        target[alias] = rows.length
        continue
      }

      if (!column) {
        return false
      }

      const values = rows.map(row => row[column]).filter((value): value is number => {
        return typeof value === 'number' && !Number.isNaN(value)
      })
      if (values.length === 0) {
        target[alias] = null
        continue
      }

      if (aggregate === 'SUM') {
        target[alias] = values.reduce((sum, value) => sum + value, 0)
        continue
      }

      if (aggregate === 'AVG') {
        target[alias] = values.reduce((sum, value) => sum + value, 0) / values.length
        continue
      }

      target[alias] = aggregate === 'MIN' ? Math.min(...values) : Math.max(...values)
    }

    return true
  }

  private projectAggregateRows(
    rawSelection: string,
    rows: readonly Readonly<Record<string, unknown>>[],
  ): Readonly<Record<string, unknown>>[] | undefined {
    const aggregateRow: Record<string, unknown> = {}
    if (!this.projectAggregateSelections(rawSelection, rows, aggregateRow)) {
      return undefined
    }

    return [aggregateRow]
  }
}

function encodeDependencyValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value))
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function tableDependency(): string {
  return `db:${connectionName}:${tableName}`
}

function userPredicateDependency(userId: number): string {
  return `db:${connectionName}:${tableName}:where:user_id:${encodeDependencyValue(userId)}`
}

function exactUserPredicateDependency(userId: number): string {
  return `db:${connectionName}:${tableName}:where-exact:user_id:${encodeDependencyValue(userId)}`
}

function authorPredicateDependency(authorId: number): string {
  return `db:${connectionName}:${tableName}:where:author_id:${encodeDependencyValue(authorId)}`
}

function exactAuthorPredicateDependency(authorId: number): string {
  return `db:${connectionName}:${tableName}:where-exact:author_id:${encodeDependencyValue(authorId)}`
}

function exactIdPredicateDependency(id: number): string {
  return `db:${connectionName}:${tableName}:where-exact:id:${encodeDependencyValue(id)}`
}

function pivotTableDependency(): string {
  return `db:${connectionName}:post_tags`
}

function pivotPostPredicateDependency(postId: number): string {
  return `db:${connectionName}:post_tags:where:postId:${encodeDependencyValue(postId)}`
}

function tagTableDependency(): string {
  return `db:${connectionName}:tags`
}

function tagPredicateDependency(tagId: number): string {
  return `db:${connectionName}:tags:where:id:${encodeDependencyValue(tagId)}`
}

function authorTableDependency(): string {
  return `db:${connectionName}:authors`
}

function authorIdPredicateDependency(authorId: number): string {
  return `db:${connectionName}:authors:where:id:${encodeDependencyValue(authorId)}`
}

function idRowDependency(id: number): string {
  return `db:${connectionName}:${tableName}:row:id:${encodeDependencyValue(id)}`
}

function createInvalidationDependencies(userId: number): readonly string[] {
  return [
    tableDependency(),
    userPredicateDependency(userId),
    exactUserPredicateDependency(userId),
  ]
}

function createRelationAggregateInvalidationDependencies(authorId: number): readonly string[] {
  return [
    tableDependency(),
    authorPredicateDependency(authorId),
    exactAuthorPredicateDependency(authorId),
  ]
}

function createAuthorInvalidationDependencies(authorId: number): readonly string[] {
  return [
    authorTableDependency(),
    authorIdPredicateDependency(authorId),
  ]
}

function createAuthorInsertInvalidation(row: BenchmarkAuthorRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [authorTableDependency()],
    mutations: [{
      connectionName,
      kind: 'insert',
      predicates: [],
      rows: [row],
      tableName: 'authors',
      values: row,
    }],
  }
}

function createBenchmarkDatabaseContext(): DatabaseContext {
  return {
    model: () => undefined,
  } as unknown as DatabaseContext
}

function createBenchmarkModelDatabaseContext(rows: readonly BenchmarkPostRow[]): DatabaseContext {
  return createDatabase({
    adapter: new BenchmarkModelAdapter(rows),
    dialect: benchmarkModelDialect,
    connectionName,
  })
}

function createBenchmarkRelationDatabaseContext(adapter: BenchmarkModelAdapter): DatabaseContext {
  return createDatabase({
    adapter,
    dialect: benchmarkModelDialect,
    connectionName,
  })
}

function createBenchmarkReturningDatabaseContext(adapter: BenchmarkModelAdapter): DatabaseContext {
  return createDatabase({
    adapter,
    dialect: benchmarkReturningDialect,
    connectionName,
  })
}

function createAuthRequestAccessors(): RealtimeAuthRequestAccessors {
  return {
    appendResponseCookie: async () => {},
    getCookie: async () => undefined,
    getHeader: async () => undefined,
    redirectResponse: async () => {},
  }
}

function createBenchmarkQuery(counters: BenchmarkCounters, versions: Map<number, number>) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.byUser',
    args: schema({
      userId: field.number().required().integer(),
    }),
    access: 'public',
    handler: async ({ args }) => {
      counters.queryExecutions += 1
      recordDatabaseQueryDependencies([
        tableDependency(),
        userPredicateDependency(args.userId),
      ])

      return [{
        id: args.userId,
        user_id: args.userId,
        version: versions.get(args.userId) ?? 0,
      }]
    },
  })
}

function createPatchBenchmarkRows(): BenchmarkPostRow[] {
  return Array.from({ length: patchRowCount }, (_, index) => ({
    id: index + 1,
    title: `Post ${index + 1}`,
    user_id: 1,
  }))
}

function createWidePatchBenchmarkRows(): BenchmarkWidePostRow[] {
  return Array.from({ length: patchRowCount }, (_, index) => ({
    field_1: `field-1-${index + 1}`,
    field_2: `field-2-${index + 1}`,
    field_3: `field-3-${index + 1}`,
    field_4: `field-4-${index + 1}`,
    field_5: `field-5-${index + 1}`,
    field_6: `field-6-${index + 1}`,
    field_7: `field-7-${index + 1}`,
    field_8: `field-8-${index + 1}`,
    field_9: `field-9-${index + 1}`,
    id: index + 1,
    title: `Post ${index + 1}`,
    user_id: 1,
  }))
}

function createPriorityPatchBenchmarkRows(): BenchmarkPostRow[] {
  return Array.from({ length: patchRowCount }, (_, index) => ({
    id: index + 1,
    priority: index + 1,
    title: `Post ${index + 1}`,
    user_id: 1,
  }))
}

function createAggregatePatchBenchmarkRows(): BenchmarkPostRow[] {
  return Array.from({ length: patchRowCount }, (_, index) => ({
    id: index + 1,
    score: 10_000 + index + 1,
    title: `Post ${index + 1}`,
    user_id: 1,
  }))
}

function createRelationAggregateBenchmarkTables(): { authors: BenchmarkAuthorRow[], posts: BenchmarkPostRow[] } {
  return {
    authors: Array.from({ length: patchRowCount }, (_, index) => ({
      id: index + 1,
      name: `Author ${index + 1}`,
    })),
    posts: Array.from({ length: patchRowCount }, (_, index) => ({
      author_id: index + 1,
      id: index + 1,
      score: 10_000 + index + 1,
      title: `Post ${index + 1}`,
      user_id: 1,
    })),
  }
}

function createDuplicateRelationExtremeBenchmarkTables(): {
  duplicateRow: BenchmarkPostRow & { readonly author_id: number, readonly score: number }
  tables: { authors: BenchmarkAuthorRow[], posts: BenchmarkPostRow[] }
} {
  const tables = createRelationAggregateBenchmarkTables()
  const row = tables.posts[50]
  if (!row || typeof row.author_id !== 'number' || typeof row.score !== 'number') {
    throw new Error('Expected benchmark relation aggregate duplicate row to exist.')
  }

  const duplicateRow = {
    author_id: row.author_id,
    id: patchRowCount + 1,
    score: row.score,
    title: `Post ${patchRowCount + 1}`,
    user_id: row.user_id,
  }
  tables.posts.push(duplicateRow)

  return {
    duplicateRow,
    tables,
  }
}

function createBenchmarkRelationAggregatePatchTarget(authorId: number, index: number): QueryPatchTarget {
  return Object.freeze({
    currentValue: 10_000 + authorId,
    index,
    mutationIndexKey: `${connectionName}:${tableName}`,
    patchCapability: 'patchable',
    query: Object.freeze({
      aggregate: Object.freeze({
        column: 'score',
        kind: 'max',
      }),
      connectionName,
      dependencies: [],
      orderBy: [],
      patchable: true,
      predicates: [Object.freeze({
        column: 'author_id',
        operator: '=',
        value: authorId,
      })],
      tableName,
    }),
    resultPath: Object.freeze(['data', index, 'posts_max_score']),
    resultPathKey: `data.${index}.posts_max_score`,
    skipsPatching: false,
  })
}

function createRuntimeRelationAggregateUpsertMutation(
  authorId: number,
  id: number,
  previousScore: number,
  score: number,
): RuntimeDatabaseMutationEvent {
  return Object.freeze({
    connectionName,
    kind: 'upsert',
    predicates: [],
    previousRows: [Object.freeze({
      author_id: authorId,
      id,
      score: previousScore,
      title: `Post ${id}`,
      user_id: 1,
    })],
    rows: [Object.freeze({
      author_id: authorId,
      id,
      score,
      title: `Post ${id}`,
      user_id: 1,
    })],
    tableName,
    values: Object.freeze({
      author_id: authorId,
      id,
      score,
      title: `Post ${id}`,
      user_id: 1,
    }),
  })
}

function createBelongsToManyBenchmarkTables(): {
  post_tags: BenchmarkPostTagRow[]
  posts: BenchmarkPostRow[]
  tags: BenchmarkTagRow[]
} {
  return {
    posts: Array.from({ length: patchRowCount }, (_, index) => ({
      id: index + 1,
      title: `Post ${index + 1}`,
      user_id: 1,
    })),
    post_tags: Array.from({ length: patchRowCount }, (_, index) => ({
      id: index + 1,
      postId: index + 1,
      tagId: index + 1,
      weight: index + 1,
    })),
    tags: Array.from({ length: patchRowCount }, (_, index) => ({
      id: index + 1,
      name: `Tag ${index + 1}`,
    })),
  }
}

function createIdleBenchmarkTransport(): RealtimeClientTransport {
  return {
    async query<TResult>(name: string) {
      return {
        name,
        data: [] as TResult,
        dependencies: [],
        version: 1,
      }
    },
    async mutate<TResult>(name: string) {
      return {
        name,
        data: {} as TResult,
        dependencies: [],
      }
    },
    subscribe() {
      return () => {}
    },
  }
}

function createClientPatchOperations(count: number): readonly BenchmarkPatchOperation[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const rowIndex = index * 10
    return {
      op: 'replace',
      path: [rowIndex, 'title'],
      value: `Updated ${rowIndex + 1}`,
    } satisfies BenchmarkPatchOperation
  }))
}

async function waitForBenchmarkCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 1))
  }

  throw new Error('Benchmark condition was not met.')
}

function cloneRows(rows: readonly BenchmarkPostRow[]): BenchmarkPostRow[] {
  return rows.map(row => ({ ...row }))
}

function readNestedPostTitle(author: Readonly<Record<string, unknown>> | undefined): string {
  const posts = Array.isArray(author?.posts) ? author.posts : []
  const post = posts[0]
  if (!post || typeof post !== 'object' || !('title' in post)) {
    return ''
  }

  const title = (post as Readonly<Record<string, unknown>>).title
  return typeof title === 'string' ? title : ''
}

function readNestedPostCount(author: Readonly<Record<string, unknown>> | undefined): number {
  return Array.isArray(author?.posts) ? author.posts.length : 0
}

function readNestedFeaturedPostTitle(author: Readonly<Record<string, unknown>> | undefined): string {
  const featuredPost = author?.featuredPost
  if (!featuredPost || typeof featuredPost !== 'object' || !('title' in featuredPost)) {
    return ''
  }

  const title = (featuredPost as Readonly<Record<string, unknown>>).title
  return typeof title === 'string' ? title : ''
}

function readNestedAuthorName(post: Readonly<Record<string, unknown>> | undefined): string {
  const author = post?.author
  if (!author || typeof author !== 'object' || !('name' in author)) {
    return ''
  }

  const name = (author as Readonly<Record<string, unknown>>).name
  return typeof name === 'string' ? name : ''
}

function readNestedTagName(post: Readonly<Record<string, unknown>> | undefined): string {
  const tags = Array.isArray(post?.tags) ? post.tags : []
  const tag = tags[0]
  if (!tag || typeof tag !== 'object' || !('name' in tag)) {
    return ''
  }

  const name = (tag as Readonly<Record<string, unknown>>).name
  return typeof name === 'string' ? name : ''
}

function createPatchUpdateInvalidation(row: BenchmarkPostRow, previousTitle: string): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: previousTitle,
        user_id: row.user_id,
      }],
      rows: [row],
      tableName,
      values: {
        title: row.title,
      },
    }],
  }
}

function createPatchScoreUpdateInvalidation(
  row: BenchmarkPostRow,
  previousRow: BenchmarkPostRow,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: {
        score: row.score,
      },
    }],
  }
}

function createPatchTitleOnlyReturningUpdateInvalidation(row: BenchmarkPostRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      rows: [row],
      tableName,
      values: {
        title: row.title,
      },
    }],
  }
}

function createPatchUnknownUpdateInvalidation(row: BenchmarkPostRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      tableName,
    }],
  }
}

function createPatchUnknownInsertInvalidation(userId: number): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(userId),
    mutations: [{
      connectionName,
      kind: 'insert',
      predicates: [],
      tableName,
    }],
  }
}

function createPatchMoveInvalidation(row: BenchmarkPostRow, previousPriority: number): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        priority: previousPriority,
        title: row.title,
        user_id: row.user_id,
      }],
      rows: [row],
      tableName,
      values: {
        priority: row.priority,
      },
    }],
  }
}

function createPatchPredicateOnlyUserUpdateInvalidation(
  row: BenchmarkPostRow,
  previousUserId: number,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      userPredicateDependency(previousUserId),
      userPredicateDependency(row.user_id),
      exactUserPredicateDependency(previousUserId),
      exactUserPredicateDependency(row.user_id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: row.title,
        user_id: previousUserId,
      }],
      tableName,
      values: {
        user_id: row.user_id,
      },
    }],
  }
}

function createPatchPredicateOnlyPriorityUserUpdateInvalidation(
  row: BenchmarkPostRow,
  previousUserId: number,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      userPredicateDependency(previousUserId),
      userPredicateDependency(row.user_id),
      exactUserPredicateDependency(previousUserId),
      exactUserPredicateDependency(row.user_id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        priority: row.priority,
        title: row.title,
        user_id: previousUserId,
      }],
      tableName,
      values: {
        user_id: row.user_id,
      },
    }],
  }
}

function createWidePatchUpdateInvalidation(
  row: BenchmarkWidePostRow,
  previousRow: BenchmarkWidePostRow,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: {
        field_1: row.field_1,
        field_2: row.field_2,
        field_3: row.field_3,
        field_4: row.field_4,
        field_5: row.field_5,
        field_6: row.field_6,
        field_7: row.field_7,
        field_8: row.field_8,
        field_9: row.field_9,
      },
    }],
  }
}

function createPatchMultiUpdateInvalidation(
  rows: readonly BenchmarkPostRow[],
  previousTitles: readonly string[],
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(1),
    mutations: rows.map((row, index) => ({
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: previousTitles[index],
        user_id: row.user_id,
      }],
      rows: [row],
      tableName,
      values: {
        title: 'Updated',
      },
    })),
  }
}

function createPatchInsertInvalidation(row: BenchmarkPostRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'insert',
      predicates: [],
      rows: [row],
      tableName,
      values: row,
    }],
  }
}

function createPatchUpsertInvalidation(
  row: BenchmarkPostRow,
  previousRow: BenchmarkPostRow,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'upsert',
      predicates: [],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: row,
    }],
  }
}

function createPatchMultiUpsertInvalidation(
  rows: readonly BenchmarkPostRow[],
  previousRows: readonly BenchmarkPostRow[],
): BenchmarkPatchInvalidation {
  const firstRow = rows[0]
  return {
    connectionName,
    dependencies: createInvalidationDependencies(firstRow?.user_id ?? 1),
    mutations: [{
      connectionName,
      kind: 'upsert',
      predicates: [],
      previousRows,
      rows,
      tableName,
      values: undefined,
    }],
  }
}

function createRelationAggregateInsertInvalidation(row: BenchmarkPostRow & { readonly author_id: number }): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createRelationAggregateInvalidationDependencies(row.author_id),
    mutations: [{
      connectionName,
      kind: 'insert',
      predicates: [],
      rows: [row],
      tableName,
      values: row,
    }],
  }
}

function createRelationAggregateDeleteInvalidation(row: BenchmarkPostRow & { readonly author_id: number }): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createRelationAggregateInvalidationDependencies(row.author_id),
    mutations: [{
      connectionName,
      kind: 'delete',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      rows: [row],
      tableName,
    }],
  }
}

function createRelationUpdateInvalidation(
  row: BenchmarkPostRow & { readonly author_id: number },
  previousTitle: string,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createRelationAggregateInvalidationDependencies(row.author_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        author_id: row.author_id,
        id: row.id,
        score: row.score,
        title: previousTitle,
        user_id: row.user_id,
      }],
      rows: [row],
      tableName,
      values: {
        title: row.title,
      },
    }],
  }
}

function createRelationAggregateScoreUpdateInvalidation(
  row: BenchmarkPostRow & { readonly author_id: number },
  previousRow: BenchmarkPostRow & { readonly author_id: number },
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createRelationAggregateInvalidationDependencies(row.author_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: {
        score: row.score,
      },
    }],
  }
}

function createRelationAggregateUnknownUpdateInvalidation(
  row: BenchmarkPostRow & { readonly author_id: number },
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createRelationAggregateInvalidationDependencies(row.author_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      tableName,
    }],
  }
}

function createRelationAggregateUpsertInvalidation(
  row: BenchmarkPostRow & { readonly author_id: number },
  previousRow: BenchmarkPostRow & { readonly author_id: number },
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createRelationAggregateInvalidationDependencies(row.author_id),
    mutations: [{
      connectionName,
      kind: 'upsert',
      predicates: [],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: row,
    }],
  }
}

function createRelationParentKeyMoveInvalidation(
  row: BenchmarkPostRow & { readonly author_id: number },
  previousRow: BenchmarkPostRow & { readonly author_id: number },
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      authorPredicateDependency(previousRow.author_id),
      exactAuthorPredicateDependency(previousRow.author_id),
      authorPredicateDependency(row.author_id),
      exactAuthorPredicateDependency(row.author_id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: {
        author_id: row.author_id,
      },
    }],
  }
}

function createBelongsToParentKeyUpdateInvalidation(
  row: BenchmarkPostRow & { readonly author_id: number },
  previousRow: BenchmarkPostRow & { readonly author_id: number },
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: {
        author_id: row.author_id,
      },
    }],
  }
}

function createNullableBelongsToParentKeyUpdateInvalidation(
  row: BenchmarkPostRow & { readonly author_id: number | null },
  previousRow: BenchmarkPostRow & { readonly author_id: number },
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [previousRow],
      rows: [row],
      tableName,
      values: {
        author_id: row.author_id,
      },
    }],
  }
}

function createAuthorUpdateInvalidation(row: BenchmarkAuthorRow, previousName: string): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createAuthorInvalidationDependencies(row.id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        name: previousName,
      }],
      rows: [row],
      tableName: 'authors',
      values: {
        name: row.name,
      },
    }],
  }
}

function createAuthorHiddenUpdateInvalidation(row: BenchmarkAuthorRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createAuthorInvalidationDependencies(row.id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      rows: [row],
      tableName: 'authors',
      values: {
        internal: 'new',
      },
    }],
  }
}

function createBelongsToManyAttachInvalidation(row: BenchmarkPostTagRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      pivotTableDependency(),
      pivotPostPredicateDependency(row.postId),
    ],
    mutations: [{
      connectionName,
      kind: 'insert',
      predicates: [],
      rows: [row],
      tableName: 'post_tags',
      values: row,
    }],
  }
}

function createBelongsToManyPivotUpdateInvalidation(row: BenchmarkPostTagRow, previousWeight: number): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      pivotTableDependency(),
      pivotPostPredicateDependency(row.postId),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        ...row,
        weight: previousWeight,
      }],
      rows: [row],
      tableName: 'post_tags',
      values: {
        weight: row.weight,
      },
    }],
  }
}

function createBelongsToManyRelatedUpdateInvalidation(row: BenchmarkTagRow, previousName: string): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tagTableDependency(),
      tagPredicateDependency(row.id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        name: previousName,
      }],
      rows: [row],
      tableName: 'tags',
      values: {
        name: row.name,
      },
    }],
  }
}

function createBelongsToManyRelatedDeleteInvalidation(row: BenchmarkTagRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tagTableDependency(),
      tagPredicateDependency(row.id),
    ],
    mutations: [{
      connectionName,
      kind: 'delete',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      rows: [row],
      tableName: 'tags',
    }],
  }
}

function createBelongsToManyDetachInvalidation(row: BenchmarkPostTagRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      pivotTableDependency(),
      pivotPostPredicateDependency(row.postId),
    ],
    mutations: [{
      connectionName,
      kind: 'delete',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      rows: [row],
      tableName: 'post_tags',
    }],
  }
}

function createPatchDeleteInvalidation(row: BenchmarkPostRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      ...createInvalidationDependencies(row.user_id),
      exactIdPredicateDependency(row.id),
      idRowDependency(row.id),
    ],
    mutations: [{
      connectionName,
      kind: 'delete',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      rows: [row],
      tableName,
    }],
  }
}

function createPatchUpdateIdInvalidation(row: BenchmarkPostRow, previousTitle: string): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      idRowDependency(row.id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: previousTitle,
        user_id: row.user_id,
      }],
      rows: [row],
      tableName,
      values: {
        title: row.title,
      },
    }],
  }
}

function createPatchPartialRowValueInvalidation(row: BenchmarkPostRow, previousTitle: string): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      idRowDependency(row.id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: previousTitle,
        user_id: row.user_id,
      }],
      rows: [{
        id: row.id,
        user_id: row.user_id,
      }],
      tableName,
      values: {
        title: row.title,
      },
    }],
  }
}

function createPatchPreviousRowValueInvalidation(row: BenchmarkPostRow, previousTitle: string): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: createInvalidationDependencies(row.user_id),
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: previousTitle,
        user_id: row.user_id,
      }],
      tableName,
      values: {
        title: row.title,
      },
    }],
  }
}

function createPatchMoveUserValueInvalidation(
  row: BenchmarkPostRow,
  previousTitle: string,
  previousUserId: number,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      idRowDependency(row.id),
      userPredicateDependency(previousUserId),
      userPredicateDependency(row.user_id),
      exactUserPredicateDependency(previousUserId),
      exactUserPredicateDependency(row.user_id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: previousTitle,
        user_id: previousUserId,
      }],
      rows: [row],
      tableName,
      values: {
        title: row.title,
        user_id: row.user_id,
      },
    }],
  }
}

function createPatchMoveUserPredicateOnlyValueInvalidation(
  row: BenchmarkPostRow,
  previousTitle: string,
  previousUserId: number,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      idRowDependency(row.id),
      userPredicateDependency(previousUserId),
      userPredicateDependency(row.user_id),
      exactUserPredicateDependency(previousUserId),
      exactUserPredicateDependency(row.user_id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        title: previousTitle,
        user_id: previousUserId,
      }],
      tableName,
      values: {
        user_id: row.user_id,
      },
    }],
  }
}

function createPatchMoveAggregateUserValueInvalidation(
  row: BenchmarkPostRow,
  previousUserId: number,
): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      idRowDependency(row.id),
      userPredicateDependency(previousUserId),
      userPredicateDependency(row.user_id),
      exactUserPredicateDependency(previousUserId),
      exactUserPredicateDependency(row.user_id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [{
        id: row.id,
        score: row.score,
        title: row.title,
        user_id: previousUserId,
      }],
      rows: [row],
      tableName,
      values: {
        user_id: row.user_id,
      },
    }],
  }
}

function createPatchIrrelevantScalarUpdateInvalidation(row: BenchmarkPostRow): BenchmarkPatchInvalidation {
  return {
    connectionName,
    dependencies: [
      tableDependency(),
      idRowDependency(row.id),
    ],
    mutations: [{
      connectionName,
      kind: 'update',
      predicates: [{
        column: 'id',
        operator: '=',
        value: row.id,
      }],
      previousRows: [row],
      rows: [{
        ...row,
        archived: true,
      }],
      tableName,
      values: {
        archived: true,
      },
    }],
  }
}

function createPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.patchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })

      return result
    },
  })
}

function createPredicateOnlyPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.predicateOnlyPatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
        userPredicateDependency(2),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: 'in',
          value: [1, 2],
        }],
        result,
        selections: [],
        tableName,
      })

      return result
    },
  })
}

function createWidePatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkWidePostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.widePatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.map(row => ({ ...row }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })

      return result
    },
  })
}

function createSelectedPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.selectedPatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.map(row => ({
        id: row.id,
        title: row.title,
      }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [
          {
            column: 'id',
            resultKey: 'id',
          },
          {
            column: 'title',
            resultKey: 'title',
          },
        ],
        tableName,
      })

      return result
    },
  })
}

function createOrderedPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.orderedPatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [{ column: 'id', direction: 'asc' }],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })

      return result
    },
  })
}

function createOffsetOrderedPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.offsetOrderedPatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.slice(100, 200).map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        limit: 100,
        offset: 100,
        orderBy: [{ column: 'id', direction: 'asc' }],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })

      return result
    },
  })
}

function createPaginatedPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.paginatedPatchRows',
    access: 'public',
    handler: async (): Promise<BenchmarkPaginatedRows> => {
      counters.queryExecutions += 1
      const result = rows.slice(0, 100).map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const meta = {
        currentPage: 1,
        from: result.length === 0 ? null : 1,
        hasMorePages: rows.length > result.length,
        lastPage: Math.max(1, Math.ceil(rows.length / Math.max(1, result.length))),
        pageName: 'page',
        perPage: result.length,
        to: result.length === 0 ? null : result.length,
        total: rows.length,
      }
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        limit: 100,
        offset: 0,
        orderBy: [{ column: 'id', direction: 'asc' }],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [{ column: 'id', direction: 'asc' }],
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: result.length,
          total: rows.length,
        },
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result: meta,
        selections: [],
        tableName,
      })

      return {
        data: result,
        meta,
      }
    },
  })
}

function createPaginationMetaPredicateOnlyBenchmarkQuery(counters: BenchmarkCounters, totalRows: number) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.paginationMetaPredicateOnlyPatch',
    access: 'public',
    handler: async (): Promise<{ readonly meta: BenchmarkPaginatedRows['meta'] }> => {
      counters.queryExecutions += 1
      const perPage = 100
      const meta = {
        currentPage: 1,
        from: totalRows === 0 ? null : 1,
        hasMorePages: totalRows > perPage,
        lastPage: Math.max(1, Math.ceil(totalRows / perPage)),
        pageName: 'page',
        perPage,
        to: totalRows === 0 ? null : Math.min(perPage, totalRows),
        total: totalRows,
      }
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
        userPredicateDependency(2),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [{ column: 'id', direction: 'asc' }],
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage,
          total: totalRows,
        },
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result: meta,
        resultPath: Object.freeze(['meta']),
        selections: [],
        tableName,
      })

      return { meta }
    },
  })
}

function createPaginatedOffsetPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.paginatedOffsetPatchRows',
    access: 'public',
    handler: async (): Promise<BenchmarkPaginatedRows> => {
      counters.queryExecutions += 1
      const perPage = 100
      const currentPage = 2
      const offset = perPage
      const result = rows.slice(offset, offset + perPage).map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const meta = {
        currentPage,
        from: result.length === 0 ? null : offset + 1,
        hasMorePages: rows.length > offset + result.length,
        lastPage: Math.max(1, Math.ceil(rows.length / perPage)),
        pageName: 'page',
        perPage,
        to: result.length === 0 ? null : offset + result.length,
        total: rows.length,
      }
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        limit: perPage,
        offset,
        orderBy: [{ column: 'id', direction: 'asc' }],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [{ column: 'id', direction: 'asc' }],
        pagination: {
          currentPage,
          kind: 'standard',
          pageName: 'page',
          perPage,
          total: rows.length,
        },
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result: meta,
        selections: [],
        tableName,
      })

      return {
        data: result,
        meta,
      }
    },
  })
}

function encodeBenchmarkCursor(values: readonly unknown[]): string {
  return Buffer.from(JSON.stringify({ values }), 'utf8').toString('base64url')
}

function createCursorPaginatedPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.cursorPaginatedPatchRows',
    access: 'public',
    handler: async (): Promise<{
      readonly cursorName: string
      readonly data: readonly BenchmarkPostRow[]
      readonly nextCursor: string | null
      readonly perPage: number
      readonly prevCursor: string | null
    }> => {
      counters.queryExecutions += 1
      const observedRows = rows.slice(0, 101).map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const result = observedRows.slice(0, 100)
      const nextCursor = rows.length > result.length
        ? encodeBenchmarkCursor([result.at(-1)?.id])
        : null
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        cursorRowCount: rows.length,
        cursorRows: observedRows,
        dependencies,
        limit: 100,
        offset: undefined,
        orderBy: [{ column: 'id', direction: 'asc' }],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        resultPath: Object.freeze(['data']),
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [{ column: 'id', direction: 'asc' }],
        pagination: {
          cursorName: 'cursor',
          hasMorePages: nextCursor !== null,
          kind: 'cursor',
          nextCursor,
          perPage: 100,
          prevCursor: null,
          rows: observedRows,
          rowCount: rows.length,
        },
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result: nextCursor,
        resultPath: Object.freeze(['nextCursor']),
        selections: [],
        tableName,
      })

      return {
        cursorName: 'cursor',
        data: result,
        nextCursor,
        perPage: 100,
        prevCursor: null,
      }
    },
  })
}

function createCursorPaginationPredicateOnlyBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.cursorPaginationPredicateOnlyPatch',
    access: 'public',
    handler: async (): Promise<string | null> => {
      counters.queryExecutions += 1
      const perPage = 100
      const observedRows = rows.slice(0, perPage + 1).map(row => ({
        id: row.id,
        priority: row.priority,
        title: row.title,
        user_id: row.user_id,
      }))
      const visibleRows = observedRows.slice(0, perPage)
      const nextCursor = rows.length > visibleRows.length
        ? encodeBenchmarkCursor([visibleRows.at(-1)?.priority])
        : null
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
        userPredicateDependency(2),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        pagination: {
          cursorName: 'cursor',
          hasMorePages: nextCursor !== null,
          kind: 'cursor',
          nextCursor,
          perPage,
          prevCursor: null,
          rows: observedRows,
          rowCount: rows.length,
        },
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result: nextCursor,
        selections: [],
        tableName,
      })

      return nextCursor
    },
  })
}

function createModelPaginatedJsonPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedJsonPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .paginateJson(100, 1) as BenchmarkPaginatedRows
    },
  })
}

function createModelPaginatedOffsetJsonPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedOffsetJsonPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .paginateJson(100, 2) as BenchmarkPaginatedRows
    },
  })
}

function createModelSimplePaginatedJsonPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelSimplePaginatedJsonPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkSimplePaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .simplePaginateJson(100, 1) as BenchmarkSimplePaginatedRows
    },
  })
}

function createModelSimplePaginatedOffsetJsonPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelSimplePaginatedOffsetJsonPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkSimplePaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .simplePaginateJson(100, 2) as BenchmarkSimplePaginatedRows
    },
  })
}

function createModelCursorPaginatedJsonPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelCursorPaginatedJsonPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkCursorPaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .cursorPaginateJson(100) as BenchmarkCursorPaginatedRows
    },
  })
}

function createModelPaginatedPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedEntityPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<unknown> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .paginate(100, 1)
    },
  })
}

function createModelWhereInPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelWhereInPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly object[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .whereIn('user_id', [1, 2])
        .orderBy('id', 'asc')
        .get()
    },
  })
}

function createModelDistinctFallbackBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelDistinctFallbackRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .distinct()
        .getJson()
    },
  })
}

function createTableHavingGroupedCountPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableHavingGroupedCountPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectCount('total')
        .groupBy('user_id')
        .having('count(*)', '>', 1)
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableRedundantHavingGroupedCountPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableRedundantHavingGroupedCountPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectCount('total')
        .groupBy('user_id')
        .having('count(*)', '>=', 1)
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableGroupedCountPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableGroupedCountPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectCount('total')
        .groupBy('user_id')
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableGroupedSumPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableGroupedSumPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectSum('score_total', 'score')
        .groupBy('user_id')
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableHavingGroupedSumPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableHavingGroupedSumPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectSum('score_total', 'score')
        .groupBy('user_id')
        .having('count(*)', '>', 1)
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableHavingGroupedAveragePatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableHavingGroupedAveragePatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectAvg('average_score', 'score')
        .groupBy('user_id')
        .having('count(*)', '>', 1)
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableGroupedMaxPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableGroupedMaxPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectMax('best_score', 'score')
        .groupBy('user_id')
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableHavingGroupedMaxPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableHavingGroupedMaxPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectMax('best_score', 'score')
        .groupBy('user_id')
        .having('count(*)', '>', 1)
        .orderBy('user_id')
        .get()
    },
  })
}

function createTableHavingGroupedMinPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })

  return defineRealtimeQuery({
    name: 'benchmark.posts.tableHavingGroupedMinPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .table(posts)
        .select('user_id')
        .addSelectMin('lowest_score', 'score')
        .groupBy('user_id')
        .having('count(*)', '>', 1)
        .orderBy('user_id')
        .get()
    },
  })
}

function createModelCursorPaginatedPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelCursorPaginatedEntityPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<CursorPaginatedResult<object>> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .cursorPaginate(100)
    },
  })
}

function createModelPaginatedOffsetPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedOffsetEntityPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<unknown> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .paginate(100, 2)
    },
  })
}

function createModelSimplePaginatedOffsetPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelSimplePaginatedOffsetEntityPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<SimplePaginatedResult<object>> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .simplePaginate(100, 2)
    },
  })
}

function createTableSolePatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tableSolePatchRow',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPostRow> => {
      counters.queryExecutions += 1
      return await context
        .table('posts')
        .where('id', 1)
        .sole<BenchmarkPostRow>()
    },
  })
}

function createTableFirstPatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tableFirstPatchRow',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPostRow | undefined> => {
      counters.queryExecutions += 1
      return await context
        .table('posts')
        .where('id', 1)
        .first<BenchmarkPostRow>()
    },
  })
}

function createTableConstrainedFirstPatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tableConstrainedFirstPatchRow',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPostRow | undefined> => {
      counters.queryExecutions += 1
      return await context
        .table('posts')
        .where('id', 1)
        .where('user_id', 1)
        .first<BenchmarkPostRow>()
    },
  })
}

function createTableValuePatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tableValuePatchScalar',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      const title = await context
        .table('posts')
        .where('id', 1)
        .value('title')
      return typeof title === 'string' ? title : undefined
    },
  })
}

function createTableConstrainedValuePatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tableConstrainedValuePatchScalar',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      const title = await context
        .table('posts')
        .where('id', 1)
        .where('user_id', 1)
        .value('title')
      return typeof title === 'string' ? title : undefined
    },
  })
}

function createTablePluckPatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tablePluckPatchScalarList',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      return await context
        .table('posts')
        .where('user_id', 1)
        .orderBy('id')
        .pluck('title')
    },
  })
}

function createPriorityPluckPatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.priorityPluckPatchScalarList',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      return await context
        .table('posts')
        .where('user_id', 1)
        .orderBy('priority')
        .pluck('title')
    },
  })
}

function createTableExistsPatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tableExistsPatchBoolean',
    access: 'public',
    handler: async ({ db: context }): Promise<boolean> => {
      counters.queryExecutions += 1
      return await context
        .table('posts')
        .where('user_id', 1)
        .exists()
    },
  })
}

function createTableDoesntExistPatchBenchmarkQuery(counters: BenchmarkCounters) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.tableDoesntExistPatchBoolean',
    access: 'public',
    handler: async ({ db: context }): Promise<boolean> => {
      counters.queryExecutions += 1
      return await context
        .table('posts')
        .where('user_id', 1)
        .doesntExist()
    },
  })
}

function createModelExistsPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelExistsPatchBoolean',
    access: 'public',
    handler: async ({ db: context }): Promise<boolean> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .exists()
    },
  })
}

function createModelDoesntExistPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelDoesntExistPatchBoolean',
    access: 'public',
    handler: async ({ db: context }): Promise<boolean> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .doesntExist()
    },
  })
}

function createModelValuePatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelValuePatchScalar',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('id', 1)
        .value('title')
    },
  })
}

function createModelPluckPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPluckPatchScalarList',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id')
        .pluck('title')
    },
  })
}

function createModelPriorityPluckPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPriorityPluckPatchScalarList',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('priority')
        .pluck('title')
    },
  })
}

function createModelPriorityOrderedPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPriorityOrderedPatchRows',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly object[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('priority')
        .get()
    },
  })
}

function createModelAggregatePatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelAggregatePatch',
    access: 'public',
    handler: async ({ db: context }) => {
      counters.queryExecutions += 1
      const posts = () => context.model(Post).query().where('user_id', 1)
      return {
        count: await posts().count(),
        scoreAverage: await posts().avg('score'),
        scoreMaximum: await posts().max('score'),
        scoreMinimum: await posts().min('score'),
        scoreSum: await posts().sum('score'),
      }
    },
  })
}

function createModelCountAggregatePatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelCountAggregatePatch',
    args: schema({
      userId: field.number().required().integer(),
    }),
    access: 'public',
    handler: async ({ args, db: context }) => {
      counters.queryExecutions += 1
      return await context.model(Post).query().where('user_id', args.userId).count()
    },
  })
}

function createModelPaginatedRelationAggregatePatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedRelationAggregatePatch',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPaginatedAuthorAggregates> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .withSum('posts', 'score')
        .withAvg('posts', 'score')
        .withMin('posts', 'score')
        .withMax('posts', 'score')
        .orderBy('id', 'asc')
        .paginateJson(100, 1) as BenchmarkPaginatedAuthorAggregates
    },
  })
}

function createModelPaginatedRelationExtremeAggregatePatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedRelationExtremeAggregatePatch',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPaginatedAuthorAggregates> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .withMax('posts', 'score')
        .orderBy('id', 'asc')
        .paginateJson(100, 1) as BenchmarkPaginatedAuthorAggregates
    },
  })
}

function createModelHasManyRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelHasManyRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('posts')
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelOrderedHasManyRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelOrderedHasManyRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('posts', relationQuery => relationQuery.orderBy('id'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelConstrainedHasManyRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelConstrainedHasManyRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('posts', relationQuery => relationQuery.where('title', 'Published').orderBy('id'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelNotEqualHasManyRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelNotEqualHasManyRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('posts', relationQuery => relationQuery.where('title', '!=', 'Draft').orderBy('id'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelInHasManyRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelInHasManyRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('posts', relationQuery => relationQuery.whereIn('title', ['Post 500', 'Featured']).orderBy('id'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelHasOneRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelHasOneRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('featuredPost')
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelOrderedHasOneRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelOrderedHasOneRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('featuredPost', relationQuery => relationQuery.orderBy('id', 'desc'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelConstrainedHasOneRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelConstrainedHasOneRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('featuredPost', relationQuery => relationQuery.where('title', 'Published').orderBy('id', 'desc'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelRangeHasOneRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelRangeHasOneRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('featuredPost', relationQuery => relationQuery.where('score', '>', 20_000).orderBy('id'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelNotInHasOneRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Author } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelNotInHasOneRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Author)
        .query()
        .with('featuredPost', relationQuery => relationQuery.whereNotIn('title', ['Draft']).orderBy('id'))
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelBelongsToRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Post } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelBelongsToRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .with('author')
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelPaginatedBelongsToRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Post } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedBelongsToRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .with('author')
        .orderBy('id', 'asc')
        .paginateJson(100, 1) as unknown as BenchmarkPaginatedRows
    },
  })
}

function createModelPaginatedOffsetBelongsToRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Post } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelPaginatedOffsetBelongsToRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .with('author')
        .orderBy('id', 'asc')
        .paginateJson(100, 2) as unknown as BenchmarkPaginatedRows
    },
  })
}

function createModelSimplePaginatedBelongsToRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Post } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelSimplePaginatedBelongsToRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkSimplePaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .with('author')
        .orderBy('id', 'asc')
        .simplePaginateJson(100, 1) as unknown as BenchmarkSimplePaginatedRows
    },
  })
}

function createModelCursorPaginatedBelongsToRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Post } = createBenchmarkAuthorPostModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelCursorPaginatedBelongsToRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkCursorPaginatedRows> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .with('author')
        .orderBy('id', 'asc')
        .cursorPaginateJson(100) as unknown as BenchmarkCursorPaginatedRows
    },
  })
}

function createModelBelongsToManyRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Post } = createBenchmarkPostTagModels()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelBelongsToManyRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .with('tags')
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelBelongsToManyWeightOrderedRelationPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const { Post } = createBenchmarkPostTagModels('weight')

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelBelongsToManyWeightOrderedRelationPatch',
    access: 'public',
    handler: async ({ db: context }): Promise<readonly Readonly<Record<string, unknown>>[]> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .with('tags')
        .orderBy('id', 'asc')
        .getJson()
    },
  })
}

function createModelFirstPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelFirstPatchRow',
    access: 'public',
    handler: async ({ db: context }): Promise<unknown> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .first()
    },
  })
}

function createModelFirstJsonPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelFirstJsonPatchRow',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPostRow | undefined> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('user_id', 1)
        .orderBy('id', 'asc')
        .firstJson() as BenchmarkPostRow | undefined
    },
  })
}

function createModelSolePatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelSolePatchRow',
    access: 'public',
    handler: async ({ db: context }): Promise<unknown> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('id', 1)
        .sole()
    },
  })
}

function createModelSoleJsonPatchBenchmarkQuery(counters: BenchmarkCounters) {
  const Post = createBenchmarkPostModel()

  return defineRealtimeQuery({
    name: 'benchmark.posts.modelSoleJsonPatchRow',
    access: 'public',
    handler: async ({ db: context }): Promise<BenchmarkPostRow> => {
      counters.queryExecutions += 1
      return await context
        .model(Post)
        .query()
        .where('id', 1)
        .soleJson() as BenchmarkPostRow
    },
  })
}

function createBenchmarkPostModel() {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    priority: column.integer(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })
  return defineModel(posts)
}

function createBenchmarkAuthorPostModels() {
  const posts = defineGeneratedTable('posts', {
    author_id: column.integer(),
    id: column.id(),
    score: column.integer(),
    title: column.string(),
    user_id: column.integer(),
  })
  const authors = defineGeneratedTable('authors', {
    id: column.id(),
    name: column.string(),
  })
  const RelatedAuthor = defineModel(authors)
  const Post = defineModel(posts, {
    relations: {
      author: belongsTo(() => RelatedAuthor, 'author_id'),
    },
  })
  const Author = defineModel(authors, {
    relations: {
      featuredPost: hasOne(() => Post, 'author_id'),
      posts: hasMany(() => Post, 'author_id'),
    },
  })
  return { Author, Post }
}

function createBenchmarkPostTagModels(pivotOrderColumn: 'id' | 'weight' = 'id') {
  const posts = defineGeneratedTable('posts', {
    id: column.id(),
    title: column.string(),
    user_id: column.integer(),
  })
  const tags = defineGeneratedTable('tags', {
    id: column.id(),
    name: column.string(),
  })
  const postTags = defineGeneratedTable('post_tags', {
    id: column.id(),
    postId: column.integer(),
    tagId: column.integer(),
    weight: column.integer(),
  })
  const Tag = defineModel(tags)
  const Post = defineModel(posts, {
    relations: {
      tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId').withPivot('id', 'weight').orderByPivot(pivotOrderColumn),
    },
  })
  return { Post, Tag }
}

function createPriorityOrderedPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.priorityOrderedPatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.map(row => ({
        id: row.id,
        priority: row.priority,
        title: row.title,
        user_id: row.user_id,
      }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [{ column: 'priority', direction: 'asc' }],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })

      return result
    },
  })
}

function createWrapperPatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.wrapperPatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const result = rows.map(row => ({
        id: row.id,
        title: row.title,
        user_id: row.user_id,
      }))
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates: [{
          column: 'user_id',
          operator: '=',
          value: 1,
        }],
        result,
        selections: [],
        tableName,
      })

      return {
        primary: result,
        secondary: result,
        tertiary: result,
      }
    },
  })
}

function createAggregatePatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.aggregatePatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const count = rows.length
      const scores = rows.map(row => row.score ?? 0)
      const scoreSum = scores.reduce((sum, score) => sum + score, 0)
      const scoreAverage = count === 0 ? null : scoreSum / count
      const scoreMinimum = count === 0 ? null : Math.min(...scores)
      const scoreMaximum = count === 0 ? null : Math.max(...scores)
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      const predicates = [{
        column: 'user_id',
        operator: '=' as const,
        value: 1,
      }]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        aggregate: { kind: 'count' },
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates,
        result: count,
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        aggregate: { column: 'score', kind: 'sum' },
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates,
        result: scoreSum,
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        aggregate: { column: 'score', count, kind: 'avg', sum: scoreSum },
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates,
        result: scoreAverage,
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        aggregate: { column: 'score', kind: 'min' },
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates,
        result: scoreMinimum,
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        aggregate: { column: 'score', kind: 'max' },
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates,
        result: scoreMaximum,
        selections: [],
        tableName,
      })

      return {
        count,
        scoreAverage,
        scoreMaximum,
        scoreMinimum,
        scoreSum,
      }
    },
  })
}

function createAmbiguousAggregatePatchBenchmarkQuery(counters: BenchmarkCounters, rows: readonly BenchmarkPostRow[]) {
  return defineRealtimeQuery({
    name: 'benchmark.posts.ambiguousAggregatePatchRows',
    access: 'public',
    handler: async () => {
      counters.queryExecutions += 1
      const count = rows.length
      const maximum = rows.reduce((max, row) => Math.max(max, row.id), 0)
      const dependencies = [
        tableDependency(),
        userPredicateDependency(1),
      ]
      const predicates = [{
        column: 'user_id',
        operator: '=' as const,
        value: 1,
      }]
      recordDatabaseQueryDependencies(dependencies)
      recordDatabaseQueryObservation({
        aggregate: { kind: 'count' },
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates,
        result: count,
        selections: [],
        tableName,
      })
      recordDatabaseQueryObservation({
        aggregate: { column: 'id', kind: 'max' },
        connectionName,
        dependencies,
        orderBy: [],
        patchable: true,
        predicates,
        result: maximum,
        selections: [],
        tableName,
      })

      return {
        count,
        maximum,
      }
    },
  })
}

function captureMetrics(
  scenario: string,
  startedAt: number,
  counters: BenchmarkCounters,
): BenchmarkMetrics {
  return {
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    emittedSnapshots: counters.emittedSnapshots,
    queryExecutions: counters.queryExecutions,
    scenario,
    sharedQueries: sharedQueryCount,
    subscriptions: subscriptionCount,
  }
}

async function createBenchmarkSubscriptions(
  counters: BenchmarkCounters,
  versions: Map<number, number>,
): Promise<void> {
  const query = createBenchmarkQuery(counters, versions)
  await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
    await subscribeRealtimeQuery(query, { userId: index % sharedQueryCount }, {
      onData: () => {
        counters.emittedSnapshots += 1
      },
    })
  }))
}

afterEach(() => {
  resetRealtimeClientRuntime()
  resetRealtimeRuntime()
  resetDatabaseDependencyInvalidationListeners()
  resetDB()
})

describe('@holo-js/realtime invalidation benchmark', () => {
  it('measures client canonical query store fanout without duplicate transport subscriptions', () => {
    let transportQueries = 0
    let transportSubscriptions = 0
    let emittedSnapshots = 0
    const listenerCount = 100
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.clientCanonicalStoreFanout',
      access: 'public',
      handler: async () => createPatchBenchmarkRows(),
    })
    const transport: RealtimeClientTransport = {
      async query<TResult>(name: string) {
        transportQueries += 1

        return {
          name,
          data: createPatchBenchmarkRows() as TResult,
          dependencies: [tableDependency()],
          version: 1,
        }
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe<TResult>(
        name: string,
        _args: Record<string, unknown>,
        listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
      ) {
        transportSubscriptions += 1
        listener({
          name,
          data: createPatchBenchmarkRows() as TResult,
          dependencies: [tableDependency()],
          version: 2,
        })

        return () => {}
      },
    }
    configureRealtimeClientTransport(transport)

    const setupStartedAt = performance.now()
    const stores = Array.from({ length: listenerCount }, () => getRealtimeQueryStore(query, {
      filters: ['recent', 'featured'],
      userId: 1,
    } as never))
    const store = stores[0]
    if (!store) {
      throw new Error('Expected benchmark query store to be created.')
    }
    const unsubscribers = stores.map(currentStore => currentStore.subscribe(() => {
      emittedSnapshots += 1
    }))
    for (const currentStore of stores) {
      currentStore.connect()
    }
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    expect(stores.every(currentStore => currentStore === store)).toBe(true)
    expect(store.snapshot?.data).toHaveLength(patchRowCount)
    expect(transportQueries).toBe(1)
    expect(transportSubscriptions).toBe(1)
    expect(emittedSnapshots).toBe(listenerCount)

    for (const unsubscribe of unsubscribers) {
      unsubscribe()
    }

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client canonical query store fanout',
      metrics: {
        emittedSnapshots,
        listenerCount,
        setupDurationMs,
        sharedStores: new Set(stores).size,
        transportQueries,
        transportSubscriptions,
      },
    }))
  })

  it('measures client runtime reset cleanup for a shared live query store', () => {
    let transportQueries = 0
    let transportSubscriptions = 0
    let transportUnsubscriptions = 0
    let emittedSnapshots = 0
    const listenerCount = 100
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.clientResetCleanup',
      access: 'public',
      handler: async () => createPatchBenchmarkRows(),
    })
    const transport: RealtimeClientTransport = {
      async query<TResult>(name: string) {
        transportQueries += 1

        return {
          name,
          data: createPatchBenchmarkRows() as TResult,
          dependencies: [tableDependency()],
          version: 1,
        }
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe<TResult>(name: string, _args: Record<string, unknown>, listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void) {
        transportSubscriptions += 1
        listener({
          name,
          data: createPatchBenchmarkRows() as TResult,
          dependencies: [tableDependency()],
          version: 2,
        })

        return () => {
          transportUnsubscriptions += 1
        }
      },
    }
    configureRealtimeClientTransport(transport)

    const stores = Array.from({ length: listenerCount }, () => getRealtimeQueryStore(query, {}))
    const unsubscribers = stores.map(store => store.subscribe(() => {
      emittedSnapshots += 1
    }))
    for (const store of stores) {
      store.connect()
    }

    const resetStartedAt = performance.now()
    resetRealtimeClientRuntime()
    const resetDurationMs = Number((performance.now() - resetStartedAt).toFixed(3))
    for (const store of stores) {
      store.connect()
    }
    const staleUnsubscribers = stores.map(store => store.subscribe(() => {
      emittedSnapshots += 1
    }))
    for (const unsubscribe of unsubscribers) {
      unsubscribe()
    }
    for (const unsubscribe of staleUnsubscribers) {
      unsubscribe()
    }

    expect(new Set(stores).size).toBe(1)
    expect(transportQueries).toBe(1)
    expect(transportSubscriptions).toBe(1)
    expect(transportUnsubscriptions).toBe(1)
    expect(emittedSnapshots).toBe(listenerCount)
    expect(realtimeClientInternals.getRealtimeClientState().stores.size).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client reset shared store cleanup',
      metrics: {
        emittedSnapshots,
        listenerCount,
        resetDurationMs,
        sharedStores: new Set(stores).size,
        transportQueries,
        transportSubscriptions,
        transportUnsubscriptions,
      },
    }))
  })

  it('measures client compact merge patch application with structural sharing', () => {
    const rows = createPatchBenchmarkRows().map(row => ({
      id: row.id,
      title: row.title,
      user_id: row.user_id,
    }))
    const snapshot = {
      name: 'benchmark.posts.clientPatchRows',
      data: rows,
      dependencies: [],
      version: 1,
    }
    const previousRow = snapshot.data[499]
    if (!previousRow) {
      throw new Error('Expected benchmark patch row to exist.')
    }

    const noopStartedAt = performance.now()
    const noopPatched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [{
        op: 'merge',
        path: [499],
        fields: {
          id: previousRow.id,
          title: previousRow.title,
          user_id: previousRow.user_id,
        },
      }],
      version: 2,
    })
    const noopPatchDurationMs = Number((performance.now() - noopStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patched = realtimeClientInternals.applyWireSnapshotPatch(noopPatched, {
      operations: [{
        op: 'merge',
        path: [499],
        fields: {
          title: 'Updated 500',
        },
      }],
      version: 3,
    })
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(noopPatched.data).toBe(snapshot.data)
    expect(noopPatched.version).toBe(2)
    expect(patched.data).not.toBe(noopPatched.data)
    expect(patched.data[498]).toBe(noopPatched.data[498])
    expect(patched.data[499]).not.toBe(noopPatched.data[499])
    expect(patched.data[500]).toBe(noopPatched.data[500])
    expect(patched.data[499]).toEqual({
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    })

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client compact merge patch',
      metrics: {
        noopPatchDurationMs,
        patchDurationMs,
        patchRows: patchRowCount,
        preservedNextRow: patched.data[500] === noopPatched.data[500],
        preservedPreviousRow: patched.data[498] === noopPatched.data[498],
        reusedNoopData: noopPatched.data === snapshot.data,
      },
    }))
  })

  it('measures client compact splice patch application with structural sharing', () => {
    const rows = createPatchBenchmarkRows().map(row => ({
      id: row.id,
      title: row.title,
      user_id: row.user_id,
    }))
    const snapshot = {
      name: 'benchmark.posts.clientSplicePatchRows',
      data: rows,
      dependencies: [],
      version: 1,
    }
    const previousRow = snapshot.data[499]
    if (!previousRow) {
      throw new Error('Expected benchmark splice patch row to exist.')
    }

    const noopStartedAt = performance.now()
    const noopPatched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [{
        op: 'splice',
        path: [],
        index: 499,
        deleteCount: 1,
        values: [{
          id: previousRow.id,
          title: previousRow.title,
          user_id: previousRow.user_id,
        }],
      }],
      version: 2,
    })
    const noopPatchDurationMs = Number((performance.now() - noopStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patched = realtimeClientInternals.applyWireSnapshotPatch(noopPatched, {
      operations: [{
        op: 'splice',
        path: [],
        index: 499,
        deleteCount: 1,
        values: [
          {
            id: previousRow.id,
            title: previousRow.title,
            user_id: previousRow.user_id,
          },
          {
            id: 10_001,
            title: 'Inserted by client splice',
            user_id: 1,
          },
        ],
      }],
      version: 3,
    })
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(noopPatched.data).toBe(snapshot.data)
    expect(noopPatched.version).toBe(2)
    expect(patched.data).not.toBe(noopPatched.data)
    expect(patched.data).toHaveLength(noopPatched.data.length + 1)
    expect(patched.data[498]).toBe(noopPatched.data[498])
    expect(patched.data[499]).toBe(noopPatched.data[499])
    expect(patched.data[500]).toEqual({
      id: 10_001,
      title: 'Inserted by client splice',
      user_id: 1,
    })
    expect(patched.data[501]).toBe(noopPatched.data[500])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client compact splice patch',
      metrics: {
        insertedRows: 1,
        noopPatchDurationMs,
        patchDurationMs,
        patchRows: patchRowCount,
        preservedEquivalentReplacement: patched.data[499] === noopPatched.data[499],
        preservedNextRow: patched.data[501] === noopPatched.data[500],
        preservedPreviousRow: patched.data[498] === noopPatched.data[498],
        reusedNoopData: noopPatched.data === snapshot.data,
      },
    }))
  })

  it('measures client metadata-only patch updates without listener fanout', () => {
    const listenerCount = 100
    const rows = createPatchBenchmarkRows()
    const transport: RealtimeClientTransport = {
      async query<TResult>(name: string) {
        return {
          name,
          data: rows as TResult,
          dependencies: [tableDependency()],
          version: 1,
        }
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        return () => {}
      },
    }
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostRow[]>(
      'benchmark.posts.clientMetadataPatch',
      {},
      transport,
    )
    let emittedSnapshots = 0
    const unsubscribers = Array.from({ length: listenerCount }, () => store.subscribe(() => {
      emittedSnapshots += 1
    }))
    store.setSnapshot({
      name: 'benchmark.posts.clientMetadataPatch',
      data: rows,
      dependencies: [tableDependency()],
      version: 1,
    })
    const currentData = store.snapshot?.data
    if (!store.snapshot || !currentData) {
      throw new Error('Expected benchmark metadata patch store snapshot to be initialized.')
    }

    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot, {
      dependencies: [tableDependency(), userPredicateDependency(1)],
      operations: [],
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(emittedSnapshots).toBe(listenerCount)
    expect(store.snapshot?.data).toBe(currentData)
    expect(store.snapshot?.dependencies).toEqual([tableDependency(), userPredicateDependency(1)])
    expect(store.snapshot?.version).toBe(2)

    for (const unsubscribe of unsubscribers) {
      unsubscribe()
    }

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client metadata-only patch',
      metrics: {
        emittedSnapshots,
        listenerCount,
        patchDurationMs,
        patchOperations: 0,
        preservedData: store.snapshot?.data === currentData,
      },
    }))
  })

  it('measures invalidation work across many filtered subscriptions', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const versions = new Map<number, number>()

    const setupStartedAt = performance.now()
    await createBenchmarkSubscriptions(counters, versions)
    const setupMetrics = captureMetrics('setup', setupStartedAt, counters)
    expect(counters.queryExecutions).toBe(sharedQueryCount)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(realtimeRuntimeInternals.getRuntimeState().queryEntries.size).toBe(sharedQueryCount)
    expect(realtimeRuntimeInternals.getRuntimeState().dependencySubscribers.get(tableDependency())?.size).toBe(sharedQueryCount)
    expect(realtimeRuntimeInternals.getRuntimeState().dependencySubscribers.get(userPredicateDependency(42))?.size).toBe(1)
    expect(realtimeRuntimeInternals.getRuntimeState().tableBroadSubscribers.get(tableDependency())?.size ?? 0).toBe(0)
    expect(realtimeRuntimeInternals.getRuntimeState().tablePredicateColumnSubscribers.get(tableDependency())?.get('user_id')?.size).toBe(sharedQueryCount)
    expect(realtimeRuntimeInternals.getRuntimeState().tablePredicateValueSubscribers.get(tableDependency())?.get('user_id')?.get(encodeDependencyValue(42))?.size).toBe(1)

    const unrelatedStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: createInvalidationDependencies(sharedQueryCount + 1),
    })
    const unrelatedMetrics = captureMetrics('unrelated-exact-write', unrelatedStartedAt, counters)
    expect(counters.queryExecutions).toBe(sharedQueryCount)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)

    versions.set(42, 1)
    const matchingStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: createInvalidationDependencies(42),
    })
    const matchingMetrics = captureMetrics('matching-exact-write', matchingStartedAt, counters)
    expect(counters.queryExecutions).toBe(sharedQueryCount + 1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount + subscriptionCount / sharedQueryCount)

    const burstUserIds = Array.from({ length: 10 }, (_, index) => index)
    for (const userId of burstUserIds) {
      versions.set(userId, 1)
    }
    const burstStartedAt = performance.now()
    await Promise.all(burstUserIds.map(async (userId) => {
      await realtimeRuntimeInternals.handleBatchedDatabaseInvalidation({
        connectionName,
        dependencies: createInvalidationDependencies(userId),
      })
    }))
    const burstMetrics = captureMetrics('batched-matching-exact-writes', burstStartedAt, counters)
    expect(counters.queryExecutions).toBe(sharedQueryCount + 1 + burstUserIds.length)
    expect(counters.emittedSnapshots).toBe(subscriptionCount + (subscriptionCount / sharedQueryCount) * (1 + burstUserIds.length))

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime invalidation',
      metrics: [
        setupMetrics,
        unrelatedMetrics,
        matchingMetrics,
        burstMetrics,
      ],
    }))
  })

  it('measures concurrent same-query subscription fanout with one initial execution', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    let releaseInitialQuery: (() => void) | undefined
    const initialQueryGate = new Promise<void>((resolve) => {
      releaseInitialQuery = resolve
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.concurrentFanout',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        recordDatabaseQueryDependencies([tableDependency()])
        await initialQueryGate

        return createPatchBenchmarkRows()
      },
    })

    const setupStartedAt = performance.now()
    const subscriptionsPromise = Promise.all(Array.from({ length: subscriptionCount }, async () => {
      return await subscribeRealtimeQuery(query, {}, {
        onData: () => {
          counters.emittedSnapshots += 1
        },
      })
    }))

    await waitForBenchmarkCondition(() => counters.queryExecutions === 1)
    expect(realtimeRuntimeInternals.getRuntimeState().queryEntries.size).toBe(1)
    releaseInitialQuery?.()
    const subscriptions = await subscriptionsPromise
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    expect(subscriptions).toHaveLength(subscriptionCount)
    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(realtimeRuntimeInternals.getRuntimeState().queryEntries.size).toBe(1)
    expect(realtimeRuntimeInternals.getRuntimeState().dependencySubscribers.get(tableDependency())?.size).toBe(1)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime concurrent same-query subscription fanout',
      metrics: {
        emittedSnapshots: counters.emittedSnapshots,
        queryEntries: realtimeRuntimeInternals.getRuntimeState().queryEntries.size,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('keeps broad table subscriptions eligible for exact predicate invalidations', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    let version = 0
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.all',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        recordDatabaseQueryDependencies([tableDependency()])

        return [{ version }]
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: () => {
        counters.emittedSnapshots += 1
      },
    })
    expect(realtimeRuntimeInternals.getRuntimeState().tableBroadSubscribers.get(tableDependency())?.size).toBe(1)

    version = 1
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: createInvalidationDependencies(42),
    })

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(2)
  })

  it('skips broad not-equal subscriptions contradicted by exact invalidations', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    let version = 0
    const dependencies = [tableDependency()]
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.notEqual',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        recordDatabaseQueryDependencies(dependencies)
        const result = [{ version }]
        recordDatabaseQueryObservation({
          connectionName,
          dependencies,
          orderBy: [],
          patchable: true,
          predicates: [{
            column: 'user_id',
            operator: '!=',
            value: 1,
          }],
          result,
          selections: [],
          tableName,
        })

        return result
      },
    })

    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, {
        onData: () => {
          counters.emittedSnapshots += 1
        },
      })
    }))
    expect(realtimeRuntimeInternals.getRuntimeState().tableBroadSubscribers.get(tableDependency())?.size).toBe(1)

    const contradictedStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: createInvalidationDependencies(1),
    })
    const contradictedDurationMs = Number((performance.now() - contradictedStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)

    version = 1
    const matchingStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: createInvalidationDependencies(2),
    })
    const matchingDurationMs = Number((performance.now() - matchingStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime not-equal exact invalidation filtering',
      metrics: {
        contradictedDurationMs,
        matchingDurationMs,
        queryExecutions: counters.queryExecutions,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('does not coalesce request-scoped initial subscriptions', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const versions = new Map<number, number>()
    const query = createBenchmarkQuery(counters, versions)

    await Promise.all(Array.from({ length: 10 }, async () => {
      await subscribeRealtimeQuery(query, { userId: 1 }, {
        onData: () => {
          counters.emittedSnapshots += 1
        },
      }, {
        authRequest: createAuthRequestAccessors(),
      })
    }))

    expect(counters.queryExecutions).toBe(10)
    expect(counters.emittedSnapshots).toBe(10)
  })

  it('removes subscriptions from invalidation indexes when unsubscribed', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const versions = new Map<number, number>()
    const predicateQuery = createBenchmarkQuery(counters, versions)
    const broadQuery = defineRealtimeQuery({
      name: 'benchmark.posts.unsubscribeAll',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        recordDatabaseQueryDependencies([tableDependency()])

        return []
      },
    })

    const predicateSubscription = await subscribeRealtimeQuery(predicateQuery, { userId: 1 })
    const otherPredicateSubscription = await subscribeRealtimeQuery(predicateQuery, { userId: 2 })
    const broadSubscription = await subscribeRealtimeQuery(broadQuery, {})
    const state = realtimeRuntimeInternals.getRuntimeState()
    const predicateEntry = state.queryEntries.get(predicateSubscription.id) ?? [...state.queryEntries.values()]
      .find(entry => entry.subscribers.has(predicateSubscription.id))
    const otherPredicateEntry = state.queryEntries.get(otherPredicateSubscription.id) ?? [...state.queryEntries.values()]
      .find(entry => entry.subscribers.has(otherPredicateSubscription.id))
    const broadEntry = state.queryEntries.get(broadSubscription.id) ?? [...state.queryEntries.values()]
      .find(entry => entry.subscribers.has(broadSubscription.id))

    expect(predicateEntry).toBeDefined()
    expect(otherPredicateEntry).toBeDefined()
    expect(broadEntry).toBeDefined()
    if (!predicateEntry || !otherPredicateEntry || !broadEntry) {
      throw new Error('Expected benchmark query entries to exist.')
    }

    expect(state.tablePredicateColumnSubscribers.get(tableDependency())?.get('user_id')?.has(predicateEntry.refreshKey)).toBe(true)
    expect(state.tablePredicateColumnSubscribers.get(tableDependency())?.get('user_id')?.has(otherPredicateEntry.refreshKey)).toBe(true)
    expect(state.tablePredicateValueSubscribers.get(tableDependency())?.get('user_id')?.get(encodeDependencyValue(1))?.has(predicateEntry.refreshKey)).toBe(true)
    expect(state.tablePredicateValueSubscribers.get(tableDependency())?.get('user_id')?.get(encodeDependencyValue(2))?.has(otherPredicateEntry.refreshKey)).toBe(true)
    expect(state.tableBroadSubscribers.get(tableDependency())?.has(broadEntry.refreshKey)).toBe(true)

    predicateSubscription.unsubscribe()
    expect(state.tablePredicateColumnSubscribers.get(tableDependency())?.get('user_id')?.has(predicateEntry.refreshKey) ?? false).toBe(false)
    expect(state.tablePredicateColumnSubscribers.get(tableDependency())?.get('user_id')?.has(otherPredicateEntry.refreshKey)).toBe(true)
    expect(state.tablePredicateValueSubscribers.get(tableDependency())?.get('user_id')?.get(encodeDependencyValue(1))?.has(predicateEntry.refreshKey) ?? false).toBe(false)
    expect(state.tablePredicateValueSubscribers.get(tableDependency())?.get('user_id')?.get(encodeDependencyValue(2))?.has(otherPredicateEntry.refreshKey)).toBe(true)

    otherPredicateSubscription.unsubscribe()
    expect(state.tablePredicateColumnSubscribers.get(tableDependency())?.get('user_id')?.has(otherPredicateEntry.refreshKey) ?? false).toBe(false)
    expect(state.tablePredicateValueSubscribers.get(tableDependency())?.get('user_id')?.get(encodeDependencyValue(2))?.has(otherPredicateEntry.refreshKey) ?? false).toBe(false)

    broadSubscription.unsubscribe()
    expect(state.tableBroadSubscribers.get(tableDependency())?.has(broadEntry.refreshKey) ?? false).toBe(false)
  })

  it('measures listener cleanup restoring normal write path after last unsubscribe', async () => {
    const adapter = new BenchmarkModelAdapter(createPatchBenchmarkRows())
    const db = createBenchmarkReturningDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.listenerCleanupWritePath',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1

        return await context.table('posts').where('user_id', 1).orderBy('id').limit(100).get()
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'benchmark.posts.listenerCleanupMutation',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })

        return { ok: true }
      },
    })

    const setupStartedAt = performance.now()
    const subscription = await subscribeRealtimeQuery(query, {}, {
      onData: () => {
        counters.emittedSnapshots += 1
      },
    })
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(true)
    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(1)

    const cleanupStartedAt = performance.now()
    subscription.unsubscribe()
    const cleanupDurationMs = Number((performance.now() - cleanupStartedAt).toFixed(3))

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(realtimeRuntimeInternals.getRuntimeState().unsubscribeFromDatabase).toBeUndefined()

    adapter.queries.length = 0
    adapter.executions.length = 0

    const mutationStartedAt = performance.now()
    await executeRealtimeMutation(mutation)
    const mutationDurationMs = Number((performance.now() - mutationStartedAt).toFixed(3))

    expect(adapter.queries).toEqual([])
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "posts" SET "title" = ? WHERE "id" = ?',
        bindings: ['Updated', 1],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime listener cleanup normal write path',
      metrics: {
        cleanupDurationMs,
        emittedSnapshots: counters.emittedSnapshots,
        mutationDurationMs,
        postCleanupExecutions: adapter.executions.length,
        postCleanupQueries: adapter.queries.length,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
      },
    }))
  })

  it('measures patch delivery across many shared subscribers without rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createPatchBenchmarkQuery(counters, rows)
    let observedTitle = ''
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      const subscription = await subscribeRealtimeQuery(query, {}, {
        onData: snapshot => {
          counters.emittedSnapshots += 1
          const row = snapshot.data[499]
          if (row) {
            observedTitle = String(row.title)
          }
        },
      })
      subscriptions[index] = subscription
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      ...createPatchUpdateInvalidation(patchedRow, 'Post 500'),
      dependencies: [
        idRowDependency(500),
        tableDependency(),
      ],
    })
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(observedTitle).toBe('Updated 500')
    expect(subscriptions[0]?.current.data[499]?.title).toBe('Updated 500')
    expect(subscriptions[subscriptionCount - 1]?.current.data[499]?.title).toBe('Updated 500')

    const unsubscribeStartedAt = performance.now()
    subscriptions[0]?.unsubscribe()
    const unsubscribeDurationMs = Number((performance.now() - unsubscribeStartedAt).toFixed(3))

    expect(subscriptions[0]?.current.data[499]?.title).toBe('Updated 500')

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime snapshot fallback patch delivery',
      metrics: {
        patchDurationMs,
        patchSubscribers: 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        unsubscribeDurationMs,
      },
    }))
  })

  it('records representative sync execution modes without per-subscriber reruns', async () => {
    type RepresentativeMetric = {
      readonly emittedPatches: number
      readonly emittedSnapshots: number
      readonly expectedQueryExecutions: number
      readonly queryExecutions: number
      readonly scenario: string
      readonly subscriptions: number
    }

    const representativeSubscriptions = 250
    const matrix: RepresentativeMetric[] = []

    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const patchCounters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const patchRows = createPatchBenchmarkRows()
    const patchQuery = createPatchBenchmarkQuery(patchCounters, patchRows)
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        patchCounters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }
    await Promise.all(Array.from({ length: representativeSubscriptions }, async () => {
      await subscribeRealtimeQuery(patchQuery, {}, patchOptions)
    }))

    const patchedRow = {
      id: 500,
      title: 'Representative updated 500',
      user_id: 1,
    }
    patchRows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      ...createPatchUpdateInvalidation(patchedRow, 'Post 500'),
      dependencies: [
        idRowDependency(500),
        tableDependency(),
      ],
    })
    expect(patchCounters.queryExecutions).toBe(1)
    expect(patchCounters.emittedSnapshots).toBe(representativeSubscriptions)
    expect(emittedPatches).toBe(representativeSubscriptions)
    matrix.push({
      emittedPatches,
      emittedSnapshots: patchCounters.emittedSnapshots,
      expectedQueryExecutions: 1,
      queryExecutions: patchCounters.queryExecutions,
      scenario: 'supported-list-patch',
      subscriptions: representativeSubscriptions,
    })

    resetRealtimeRuntime()
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const projectedCounters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const projectedRows = createPatchBenchmarkRows()
    const projectedQuery = createSelectedPatchBenchmarkQuery(projectedCounters, projectedRows)
    let projectedPatches = 0
    const projectedOptions = {
      onData() {
        projectedCounters.emittedSnapshots += 1
      },
      onPatch() {
        projectedPatches += 1
      },
    }
    await Promise.all(Array.from({ length: representativeSubscriptions }, async () => {
      await subscribeRealtimeQuery(projectedQuery, {}, projectedOptions)
    }))

    const projectedPatchedRow = {
      id: 500,
      title: 'Representative projected updated 500',
      user_id: 1,
    }
    projectedRows[499] = projectedPatchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPreviousRowValueInvalidation(
      projectedPatchedRow,
      'Post 500',
    ))
    expect(projectedCounters.queryExecutions).toBe(1)
    expect(projectedCounters.emittedSnapshots).toBe(representativeSubscriptions)
    expect(projectedPatches).toBe(representativeSubscriptions)
    matrix.push({
      emittedPatches: projectedPatches,
      emittedSnapshots: projectedCounters.emittedSnapshots,
      expectedQueryExecutions: 1,
      queryExecutions: projectedCounters.queryExecutions,
      scenario: 'projected-previous-row-patch',
      subscriptions: representativeSubscriptions,
    })

    resetRealtimeRuntime()
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const aggregateCounters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const aggregateRows = createAggregatePatchBenchmarkRows()
    const aggregateQuery = createAggregatePatchBenchmarkQuery(aggregateCounters, aggregateRows)
    let aggregatePatches = 0
    const aggregateOptions = {
      onData() {
        aggregateCounters.emittedSnapshots += 1
      },
      onPatch() {
        aggregatePatches += 1
      },
    }
    await Promise.all(Array.from({ length: representativeSubscriptions }, async () => {
      await subscribeRealtimeQuery(aggregateQuery, {}, aggregateOptions)
    }))

    const insertedAggregateRow = {
      id: 1001,
      score: 11_001,
      title: 'Post 1001',
      user_id: 1,
    }
    aggregateRows.push(insertedAggregateRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedAggregateRow))
    expect(aggregateCounters.queryExecutions).toBe(1)
    expect(aggregateCounters.emittedSnapshots).toBe(representativeSubscriptions)
    expect(aggregatePatches).toBe(representativeSubscriptions)
    matrix.push({
      emittedPatches: aggregatePatches,
      emittedSnapshots: aggregateCounters.emittedSnapshots,
      expectedQueryExecutions: 1,
      queryExecutions: aggregateCounters.queryExecutions,
      scenario: 'aggregate-merge-patch',
      subscriptions: representativeSubscriptions,
    })

    resetRealtimeRuntime()
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const fallbackCounters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const fallbackRows = createAggregatePatchBenchmarkRows()
    const fallbackQuery = defineRealtimeQuery({
      name: 'benchmark.posts.representativeUnpatchableRows',
      access: 'public',
      handler: async () => {
        fallbackCounters.queryExecutions += 1
        const result = {
          rows: fallbackRows.map(row => ({
            id: row.id,
            title: row.title,
            user_id: row.user_id,
          })),
        }
        const dependencies = [
          tableDependency(),
          userPredicateDependency(1),
        ]
        recordDatabaseQueryDependencies(dependencies)
        recordDatabaseQueryObservation({
          connectionName,
          dependencies,
          orderBy: [],
          patchable: false,
          predicates: [{
            column: 'user_id',
            operator: '=',
            value: 1,
          }],
          result: result.rows,
          selections: [],
          tableName,
        })

        return result
      },
    })
    let fallbackPatches = 0
    const fallbackOptions = {
      onData() {
        fallbackCounters.emittedSnapshots += 1
      },
      onPatch() {
        fallbackPatches += 1
      },
    }
    await Promise.all(Array.from({ length: representativeSubscriptions }, async () => {
      await subscribeRealtimeQuery(fallbackQuery, {}, fallbackOptions)
    }))

    const fallbackPatchedRow = {
      id: 500,
      title: 'Representative fallback updated 500',
      user_id: 1,
    }
    fallbackRows[499] = fallbackPatchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(fallbackPatchedRow, 'Post 500'))
    expect(fallbackCounters.queryExecutions).toBe(2)
    expect(fallbackCounters.emittedSnapshots).toBe(representativeSubscriptions * 2)
    expect(fallbackPatches).toBe(0)
    matrix.push({
      emittedPatches: fallbackPatches,
      emittedSnapshots: fallbackCounters.emittedSnapshots,
      expectedQueryExecutions: 2,
      queryExecutions: fallbackCounters.queryExecutions,
      scenario: 'unsupported-shared-fallback',
      subscriptions: representativeSubscriptions,
    })

    expect(matrix).toEqual([
      {
        emittedPatches: representativeSubscriptions,
        emittedSnapshots: representativeSubscriptions,
        expectedQueryExecutions: 1,
        queryExecutions: 1,
        scenario: 'supported-list-patch',
        subscriptions: representativeSubscriptions,
      },
      {
        emittedPatches: representativeSubscriptions,
        emittedSnapshots: representativeSubscriptions,
        expectedQueryExecutions: 1,
        queryExecutions: 1,
        scenario: 'projected-previous-row-patch',
        subscriptions: representativeSubscriptions,
      },
      {
        emittedPatches: representativeSubscriptions,
        emittedSnapshots: representativeSubscriptions,
        expectedQueryExecutions: 1,
        queryExecutions: 1,
        scenario: 'aggregate-merge-patch',
        subscriptions: representativeSubscriptions,
      },
      {
        emittedPatches: 0,
        emittedSnapshots: representativeSubscriptions * 2,
        expectedQueryExecutions: 2,
        queryExecutions: 2,
        scenario: 'unsupported-shared-fallback',
        subscriptions: representativeSubscriptions,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime representative sync execution matrix',
      metrics: matrix,
    }))
  })

  it('measures grouped exact detail row backfills for batched unknown updates', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const createDetailQuery = (id: number) => defineRealtimeQuery({
      name: `benchmark.posts.groupedExactDetailRowBackfill.${id}`,
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.table(tableName).where('id', id).first()
      },
    })
    const firstQuery = createDetailQuery(50)
    const secondQuery = createDetailQuery(150)
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all([
      ...Array.from({ length: subscriptionCount }, async () => {
        await subscribeRealtimeQuery(firstQuery, {}, patchOptions)
      }),
      ...Array.from({ length: subscriptionCount }, async () => {
        await subscribeRealtimeQuery(secondQuery, {}, patchOptions)
      }),
    ])
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length
    const firstPatchedRow = {
      ...rows[49]!,
      title: 'Updated detail 50',
    }
    const secondPatchedRow = {
      ...rows[149]!,
      title: 'Updated detail 150',
    }
    rows[49] = firstPatchedRow
    rows[149] = secondPatchedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: '',
      dependencies: [],
    }, [
      {
        connectionName,
        dependencies: [idRowDependency(50)],
        mutations: [{
          connectionName,
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 50,
          }],
          tableName,
        }],
      },
      {
        connectionName,
        dependencies: [idRowDependency(150)],
        mutations: [{
          connectionName,
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 150,
          }],
          tableName,
        }],
      },
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueries = adapter.queries.slice(setupQueryCount)
    const groupedRowBackfillQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "id" IN (?, ?)').length
    const singleRowBackfillQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "id" = ? LIMIT 1').length

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(emittedPatches).toBe(subscriptionCount * 2)
    expect(groupedRowBackfillQueries).toBe(1)
    expect(singleRowBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime grouped exact detail row backfill',
      metrics: {
        emittedPatches,
        groupedRowBackfillQueries,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        singleRowBackfillQueries,
        subscriptions: subscriptionCount * 2,
      },
    }))
  })

  it('measures shared safe fallback for unpatchable queries across many subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createAggregatePatchBenchmarkRows()
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.unpatchableRows',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        const result = {
          rows: rows.map(row => ({
            id: row.id,
            title: row.title,
            user_id: row.user_id,
          })),
        }
        const dependencies = [
          tableDependency(),
          userPredicateDependency(1),
        ]
        recordDatabaseQueryDependencies(dependencies)
        recordDatabaseQueryObservation({
          connectionName,
          dependencies,
          orderBy: [],
          patchable: false,
          predicates: [{
            column: 'user_id',
            operator: '=',
            value: 1,
          }],
          result: result.rows,
          selections: [],
          tableName,
        })

        return result
      },
    })
    let emittedPatches = 0
    let observedTitle = ''
    const fallbackOptions = {
      onData(snapshot: { readonly data: { readonly rows: readonly BenchmarkPostRow[] } }) {
        counters.emittedSnapshots += 1
        const row = snapshot.data.rows[499]
        if (row) {
          observedTitle = row.title
        }
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, fallbackOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const fallbackStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 500'))
    const fallbackDurationMs = Number((performance.now() - fallbackStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(emittedPatches).toBe(0)
    expect(observedTitle).toBe('Updated 500')

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime unpatchable shared fallback',
      metrics: {
        emittedPatches,
        fallbackDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures batched shared fallback for unpatchable queries without per-event reruns', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createAggregatePatchBenchmarkRows()
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.batchedUnpatchableRows',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        const result = {
          rows: rows.map(row => ({
            id: row.id,
            title: row.title,
            user_id: row.user_id,
          })),
        }
        const dependencies = [
          tableDependency(),
          userPredicateDependency(1),
        ]
        recordDatabaseQueryDependencies(dependencies)
        recordDatabaseQueryObservation({
          connectionName,
          dependencies,
          orderBy: [],
          patchable: false,
          predicates: [{
            column: 'user_id',
            operator: '=',
            value: 1,
          }],
          result: result.rows,
          selections: [],
          tableName,
        })

        return result
      },
    })
    let emittedPatches = 0
    let observedFirstTitle = ''
    let observedSecondTitle = ''
    const fallbackOptions = {
      onData(snapshot: { readonly data: { readonly rows: readonly BenchmarkPostRow[] } }) {
        counters.emittedSnapshots += 1
        observedFirstTitle = snapshot.data.rows[499]?.title ?? observedFirstTitle
        observedSecondTitle = snapshot.data.rows[500]?.title ?? observedSecondTitle
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, fallbackOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const fallbackStartedAt = performance.now()
    const firstPatchedRow = {
      id: 500,
      score: 10_500,
      title: 'Updated 500',
      user_id: 1,
    }
    const secondPatchedRow = {
      id: 501,
      score: 10_501,
      title: 'Updated 501',
      user_id: 1,
    }
    rows[499] = firstPatchedRow
    rows[500] = secondPatchedRow
    await Promise.all([
      realtimeRuntimeInternals.handleBatchedDatabaseInvalidation(
        createPatchUpdateInvalidation(firstPatchedRow, 'Post 500'),
      ),
      realtimeRuntimeInternals.handleBatchedDatabaseInvalidation(
        createPatchUpdateInvalidation(secondPatchedRow, 'Post 501'),
      ),
    ])
    const fallbackDurationMs = Number((performance.now() - fallbackStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(emittedPatches).toBe(0)
    expect(observedFirstTitle).toBe('Updated 500')
    expect(observedSecondTitle).toBe('Updated 501')

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime batched unpatchable shared fallback',
      metrics: {
        emittedPatches,
        fallbackDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model shared safe fallback for unsupported distinct queries across many subscribers', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelDistinctFallbackBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedTitle = ''
    const fallbackOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        const row = snapshot.data[499]
        if (row) {
          observedTitle = String(row.title)
        }
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, fallbackOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }

    const fallbackStartedAt = performance.now()
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 500'))
    const fallbackDurationMs = Number((performance.now() - fallbackStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(emittedPatches).toBe(0)
    expect(observedTitle).toBe('Updated 500')

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model unsupported distinct shared fallback',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        fallbackDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table having grouped count patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableHavingGroupedCountPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedTotal = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        const row = snapshot.data[0]
        if (row) {
          observedTotal = Number(row.total)
        }
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedTotal).toBe(patchRowCount)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, total: patchRowCount + 1 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table having grouped count patch transport',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchRows: patchRowCount,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table redundant having grouped count patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableRedundantHavingGroupedCountPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedFirstGroupTotal = 0
    let observedSecondGroupTotal = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedFirstGroupTotal = Number(snapshot.data[0]?.total ?? observedFirstGroupTotal)
        observedSecondGroupTotal = Number(snapshot.data[1]?.total ?? observedSecondGroupTotal)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 2,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedFirstGroupTotal).toBe(patchRowCount)
    expect(observedSecondGroupTotal).toBe(0)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, total: patchRowCount },
      { user_id: 2, total: 1 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table redundant having grouped count patch transport',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table grouped count patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableGroupedCountPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedFirstGroupTotal = 0
    let observedSecondGroupTotal = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedFirstGroupTotal = Number(snapshot.data[0]?.total ?? observedFirstGroupTotal)
        observedSecondGroupTotal = Number(snapshot.data[1]?.total ?? observedSecondGroupTotal)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 2,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedFirstGroupTotal).toBe(patchRowCount)
    expect(observedSecondGroupTotal).toBe(0)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, total: patchRowCount },
      { user_id: 2, total: 1 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table grouped count patch transport',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table grouped sum patch transport without rerunning the query', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableGroupedSumPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedFirstGroupTotal = 0
    let observedSecondGroupTotal = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedFirstGroupTotal = Number(snapshot.data[0]?.score_total ?? observedFirstGroupTotal)
        observedSecondGroupTotal = Number(snapshot.data[1]?.score_total ?? observedSecondGroupTotal)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 1,
      score: 11,
      title: `Post ${patchRowCount + 1}`,
      user_id: 2,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const expectedInitialTotal = rows
      .slice(0, patchRowCount)
      .reduce((total, row) => total + Number(row.score), 0)

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedFirstGroupTotal).toBe(expectedInitialTotal)
    expect(observedSecondGroupTotal).toBe(0)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, score_total: expectedInitialTotal },
      { user_id: 2, score_total: 11 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table grouped sum patch transport',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table having grouped sum patch transport without rerunning or backfilling', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    rows.push({
      id: patchRowCount + 1,
      score: 11,
      title: `Post ${patchRowCount + 1}`,
      user_id: 2,
    })
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createDatabase({
      adapter,
      dialect: benchmarkModelDialect,
      connectionName,
    })
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableHavingGroupedSumPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedFirstGroupTotal = 0
    let observedSecondGroupTotal = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedFirstGroupTotal = Number(snapshot.data[0]?.score_total ?? observedFirstGroupTotal)
        observedSecondGroupTotal = Number(snapshot.data[1]?.score_total ?? observedSecondGroupTotal)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 2,
      score: 13,
      title: `Post ${patchRowCount + 2}`,
      user_id: 2,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const expectedInitialTotal = rows
      .slice(0, patchRowCount)
      .reduce((total, row) => total + Number(row.score), 0)
    const aggregateBackfillQueries = adapter.queries.filter((queryLog) => {
      return queryLog.sql.includes('SUM("score") AS "__holo_grouped_aggregate_value"')
        && queryLog.sql.includes('HAVING COUNT(*) > ?')
    }).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedFirstGroupTotal).toBe(expectedInitialTotal)
    expect(observedSecondGroupTotal).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, score_total: expectedInitialTotal },
      { user_id: 2, score_total: 24 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table having grouped sum patch transport without backfill',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table having grouped average patch transport without rerunning or backfilling', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    rows.push({
      id: patchRowCount + 1,
      score: 11,
      title: `Post ${patchRowCount + 1}`,
      user_id: 2,
    })
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createDatabase({
      adapter,
      dialect: benchmarkModelDialect,
      connectionName,
    })
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableHavingGroupedAveragePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedFirstGroupAverage = 0
    let observedSecondGroupAverage = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedFirstGroupAverage = Number(snapshot.data[0]?.average_score ?? observedFirstGroupAverage)
        observedSecondGroupAverage = Number(snapshot.data[1]?.average_score ?? observedSecondGroupAverage)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 2,
      score: 6,
      title: `Post ${patchRowCount + 2}`,
      user_id: 2,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const expectedInitialAverage = rows
      .slice(0, patchRowCount)
      .reduce((total, row) => total + Number(row.score), 0) / patchRowCount
    const aggregateBackfillQueries = adapter.queries.filter((queryLog) => {
      return queryLog.sql.includes('AVG("score") AS "__holo_grouped_aggregate_value"')
        && queryLog.sql.includes('HAVING COUNT(*) > ?')
    }).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedFirstGroupAverage).toBe(expectedInitialAverage)
    expect(observedSecondGroupAverage).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, average_score: expectedInitialAverage },
      { user_id: 2, average_score: 8.5 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table having grouped average patch transport without backfill',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures observed table having grouped average patch transport without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createDatabase({
      adapter,
      dialect: benchmarkModelDialect,
      connectionName,
    })
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableHavingGroupedAveragePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedAverage = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedAverage = Number(snapshot.data[0]?.average_score ?? observedAverage)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const queryCountAfterSetup = adapter.queries.length
    const previousRow = rows[499]
    if (!previousRow || typeof previousRow.score !== 'number') {
      throw new Error('Expected benchmark patch row to exist.')
    }

    const previousScore = previousRow.score
    const patchedRow = {
      ...previousRow,
      score: previousScore + 100,
    }
    const patchStartedAt = performance.now()
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchScoreUpdateInvalidation(patchedRow, previousRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const expectedInitialAverage = createAggregatePatchBenchmarkRows()
      .reduce((total, row) => total + Number(row.score), 0) / patchRowCount
    const expectedPatchedAverage = expectedInitialAverage + (patchedRow.score - previousScore) / patchRowCount
    const mutationQueries = adapter.queries.slice(queryCountAfterSetup)
    const aggregateBackfillQueries = mutationQueries.filter((queryLog) => {
      return queryLog.sql.includes('AVG("score") AS "__holo_grouped_aggregate_value"')
    }).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedAverage).toBe(expectedInitialAverage)
    expect(aggregateBackfillQueries).toBe(0)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, average_score: expectedPatchedAverage },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime observed table having grouped average patch transport',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table having grouped min and max patch transport without rerunning or backfilling', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    rows.push({
      id: patchRowCount + 1,
      score: 11,
      title: `Post ${patchRowCount + 1}`,
      user_id: 2,
    })
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createDatabase({
      adapter,
      dialect: benchmarkModelDialect,
      connectionName,
    })
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const maxQuery = createTableHavingGroupedMaxPatchBenchmarkQuery(counters)
    const minQuery = createTableHavingGroupedMinPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedMax = 0
    let observedMin = 0
    const maxSubscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof maxQuery>>>> = []
    const minSubscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof minQuery>>>> = []
    const maxPatchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedMax = Number(snapshot.data[0]?.best_score ?? observedMax)
      },
      onPatch() {
        emittedPatches += 1
      },
    }
    const minPatchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedMin = Number(snapshot.data[0]?.lowest_score ?? observedMin)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      maxSubscriptions[index] = await subscribeRealtimeQuery(maxQuery, {}, maxPatchOptions)
      minSubscriptions[index] = await subscribeRealtimeQuery(minQuery, {}, minPatchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 2,
      score: 6,
      title: `Post ${patchRowCount + 2}`,
      user_id: 2,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const maxBackfillQueries = adapter.queries.filter((queryLog) => {
      return queryLog.sql.includes('MAX("score") AS "__holo_grouped_aggregate_value"')
        && queryLog.sql.includes('HAVING COUNT(*) > ?')
    }).length
    const minBackfillQueries = adapter.queries.filter((queryLog) => {
      return queryLog.sql.includes('MIN("score") AS "__holo_grouped_aggregate_value"')
        && queryLog.sql.includes('HAVING COUNT(*) > ?')
    }).length

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(emittedPatches).toBe(subscriptionCount * 2)
    expect(observedMax).toBe(11_000)
    expect(observedMin).toBe(10_001)
    expect(maxBackfillQueries).toBe(0)
    expect(minBackfillQueries).toBe(0)
    expect(maxSubscriptions[0]?.current.data).toEqual([
      { user_id: 1, best_score: 11_000 },
      { user_id: 2, best_score: 11 },
    ])
    expect(minSubscriptions[0]?.current.data).toEqual([
      { user_id: 1, lowest_score: 10_001 },
      { user_id: 2, lowest_score: 6 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table having grouped min and max patch transport without backfill',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        maxBackfillQueries,
        minBackfillQueries,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount * 2,
      },
    }))
  })

  it('measures table having grouped max runner-up patch transport without rerunning or backfilling', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createDatabase({
      adapter,
      dialect: benchmarkModelDialect,
      connectionName,
    })
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableHavingGroupedMaxPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedMax = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedMax = Number(snapshot.data[0]?.best_score ?? observedMax)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[patchRowCount - 1]!
    const updatedRow = {
      ...previousRow,
      score: 9_999,
    }

    const patchStartedAt = performance.now()
    rows[patchRowCount - 1] = updatedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchScoreUpdateInvalidation(updatedRow, previousRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const maxBackfillQueries = adapter.queries.filter((queryLog) => {
      return queryLog.sql.includes('MAX("score") AS "__holo_grouped_aggregate_value"')
        && queryLog.sql.includes('HAVING COUNT(*) > ?')
    }).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedMax).toBe(11_000)
    expect(maxBackfillQueries).toBe(0)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, best_score: 10_999 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table having grouped max runner-up patch transport without backfill',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        maxBackfillQueries,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table grouped max patch transport without rerunning the query', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableGroupedMaxPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedBestScore = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedBestScore = Number(snapshot.data[0]?.best_score ?? observedBestScore)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[499]!
    const patchedRow = {
      ...previousRow,
      score: 20_000,
    }

    const patchStartedAt = performance.now()
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchScoreUpdateInvalidation(patchedRow, previousRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedBestScore).toBe(11_000)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, best_score: 20_000 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table grouped max patch transport',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table grouped max backfill transport without rerunning the query', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableGroupedMaxPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedBestScore = 0
    const subscriptions: Array<Awaited<ReturnType<typeof subscribeRealtimeQuery<typeof query>>>> = []
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedBestScore = Number(snapshot.data[0]?.best_score ?? observedBestScore)
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      subscriptions[index] = await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = rows.at(-1)!

    const patchStartedAt = performance.now()
    rows.splice(rows.indexOf(deletedRow), 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const groupedBackfillQueries = adapter.queries.filter(queryLog => {
      return queryLog.sql.includes('MAX("score") AS "__holo_grouped_aggregate_value"')
    }).length
    const groupedValueCountQueries = adapter.queries.filter(queryLog => {
      return queryLog.sql.includes('__holo_grouped_aggregate_value_count')
    }).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(groupedBackfillQueries).toBe(1)
    expect(groupedValueCountQueries).toBe(1)
    expect(observedBestScore).toBe(11_000)
    expect(subscriptions[0]?.current.data).toEqual([
      { user_id: 1, best_score: 10_999 },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table grouped max backfill transport',
      metrics: {
        emittedPatches,
        emittedSnapshots: counters.emittedSnapshots,
        groupedBackfillQueries,
        groupedValueCountQueries,
        patchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures compact patch transport across many shared subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 500'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'title'],
      value: 'Updated 500',
    }])
    expect(observedPatch?.dependencies).toBeUndefined()

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime compact patch transport',
      metrics: {
        emittedPatches,
        includesDependencies: typeof observedPatch?.dependencies !== 'undefined',
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures compact merge patch transport for wide row updates across many shared subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createWidePatchBenchmarkRows()
    const query = createWidePatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[499]
    if (!previousRow) {
      throw new Error('Expected benchmark wide patch row to exist.')
    }

    const patchStartedAt = performance.now()
    const patchedRow = {
      ...previousRow,
      field_1: 'updated-field-1',
      field_2: 'updated-field-2',
      field_3: 'updated-field-3',
      field_4: 'updated-field-4',
      field_5: 'updated-field-5',
      field_6: 'updated-field-6',
      field_7: 'updated-field-7',
      field_8: 'updated-field-8',
      field_9: 'updated-field-9',
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createWidePatchUpdateInvalidation(
      patchedRow,
      previousRow,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [499],
        fields: {
          field_1: 'updated-field-1',
          field_2: 'updated-field-2',
          field_3: 'updated-field-3',
          field_4: 'updated-field-4',
          field_5: 'updated-field-5',
          field_6: 'updated-field-6',
          field_7: 'updated-field-7',
          field_8: 'updated-field-8',
          field_9: 'updated-field-9',
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime compact merge patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        updatedFields: 9,
      },
    }))
  })

  it('measures bounded row backfill for unknown updates without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.unknownUpdateBackfill',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .table(tableName)
          .where('user_id', 1)
          .orderBy('id')
          .limit(patchRowCount)
          .get()
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUnknownUpdateInvalidation(patchedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(adapter.queries).toHaveLength(2)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'title'],
      value: 'Updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime bounded row backfill for unknown update',
      metrics: {
        backfillQueries: adapter.queries.length - 1,
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures selected bounded row backfill for unknown updates without leaking unselected fields', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.selectedUnknownUpdateBackfill',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .table(tableName)
          .select('id', 'title')
          .where('user_id', 1)
          .orderBy('id')
          .limit(patchRowCount)
          .get()
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    let observedInitialUserId: unknown = 'missing'
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedInitialUserId = snapshot.data[499]?.user_id
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUnknownUpdateInvalidation(patchedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(adapter.queries).toHaveLength(2)
    expect(observedInitialUserId).toBeUndefined()
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'title'],
      value: 'Updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime selected bounded row backfill for unknown update',
      metrics: {
        backfillQueries: adapter.queries.length - 1,
        emittedPatches,
        leakedUnselectedField: typeof observedInitialUserId !== 'undefined',
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures selected row patch transport across many shared subscribers without leaking unselected fields', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createSelectedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    let observedInitialUserId: unknown = 'missing'
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedInitialUserId = snapshot.data[499]?.user_id
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 500'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialUserId).toBeUndefined()
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'title'],
      value: 'Updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime selected patch transport',
      metrics: {
        emittedPatches,
        leakedUnselectedField: typeof observedInitialUserId !== 'undefined',
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures selected row partial-row patch transport without rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createSelectedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    let observedInitialUserId: unknown = 'missing'
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedInitialUserId = snapshot.data[499]?.user_id
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Partial selected updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPartialRowValueInvalidation(patchedRow, 'Post 500'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialUserId).toBeUndefined()
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'title'],
      value: 'Partial selected updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime selected partial-row patch transport',
      metrics: {
        emittedPatches,
        leakedUnselectedField: typeof observedInitialUserId !== 'undefined',
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures selected previous-row value patch transport without returned rows or rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createSelectedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    let observedInitialUserId: unknown = 'missing'
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedInitialUserId = snapshot.data[499]?.user_id
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Previous-row selected updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPreviousRowValueInvalidation(
      patchedRow,
      'Post 500',
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialUserId).toBeUndefined()
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'title'],
      value: 'Previous-row selected updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime selected previous-row value patch transport',
      metrics: {
        emittedPatches,
        leakedUnselectedField: typeof observedInitialUserId !== 'undefined',
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures predicate-only existing row patch transport without returned rows or rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createPredicateOnlyPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    let observedInitialUserId: unknown
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedInitialUserId = snapshot.data[499]?.user_id
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const previousRow = rows[499]
    if (!previousRow) {
      throw new Error('Expected benchmark predicate-only row to exist.')
    }

    const patchStartedAt = performance.now()
    const patchedRow = {
      ...previousRow,
      user_id: 2,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPredicateOnlyUserUpdateInvalidation(
      patchedRow,
      previousRow.user_id,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialUserId).toBe(1)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'user_id'],
      value: 2,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime predicate-only existing row patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures exact selected record patch transport without selected identity or reruns', async () => {
    const rows = createPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.exactSelectedRecordPatch',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        const row = rows[499]
        const result = row ? { title: row.title } : undefined
        const dependencies = [
          tableDependency(),
          idRowDependency(500),
        ]
        recordDatabaseQueryDependencies(dependencies)
        recordDatabaseQueryObservation({
          connectionName,
          dependencies,
          limit: 1,
          orderBy: [],
          patchable: true,
          predicates: [{
            column: 'id',
            operator: '=',
            value: 500,
          }],
          result,
          selections: [{
            column: 'title',
            resultKey: 'title',
          }],
          tableName,
        })

        return result
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    let observedInitialId: unknown = 'missing'
    const patchOptions = {
      onData(snapshot: { readonly data: Readonly<Record<string, unknown>> | null | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialId = snapshot.data?.id
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      ...createPatchUpdateInvalidation(patchedRow, 'Post 500'),
      dependencies: [
        tableDependency(),
        idRowDependency(500),
      ],
    })
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(entry?.queries[0]?.patchable).toBe(true)
    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialId).toBeUndefined()
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime exact selected record patch transport',
      metrics: {
        emittedPatches,
        leakedSelectedIdentity: typeof observedInitialId !== 'undefined',
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures exact selected record delete and insert patch transport without selected identity or reruns', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    let currentRow: BenchmarkPostRow | undefined = {
      id: 700,
      title: 'Post 700',
      user_id: 1,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.exactSelectedRecordDeleteInsertPatch',
      access: 'public',
      handler: async () => {
        counters.queryExecutions += 1
        const result = currentRow ? { title: currentRow.title } : undefined
        const dependencies = [
          tableDependency(),
          idRowDependency(700),
        ]
        recordDatabaseQueryDependencies(dependencies)
        recordDatabaseQueryObservation({
          connectionName,
          dependencies,
          limit: 1,
          orderBy: [],
          patchable: true,
          predicates: [{
            column: 'id',
            operator: '=',
            value: 700,
          }],
          result,
          selections: [{
            column: 'title',
            resultKey: 'title',
          }],
          tableName,
        })

        return result
      },
    })
    let emittedPatches = 0
    let observedDeletePatch: BenchmarkPatch | undefined
    let observedInsertPatch: BenchmarkPatch | undefined
    let observedInitialId: unknown = 'missing'
    const patchOptions = {
      onData(snapshot: { readonly data: Readonly<Record<string, unknown>> | null | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialId = snapshot.data?.id
      },
      onPatch(patch: BenchmarkPatch) {
        if (emittedPatches === 0) {
          observedDeletePatch = patch
        }
        if (emittedPatches === subscriptionCount) {
          observedInsertPatch = patch
        }

        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]

    const patchStartedAt = performance.now()
    const deletedRow = currentRow
    if (!deletedRow) {
      throw new Error('Expected benchmark row to exist before delete patch')
    }

    currentRow = undefined
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      ...createPatchDeleteInvalidation(deletedRow),
      dependencies: [
        tableDependency(),
        idRowDependency(700),
      ],
    })
    const insertedRow: BenchmarkPostRow = {
      id: 700,
      title: 'Restored 700',
      user_id: 1,
    }
    currentRow = insertedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      ...createPatchInsertInvalidation(insertedRow),
      dependencies: [
        tableDependency(),
        idRowDependency(700),
      ],
    })
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(entry?.queries[0]?.patchable).toBe(true)
    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount * 2)
    expect(observedInitialId).toBeUndefined()
    expect(observedDeletePatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      valueKind: 'undefined',
    }])
    expect(observedInsertPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: {
        title: 'Restored 700',
      },
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime exact selected record delete insert patch transport',
      metrics: {
        emittedPatches,
        leakedSelectedIdentity: typeof observedInitialId !== 'undefined',
        patchDurationMs,
        patchOperations: (observedDeletePatch?.operations.length ?? 0)
          + (observedInsertPatch?.operations.length ?? 0),
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures compact multi-row patch transport across many shared subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createOrderedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRows = [
      {
        id: 499,
        title: 'Updated',
        user_id: 1,
      },
      {
        id: 500,
        title: 'Updated',
        user_id: 1,
      },
    ]
    rows[498] = patchedRows[0]!
    rows[499] = patchedRows[1]!
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMultiUpdateInvalidation(
      patchedRows,
      ['Post 499', 'Post 500'],
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: [498, 'title'],
        value: 'Updated',
      },
      {
        op: 'replace',
        path: [499, 'title'],
        value: 'Updated',
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime compact multi-row patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        updatedRows: patchedRows.length,
      },
    }))
  })

  it('measures offset window patch transport without backfilling unchanged membership', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createOffsetOrderedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 151,
      title: 'Updated 151',
      user_id: 1,
    }
    rows[150] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 151'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [50, 'title'],
      value: 'Updated 151',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime offset window patch transport',
      metrics: {
        emittedPatches,
        offset: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        windowRows: 100,
      },
    }))
  })

  it('measures observed selected offset-window patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.observedSelectedOffsetWindow',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .table(tableName)
          .select('id', 'title')
          .where('user_id', 1)
          .orderBy('id')
          .offset(100)
          .limit(100)
          .get()
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    let observedInitialUserId: unknown = 'missing'
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        observedInitialUserId = snapshot.data[50]?.user_id
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 151,
      title: 'Updated 151',
      user_id: 1,
    }
    rows[150] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 151'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(entry?.queries[0]?.patchable).toBe(true)
    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(adapter.queries).toHaveLength(1)
    expect(observedInitialUserId).toBeUndefined()
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [50, 'title'],
      value: 'Updated 151',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime observed selected offset-window patch transport',
      metrics: {
        emittedPatches,
        offset: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        windowRows: 100,
      },
    }))
  })

  it('measures paginated wrapper data patch transport without rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createPaginatedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 51,
      title: 'Updated 51',
      user_id: 1,
    }
    rows[50] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 51'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['data', 50, 'title'],
      value: 'Updated 51',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime paginated wrapper patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures paginated wrapper bounded backfill for unknown updates without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.paginatedUnknownUpdateBackfill',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .table(tableName)
          .orderBy('id')
          .paginate(100, 1)
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 51,
      title: 'Updated 51',
      user_id: 1,
    }
    rows[50] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUnknownUpdateInvalidation(patchedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(adapter.queries).toHaveLength(2)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['data', 50, 'title'],
      value: 'Updated 51',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime paginated wrapper bounded backfill for unknown update',
      metrics: {
        backfillQueries: adapter.queries.length - 1,
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures filtered paginated count backfill for unknown updates without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.filteredPaginatedUnknownUpdateBackfill',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .table(tableName)
          .where('user_id', 1)
          .orderBy('id')
          .paginate(100, 1)
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 51,
      title: 'Updated 51',
      user_id: 1,
    }
    rows[50] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUnknownUpdateInvalidation(patchedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const countBackfillQueries = adapter.queries.filter(query => query.sql.startsWith('SELECT COUNT(*) AS "__holo_count"')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(adapter.queries).toHaveLength(3)
    expect(countBackfillQueries).toBe(1)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['data', 50, 'title'],
      value: 'Updated 51',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime filtered paginated count backfill for unknown update',
      metrics: {
        countBackfillQueries,
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        rowBackfillQueries: adapter.queries.length - countBackfillQueries - 1,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures pagination metadata predicate-only patch transport without count backfill or rerun', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createPaginationMetaPredicateOnlyBenchmarkQuery(counters, patchRowCount)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly meta: BenchmarkPaginatedRows['meta'] } }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPredicateOnlyUserUpdateInvalidation(
      {
        id: patchRowCount + 1,
        title: `Post ${patchRowCount + 1}`,
        user_id: 1,
      },
      2,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'merge',
      path: ['meta'],
      fields: {
        total: patchRowCount + 1,
        lastPage: 11,
      },
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime pagination metadata predicate-only patch transport',
      metrics: {
        emittedPatches,
        initialTotalRows: observedInitialTotal,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures grouped exact filtered paginated count backfills for batched unknown updates', async () => {
    const rows = [
      ...createPatchBenchmarkRows(),
      ...Array.from({ length: patchRowCount }, (_, index): BenchmarkPostRow => ({
        id: patchRowCount + index + 1,
        title: `User 2 post ${index + 1}`,
        user_id: 2,
      })),
    ]
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const createFilteredQuery = (userId: number) => defineRealtimeQuery({
      name: `benchmark.posts.groupedFilteredPaginatedCountBackfill.${userId}`,
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .table(tableName)
          .where('user_id', userId)
          .orderBy('id')
          .paginate(100, 1)
      },
    })
    const firstQuery = createFilteredQuery(1)
    const secondQuery = createFilteredQuery(2)
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all([
      ...Array.from({ length: subscriptionCount }, async () => {
        await subscribeRealtimeQuery(firstQuery, {}, patchOptions)
      }),
      ...Array.from({ length: subscriptionCount }, async () => {
        await subscribeRealtimeQuery(secondQuery, {}, patchOptions)
      }),
    ])
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length
    const firstPatchedRow = {
      ...rows[50]!,
      title: 'Updated user 1 row 51',
    }
    const secondPatchedRow = {
      ...rows[patchRowCount + 50]!,
      title: 'Updated user 2 row 51',
    }
    rows[50] = firstPatchedRow
    rows[patchRowCount + 50] = secondPatchedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: '',
      dependencies: [],
    }, [
      createPatchUnknownUpdateInvalidation(firstPatchedRow),
      createPatchUnknownUpdateInvalidation(secondPatchedRow),
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueries = adapter.queries.slice(setupQueryCount)
    const groupedWindowBackfillQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM (SELECT *, "user_id" AS "__holo_group_id", ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "id" ASC) AS "__holo_row_number" FROM "posts" WHERE "user_id" IN (?, ?)) AS "__holo_grouped_rows" WHERE "__holo_row_number" > ? AND "__holo_row_number" <= ? ORDER BY "__holo_group_id" ASC, "__holo_row_number" ASC').length
    const groupedCountBackfillQueries = patchQueries.filter(query => query.sql === 'SELECT "user_id", COUNT(*) AS "__holo_count" FROM "posts" WHERE "user_id" IN (?, ?) GROUP BY "user_id"').length
    const singleCountBackfillQueries = patchQueries.filter(query => query.sql === 'SELECT COUNT(*) AS "__holo_count" FROM "posts" WHERE "user_id" = ?').length

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(emittedPatches).toBe(subscriptionCount * 2)
    expect(groupedWindowBackfillQueries).toBe(1)
    expect(groupedCountBackfillQueries).toBe(1)
    expect(singleCountBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime grouped exact filtered paginated count backfill',
      metrics: {
        emittedPatches,
        groupedCountBackfillQueries,
        groupedWindowBackfillQueries,
        pageRows: 100,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        rowBackfillQueries: patchQueries.length - groupedCountBackfillQueries - groupedWindowBackfillQueries,
        setupDurationMs,
        singleCountBackfillQueries,
        subscriptions: subscriptionCount * 2,
      },
    }))
  })

  it('measures filtered simple-paginated count backfill for unknown updates without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.filteredSimplePaginatedUnknownUpdateBackfill',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .table(tableName)
          .where('user_id', 1)
          .orderBy('id')
          .simplePaginate(100, 1)
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 51,
      title: 'Updated 51',
      user_id: 1,
    }
    rows[50] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUnknownUpdateInvalidation(patchedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const countBackfillQueries = adapter.queries.filter(query => query.sql.startsWith('SELECT COUNT(*) AS "__holo_count"')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(adapter.queries).toHaveLength(3)
    expect(countBackfillQueries).toBe(1)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['data', 50, 'title'],
      value: 'Updated 51',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime filtered simple-paginated count backfill for unknown update',
      metrics: {
        countBackfillQueries,
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        rowBackfillQueries: adapter.queries.length - countBackfillQueries - 1,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures paginated wrapper insert patch transport without rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createPaginatedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [insertedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 1001,
          lastPage: 11,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime paginated wrapper insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures paginated wrapper delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: () => createBenchmarkModelDatabaseContext(rows),
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createPaginatedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark paginated delete row to exist.')
    }
    const backfilledRow = rows[99]
    if (!backfilledRow) {
      throw new Error('Expected benchmark paginated backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 999,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime paginated wrapper delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures paginated offset-window delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: () => createBenchmarkModelDatabaseContext(rows),
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createPaginatedOffsetPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark paginated offset delete row to exist.')
    }
    const backfilledRow = rows[199]
    if (!backfilledRow) {
      throw new Error('Expected benchmark paginated offset backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 999,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime paginated offset-window delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures paginated offset-window insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: () => createBenchmarkModelDatabaseContext(rows),
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createPaginatedOffsetPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    const shiftedRow = rows[99]
    if (!shiftedRow) {
      throw new Error('Expected benchmark paginated offset shifted row to exist.')
    }

    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [shiftedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 1001,
          lastPage: 11,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime paginated offset-window insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures cursor-paginated wrapper insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createCursorPaginatedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly nextCursor: string | null } }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = snapshot.data.nextCursor
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [insertedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([99]),
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime cursor-paginated wrapper insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures cursor metadata predicate-only update patch transport without rerunning the query', async () => {
    const rows = createPriorityPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createCursorPaginationPredicateOnlyBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const expectedCursor = encodeBenchmarkCursor([99])
    const patchOptions = {
      onData(snapshot: { readonly data: string | null }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPredicateOnlyPriorityUserUpdateInvalidation(
      {
        id: patchRowCount + 1,
        priority: 0,
        title: `Post ${patchRowCount + 1}`,
        user_id: 1,
      },
      2,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: expectedCursor,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime cursor metadata predicate-only patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures cursor-paginated wrapper delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createCursorPaginatedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly nextCursor: string | null } }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = snapshot.data.nextCursor
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark cursor delete row to exist.')
    }
    const backfilledRow = rows[99]
    if (!backfilledRow) {
      throw new Error('Expected benchmark cursor lookahead row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([101]),
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime cursor-paginated wrapper delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model cursor-paginated JSON insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelCursorPaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkCursorPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = snapshot.data.nextCursor
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([99]),
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [insertedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model cursor-paginated JSON insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model cursor-paginated JSON delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelCursorPaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkCursorPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = snapshot.data.nextCursor
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model cursor-paginated JSON delete row to exist.')
    }
    const backfilledRow = rows[99]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model cursor-paginated JSON backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([101]),
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model cursor-paginated JSON delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model cursor-paginated entity insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelCursorPaginatedPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = (snapshot.data as BenchmarkCursorPaginatedRows).nextCursor
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([99]),
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [insertedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model cursor-paginated entity insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model cursor-paginated entity delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelCursorPaginatedPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = (snapshot.data as BenchmarkCursorPaginatedRows).nextCursor
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model cursor-paginated entity delete row to exist.')
    }
    const backfilledRow = rows[99]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model cursor-paginated entity backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([101]),
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model cursor-paginated entity delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model paginated JSON patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 51,
      title: 'Updated 51',
      user_id: 1,
    }
    rows[50] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 51'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['data', 50, 'title'],
      value: 'Updated 51',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated JSON patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures returning model paginated JSON patch transport without metadata refresh', async () => {
    const rows = createPatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkReturningDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length

    const patchStartedAt = performance.now()
    const previousRow = rows[50]
    if (!previousRow) {
      throw new Error('Expected benchmark returning paginated row to exist.')
    }

    const patchedRow = {
      ...previousRow,
      title: 'Updated 51',
    }
    rows[50] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchTitleOnlyReturningUpdateInvalidation(patchedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueryCount = adapter.queries.length - setupQueryCount

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(patchQueryCount).toBe(0)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['data', 50, 'title'],
      value: 'Updated 51',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime returning model paginated JSON patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchQueryCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model paginated JSON insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [insertedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 1001,
          lastPage: 11,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated JSON insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model paginated JSON delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model paginated JSON delete row to exist.')
    }
    const backfilledRow = rows[99]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model paginated JSON backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 999,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated JSON delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model paginated JSON offset-window delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedOffsetJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model paginated JSON offset delete row to exist.')
    }
    const backfilledRow = rows[199]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model paginated JSON offset backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 999,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated JSON offset-window delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model paginated JSON offset-window insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedOffsetJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    const shiftedRow = rows[99]
    if (!shiftedRow) {
      throw new Error('Expected benchmark model paginated JSON offset shifted row to exist.')
    }

    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [shiftedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 1001,
          lastPage: 11,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated JSON offset-window insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model simple-paginated JSON insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialHasMorePages = false
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly meta: { readonly hasMorePages: boolean } } }) {
        counters.emittedSnapshots += 1
        observedInitialHasMorePages = snapshot.data.meta.hasMorePages
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialHasMorePages).toBe(true)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [insertedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated JSON insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model simple-paginated JSON delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialHasMorePages = false
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkSimplePaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialHasMorePages = snapshot.data.meta.hasMorePages
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model simple-paginated JSON delete row to exist.')
    }
    const backfilledRow = rows[99]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model simple-paginated JSON backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialHasMorePages).toBe(true)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated JSON delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model simple-paginated JSON offset-window delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedOffsetJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialHasMorePages = false
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkSimplePaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialHasMorePages = snapshot.data.meta.hasMorePages
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model simple-paginated JSON offset delete row to exist.')
    }
    const backfilledRow = rows[199]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model simple-paginated JSON offset backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialHasMorePages).toBe(true)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated JSON offset-window delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model simple-paginated JSON offset-window insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedOffsetJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialHasMorePages = false
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkSimplePaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialHasMorePages = snapshot.data.meta.hasMorePages
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    const shiftedRow = rows[99]
    if (!shiftedRow) {
      throw new Error('Expected benchmark model simple-paginated JSON offset shifted row to exist.')
    }

    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialHasMorePages).toBe(true)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [shiftedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated JSON offset-window insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model paginated entity patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = (snapshot.data as BenchmarkPaginatedRows).meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 51,
      title: 'Updated 51',
      user_id: 1,
    }
    rows[50] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 51'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['data', 50, 'title'],
      value: 'Updated 51',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated entity patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model where-in insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelWhereInPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: 1001,
      title: 'Post 1001',
      user_id: 2,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: 1000,
      deleteCount: 0,
      values: [insertedRow],
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model where-in insert patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model where-in unrelated insert filtering without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelWhereInPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: 1001,
      title: 'Post 1001',
      user_id: 3,
    }

    const filterStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const filterDurationMs = Number((performance.now() - filterStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model where-in unrelated insert filtering',
      metrics: {
        emittedPatches,
        filterDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model paginated entity delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = (snapshot.data as BenchmarkPaginatedRows).meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model paginated delete row to exist.')
    }
    const backfilledRow = rows[99]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model paginated backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 999,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated entity delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model paginated offset-window entity delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedOffsetPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = (snapshot.data as BenchmarkPaginatedRows).meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model paginated offset delete row to exist.')
    }
    const backfilledRow = rows[199]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model paginated offset backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 999,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated offset-window entity delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model paginated offset-window entity insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedOffsetPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = (snapshot.data as BenchmarkPaginatedRows).meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    const shiftedRow = rows[99]
    if (!shiftedRow) {
      throw new Error('Expected benchmark model paginated offset shifted row to exist.')
    }

    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [shiftedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 1001,
          lastPage: 11,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated offset-window entity insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model simple-paginated offset-window entity delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedOffsetPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialHasMorePages = false
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly meta: { readonly hasMorePages: boolean } } }) {
        counters.emittedSnapshots += 1
        observedInitialHasMorePages = snapshot.data.meta.hasMorePages
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows.shift()
    if (!deletedRow) {
      throw new Error('Expected benchmark model simple-paginated offset delete row to exist.')
    }
    const backfilledRow = rows[199]
    if (!backfilledRow) {
      throw new Error('Expected benchmark model simple-paginated offset backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialHasMorePages).toBe(true)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [backfilledRow],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated offset-window entity delete patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model simple-paginated offset-window entity insert patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedOffsetPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialHasMorePages = false
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly meta: { readonly hasMorePages: boolean } } }) {
        counters.emittedSnapshots += 1
        observedInitialHasMorePages = snapshot.data.meta.hasMorePages
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 0,
      title: 'Inserted first',
      user_id: 1,
    }
    const shiftedRow = rows[99]
    if (!shiftedRow) {
      throw new Error('Expected benchmark model simple-paginated offset shifted row to exist.')
    }

    const patchStartedAt = performance.now()
    rows.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialHasMorePages).toBe(true)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [shiftedRow],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated offset-window entity insert patch transport',
      metrics: {
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table sole record patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableSolePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPostRow }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data.title
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table sole record patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table first record patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableFirstPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPostRow | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data?.title ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table first record patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table first record partial-row patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableFirstPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPostRow | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data?.title ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Partial first updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPartialRowValueInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Partial first updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table first record partial-row patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures constrained table first record predicate move patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableConstrainedFirstPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPostRow | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data?.title ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[0]
    if (!previousRow) {
      throw new Error('Expected benchmark constrained first row to exist.')
    }

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: previousRow.id,
      title: 'Updated 1',
      user_id: 2,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveUserValueInvalidation(
      patchedRow,
      previousRow.title,
      previousRow.user_id,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      valueKind: 'undefined',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained table first predicate move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table scalar value patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableValuePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: string | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table scalar value patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table scalar value patch transport from partial mutation rows without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableValuePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: string | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Partial row updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchPartialRowValueInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: 'Partial row updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table scalar value partial-row patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table scalar value irrelevant update silence without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableValuePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    const patchOptions = {
      onData(snapshot: { readonly data: string | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data ?? ''
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const row = rows[0]
    if (!row) {
      throw new Error('Expected benchmark scalar row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchIrrelevantScalarUpdateInvalidation(row))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(observedInitialTitle).toBe('Post 1')

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table scalar value irrelevant update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures constrained table scalar value predicate move patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableConstrainedValuePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: string | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[0]
    if (!previousRow) {
      throw new Error('Expected benchmark constrained scalar row to exist.')
    }

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: previousRow.id,
      title: 'Updated 1',
      user_id: 2,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveUserValueInvalidation(
      patchedRow,
      previousRow.title,
      previousRow.user_id,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      valueKind: 'undefined',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained table scalar predicate move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures constrained table scalar predicate-only move patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableConstrainedValuePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: string | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[0]
    if (!previousRow) {
      throw new Error('Expected benchmark constrained scalar row to exist.')
    }

    const patchStartedAt = performance.now()
    const patchedRow = {
      ...previousRow,
      user_id: 2,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveUserPredicateOnlyValueInvalidation(
      patchedRow,
      previousRow.title,
      previousRow.user_id,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      valueKind: 'undefined',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained table scalar predicate-only move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table scalar value delete patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableValuePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: string | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = rows[0]
    if (!deletedRow) {
      throw new Error('Expected benchmark scalar value row to exist.')
    }

    const patchStartedAt = performance.now()
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      valueKind: 'undefined',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table scalar value delete patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model scalar value patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelValuePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = String(snapshot.data ?? '')
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model scalar value patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table pluck scalar-list patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTablePluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitles: readonly string[] = []
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly unknown[] }) {
        counters.emittedSnapshots += 1
        observedInitialTitles = snapshot.data.map(String)
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 500'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitles[499]).toBe('Post 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499],
      value: 'Updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table pluck scalar-list patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table pluck scalar-list irrelevant update silence without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTablePluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const row = rows[499]
    if (!row) {
      throw new Error('Expected benchmark pluck row to exist.')
    }
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchIrrelevantScalarUpdateInvalidation(row))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table pluck scalar-list irrelevant update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table pluck scalar-list splice transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTablePluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 1001,
      title: 'Post 1001',
      user_id: 1,
    }
    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      deleteCount: 0,
      index: 1000,
      op: 'splice',
      path: [],
      values: ['Post 1001'],
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table pluck scalar-list splice transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model pluck scalar-list patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitles: readonly string[] = []
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly unknown[] }) {
        counters.emittedSnapshots += 1
        observedInitialTitles = snapshot.data.map(String)
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 500'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitles[499]).toBe('Post 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499],
      value: 'Updated 500',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model pluck scalar-list patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model pluck scalar-list irrelevant update silence without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const row = rows[499]
    if (!row) {
      throw new Error('Expected benchmark model pluck row to exist.')
    }
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchIrrelevantScalarUpdateInvalidation(row))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model pluck scalar-list irrelevant update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model pluck scalar-list splice transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 1001,
      title: 'Post 1001',
      user_id: 1,
    }
    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      deleteCount: 0,
      index: 1000,
      op: 'splice',
      path: [],
      values: ['Post 1001'],
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model pluck scalar-list splice transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table exists patch transport without rerunning the query', async () => {
    const rows: BenchmarkPostRow[] = []
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableExistsPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const insertedRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(false)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: true,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table exists patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table exists metadata updates without redundant patch fanout', async () => {
    const initialRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    const rows: BenchmarkPostRow[] = [initialRow]
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableExistsPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 2,
      title: 'Post 2',
      user_id: 1,
    }
    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(initialRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(true)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: false,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table exists metadata update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table doesntExist patch transport without rerunning the query', async () => {
    const rows: BenchmarkPostRow[] = []
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableDoesntExistPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const insertedRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(true)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: false,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table doesntExist patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures table doesntExist metadata updates without redundant patch fanout', async () => {
    const initialRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    const rows: BenchmarkPostRow[] = [initialRow]
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createTableDoesntExistPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 2,
      title: 'Post 2',
      user_id: 1,
    }
    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(initialRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(false)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: true,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime table doesntExist metadata update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model exists patch transport without rerunning the query', async () => {
    const rows: BenchmarkPostRow[] = []
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelExistsPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const insertedRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(false)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: true,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model exists patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model exists metadata updates without redundant patch fanout', async () => {
    const initialRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    const rows: BenchmarkPostRow[] = [initialRow]
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelExistsPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 2,
      title: 'Post 2',
      user_id: 1,
    }
    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(initialRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(true)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: false,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model exists metadata update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model doesntExist patch transport without rerunning the query', async () => {
    const rows: BenchmarkPostRow[] = []
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelDoesntExistPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const insertedRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(true)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: false,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model doesntExist patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model doesntExist metadata updates without redundant patch fanout', async () => {
    const initialRow = {
      id: 1,
      title: 'Post 1',
      user_id: 1,
    }
    const rows: BenchmarkPostRow[] = [initialRow]
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelDoesntExistPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialValue: boolean | undefined
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: boolean }) {
        counters.emittedSnapshots += 1
        observedInitialValue = snapshot.data
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const insertedRow = {
      id: 2,
      title: 'Post 2',
      user_id: 1,
    }
    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(initialRow))
    rows.splice(0, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialValue).toBe(false)
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: true,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model doesntExist metadata update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model first record patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelFirstPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = (snapshot.data as BenchmarkPostRow).title
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model first record patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model firstJson record patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelFirstJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPostRow | undefined }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data?.title ?? ''
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model firstJson record patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model sole record patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSolePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = (snapshot.data as BenchmarkPostRow).title
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model sole record patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model soleJson record patch transport without rerunning the query', async () => {
    const rows = createPatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSoleJsonPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPostRow }) {
        counters.emittedSnapshots += 1
        observedInitialTitle = snapshot.data.title
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 1,
      title: 'Updated 1',
      user_id: 1,
    }
    rows[0] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateIdInvalidation(patchedRow, 'Post 1'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 1')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated 1',
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model soleJson record patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures compact splice transport for ordered list churn across many shared subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createOrderedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    const patches: BenchmarkPatch[] = []
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        patches.push(patch)
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const deletedRow = rows[499]
    if (!deletedRow) {
      throw new Error('Expected benchmark delete row to exist.')
    }

    const deleteStartedAt = performance.now()
    rows.splice(499, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const deletePatchDurationMs = Number((performance.now() - deleteStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(patches[0]?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: 499,
      deleteCount: 1,
      values: [],
    }])

    const insertStartedAt = performance.now()
    rows.splice(499, 0, deletedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(deletedRow))
    const insertPatchDurationMs = Number((performance.now() - insertStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount * 2)
    expect(patches[subscriptionCount]?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: 499,
      deleteCount: 0,
      values: [{
        id: 500,
        title: 'Post 500',
        user_id: 1,
      }],
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime compact splice transport',
      metrics: {
        deletePatchDurationMs,
        emittedPatches,
        insertPatchDurationMs,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures compact move transport for ordered updates across many shared subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPriorityPatchBenchmarkRows()
    const query = createPriorityOrderedPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const movedRow = rows[499]
    if (!movedRow) {
      throw new Error('Expected benchmark move row to exist.')
    }

    const patchStartedAt = performance.now()
    const nextMovedRow = {
      ...movedRow,
      priority: 0,
    }
    rows.splice(499, 1)
    rows.unshift(nextMovedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveInvalidation(nextMovedRow, 500))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'move',
        path: [],
        from: 499,
        to: 0,
      },
      {
        op: 'replace',
        path: [0, 'priority'],
        value: 0,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime compact move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model compact move transport for ordered row updates across many shared subscribers', async () => {
    const rows = createPriorityPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: () => createBenchmarkModelDatabaseContext(rows),
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPriorityOrderedPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const movedRow = rows[499]
    if (!movedRow) {
      throw new Error('Expected benchmark model move row to exist.')
    }

    const patchStartedAt = performance.now()
    const nextMovedRow = {
      ...movedRow,
      priority: 0,
    }
    rows.splice(499, 1)
    rows.unshift(nextMovedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveInvalidation(nextMovedRow, 500))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'move',
        path: [],
        from: 499,
        to: 0,
      },
      {
        op: 'replace',
        path: [0, 'priority'],
        value: 0,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model compact move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures compact move transport for ordered pluck scalar-lists across many shared subscribers', async () => {
    const rows = createPriorityPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: () => createBenchmarkModelDatabaseContext(rows),
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createPriorityPluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const movedRow = rows[499]
    if (!movedRow) {
      throw new Error('Expected benchmark scalar-list move row to exist.')
    }

    const nextMovedRow = {
      ...movedRow,
      priority: 0,
    }
    const patchStartedAt = performance.now()
    rows.splice(499, 1)
    rows.unshift(nextMovedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveInvalidation(nextMovedRow, 500))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      from: 499,
      op: 'move',
      path: [],
      to: 0,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime compact scalar-list move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model compact move transport for ordered pluck scalar-lists across many shared subscribers', async () => {
    const rows = createPriorityPatchBenchmarkRows()
    configureRealtimeRuntime({
      db: () => createBenchmarkModelDatabaseContext(rows),
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPriorityPluckPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const movedRow = rows[499]
    if (!movedRow) {
      throw new Error('Expected benchmark model scalar-list move row to exist.')
    }

    const nextMovedRow = {
      ...movedRow,
      priority: 0,
    }
    const patchStartedAt = performance.now()
    rows.splice(499, 1)
    rows.unshift(nextMovedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveInvalidation(nextMovedRow, 500))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      from: 499,
      op: 'move',
      path: [],
      to: 0,
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model compact scalar-list move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures top-level wrapper patch delivery without building a generic replacement plan', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createWrapperPatchBenchmarkQuery(counters, rows)
    let observedPrimaryTitle = ''
    let observedSecondaryTitle = ''
    let observedTertiaryTitle = ''
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: {
        readonly data: {
          readonly primary: readonly BenchmarkPostRow[]
          readonly secondary: readonly BenchmarkPostRow[]
          readonly tertiary: readonly BenchmarkPostRow[]
        }
      }) {
        counters.emittedSnapshots += 1
        const primaryRow = snapshot.data.primary[499]
        const secondaryRow = snapshot.data.secondary[499]
        const tertiaryRow = snapshot.data.tertiary[499]
        if (primaryRow && secondaryRow && tertiaryRow) {
          observedPrimaryTitle = String(primaryRow.title)
          observedSecondaryTitle = String(secondaryRow.title)
          observedTertiaryTitle = String(tertiaryRow.title)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    expect(entry?.queries.map(observation => observation.resultPath)).toEqual([
      ['primary'],
      ['secondary'],
      ['tertiary'],
    ])
    expect(entry?.patchTargets.map(target => target.resultPath)).toEqual([
      ['primary'],
      ['secondary'],
      ['tertiary'],
    ])
    expect(new Set(entry?.patchTargets.map(target => target.mutationIndexKey)).size).toBe(1)

    const patchStartedAt = performance.now()
    const patchedRow = {
      id: 500,
      title: 'Updated 500',
      user_id: 1,
    }
    rows[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpdateInvalidation(patchedRow, 'Post 500'))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPrimaryTitle).toBe('Post 500')
    expect(observedSecondaryTitle).toBe('Post 500')
    expect(observedTertiaryTitle).toBe('Post 500')
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['primary', 499, 'title'],
        value: 'Updated 500',
      },
      {
        op: 'replace',
        path: ['secondary', 499, 'title'],
        value: 'Updated 500',
      },
      {
        op: 'replace',
        path: ['tertiary', 499, 'title'],
        value: 'Updated 500',
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime wrapper patch delivery',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        wrapperPaths: 3,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures stable wrapper upsert patch delivery without rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createWrapperPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[499]
    if (!previousRow) {
      throw new Error('Expected benchmark wrapper upsert row to exist.')
    }

    const upsertedRow = {
      ...previousRow,
      title: 'Updated 500',
    }

    const patchStartedAt = performance.now()
    rows[499] = upsertedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpsertInvalidation(upsertedRow, previousRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['primary', 499, 'title'],
        value: 'Updated 500',
      },
      {
        op: 'replace',
        path: ['secondary', 499, 'title'],
        value: 'Updated 500',
      },
      {
        op: 'replace',
        path: ['tertiary', 499, 'title'],
        value: 'Updated 500',
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime stable wrapper upsert patch delivery',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        wrapperPaths: 3,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures multi-row stable wrapper upsert patch delivery without rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createPatchBenchmarkRows()
    const query = createWrapperPatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousFirstRow = rows[499]
    const previousSecondRow = rows[500]
    if (!previousFirstRow || !previousSecondRow) {
      throw new Error('Expected benchmark wrapper upsert rows to exist.')
    }

    const previousRows = [previousFirstRow, previousSecondRow]
    const upsertedFirstRow = {
      ...previousFirstRow,
      title: 'Updated 500',
    }
    const upsertedSecondRow = {
      ...previousSecondRow,
      title: 'Updated 501',
    }
    const upsertedRows = [
      upsertedFirstRow,
      upsertedSecondRow,
    ]

    const patchStartedAt = performance.now()
    rows[499] = upsertedFirstRow
    rows[500] = upsertedSecondRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMultiUpsertInvalidation(upsertedRows, previousRows))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['primary', 499, 'title'],
        value: 'Updated 500',
      },
      {
        op: 'replace',
        path: ['primary', 500, 'title'],
        value: 'Updated 501',
      },
      {
        op: 'replace',
        path: ['secondary', 499, 'title'],
        value: 'Updated 500',
      },
      {
        op: 'replace',
        path: ['secondary', 500, 'title'],
        value: 'Updated 501',
      },
      {
        op: 'replace',
        path: ['tertiary', 499, 'title'],
        value: 'Updated 500',
      },
      {
        op: 'replace',
        path: ['tertiary', 500, 'title'],
        value: 'Updated 501',
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime multi-row stable wrapper upsert patch delivery',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        patchRows: patchRowCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        upsertedRows: upsertedRows.length,
        wrapperPaths: 3,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures aggregate merge patch transport across many shared subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createAggregatePatchBenchmarkRows()
    const query = createAggregatePatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: 1001,
      score: 11_001,
      title: 'Post 1001',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          count: 1001,
          scoreAverage: 10_501,
          scoreMaximum: 11_001,
          scoreSum: 10_511_501,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime aggregate merge patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures constrained aggregate predicate move patch transport without rerunning the query', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createAggregatePatchBenchmarkRows()
    const query = createAggregatePatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[500]
    if (!previousRow) {
      throw new Error('Expected aggregate predicate move benchmark row to exist.')
    }

    const movedRow = {
      ...previousRow,
      user_id: 2,
    }
    const patchStartedAt = performance.now()
    rows[500] = movedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchMoveAggregateUserValueInvalidation(
      movedRow,
      1,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          count: 999,
          scoreAverage: 10_500.4994994995,
          scoreSum: 10_489_999,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained aggregate predicate move patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures ambiguous aggregate merge patch transport across many shared subscribers', async () => {
    configureRealtimeRuntime({
      db: createBenchmarkDatabaseContext,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const rows = createAggregatePatchBenchmarkRows()
    const query = createAmbiguousAggregatePatchBenchmarkQuery(counters, rows)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: patchRowCount + 1,
      score: 11_001,
      title: `Post ${patchRowCount + 1}`,
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          count: patchRowCount + 1,
          maximum: patchRowCount + 1,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime ambiguous aggregate merge patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model aggregate merge patch transport across many shared subscribers', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const db = createBenchmarkModelDatabaseContext(rows)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      id: 1001,
      score: 11_001,
      title: 'Post 1001',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    rows.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          count: 1001,
          scoreAverage: 10_501,
          scoreMaximum: 11_001,
          scoreSum: 10_511_501,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model aggregate merge patch transport',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model aggregate upsert patch transport without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[999]
    if (!previousRow) {
      throw new Error('Expected benchmark upsert row to exist.')
    }

    const upsertedRow = {
      ...previousRow,
      score: 12_000,
    }

    const patchStartedAt = performance.now()
    rows[999] = upsertedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUpsertInvalidation(upsertedRow, previousRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(aggregateBackfillQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          scoreAverage: 10_501.5,
          scoreMaximum: 12_000,
          scoreSum: 10_501_500,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model aggregate upsert patch transport',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model aggregate irrelevant update silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[499]
    if (!previousRow) {
      throw new Error('Expected benchmark aggregate update row to exist.')
    }

    const updatedRow = {
      ...previousRow,
      title: 'Renamed post 500',
    }

    const patchStartedAt = performance.now()
    rows[499] = updatedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchTitleOnlyReturningUpdateInvalidation(updatedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model aggregate irrelevant update silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model aggregate unknown update shared backfill without rerunning the query', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = rows[499]
    if (!previousRow) {
      throw new Error('Expected benchmark aggregate update row to exist.')
    }

    const updatedRow = {
      ...previousRow,
      score: 12_000,
    }

    const patchStartedAt = performance.now()
    rows[499] = updatedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUnknownUpdateInvalidation(updatedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(aggregateBackfillQueries).toBe(1)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          scoreAverage: 10_502,
          scoreMaximum: 12_000,
          scoreSum: 10_502_000,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model aggregate unknown update shared backfill',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures grouped count-only aggregate backfills for batched unknown inserts', async () => {
    const rows: BenchmarkPostRow[] = [
      ...Array.from({ length: 500 }, (_, index) => ({
        id: index + 1,
        score: 10_000 + index + 1,
        title: `Post ${index + 1}`,
        user_id: 1,
      })),
      ...Array.from({ length: 500 }, (_, index) => ({
        id: 500 + index + 1,
        score: 20_000 + index + 1,
        title: `Post ${500 + index + 1}`,
        user_id: 2,
      })),
    ]
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelCountAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    const observedPatches: BenchmarkPatch[] = []
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatches.push(patch)
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async (_, index) => {
      await subscribeRealtimeQuery(query, { userId: index % 2 === 0 ? 1 : 2 }, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length

    const patchStartedAt = performance.now()
    rows.push(
      {
        id: 1_001,
        score: 30_001,
        title: 'Post 1001',
        user_id: 1,
      },
      {
        id: 1_002,
        score: 30_002,
        title: 'Post 1002',
        user_id: 2,
      },
    )
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createPatchUnknownInsertInvalidation(1),
      createPatchUnknownInsertInvalidation(2),
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueries = adapter.queries.slice(setupQueryCount)
    const groupedCountBackfillQueries = patchQueries.filter(query => query.sql === 'SELECT "user_id", COUNT(*) AS "__holo_count" FROM "posts" WHERE "user_id" IN (?, ?) GROUP BY "user_id"').length
    const singleCountBackfillQueries = patchQueries.filter(query => query.sql === 'SELECT COUNT(*) AS "__holo_count" FROM "posts" WHERE "user_id" = ?').length

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(groupedCountBackfillQueries).toBe(1)
    expect(singleCountBackfillQueries).toBe(0)
    expect(observedPatches.every((patch) => {
      const operation = patch.operations[0]
      return patch.operations.length === 1
        && operation?.op === 'replace'
        && 'value' in operation
        && operation.path.length === 0
        && operation.value === 501
    })).toBe(true)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime grouped count-only aggregate backfill',
      metrics: {
        emittedPatches,
        groupedCountBackfillQueries,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        singleCountBackfillQueries,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model aggregate extreme runner-up patch transport without rerunning or backfilling', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = rows.pop()
    if (!deletedRow) {
      throw new Error('Expected benchmark aggregate backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(aggregateBackfillQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          count: 999,
          scoreAverage: 10_500,
          scoreMaximum: 10_999,
          scoreSum: 10_489_500,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model aggregate extreme runner-up patch transport',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures duplicate extreme aggregate silence after aggregate backfill metadata rebuild', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const duplicateMaximum = rows.at(-1)
    const previousMaximum = rows.at(-2)
    const unknownUpdateRow = rows[499]
    if (!duplicateMaximum || !previousMaximum || !unknownUpdateRow || typeof duplicateMaximum.score !== 'number') {
      throw new Error('Expected benchmark duplicate aggregate backfill rows to exist.')
    }

    const duplicatedPreviousMaximum = {
      ...previousMaximum,
      score: duplicateMaximum.score,
    }
    rows[rows.length - 2] = duplicatedPreviousMaximum
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.duplicateMaximumAggregateAfterBackfillPatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.table('posts').where('user_id', 1).max('score')
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    rows[499] = {
      ...unknownUpdateRow,
      title: 'Unknown update 500',
    }

    const backfillStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchUnknownUpdateInvalidation(rows[499]!))
    const backfillDurationMs = Number((performance.now() - backfillStartedAt).toFixed(3))
    const backfillAggregateQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length
    const backfillExtremeValueWindowQueries = adapter.queries.filter(query => query.sql.includes('__holo_value_count')).length
    const deletedRow = rows.pop()
    if (!deletedRow || deletedRow.id !== duplicateMaximum.id) {
      throw new Error('Expected benchmark duplicate aggregate delete row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const totalAggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(backfillAggregateQueries).toBe(1)
    expect(backfillExtremeValueWindowQueries).toBe(1)
    expect(totalAggregateBackfillQueries).toBe(1)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime duplicate extreme aggregate post-backfill metadata silence',
      metrics: {
        backfillAggregateQueries,
        backfillDurationMs,
        backfillExtremeValueWindowQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalAggregateBackfillQueries,
      },
    }))
  })

  it('measures duplicate extreme aggregate metadata silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const duplicateMaximum = rows.at(-1)
    const previousMaximum = rows.at(-2)
    if (!duplicateMaximum || !previousMaximum || typeof duplicateMaximum.score !== 'number') {
      throw new Error('Expected benchmark duplicate aggregate rows to exist.')
    }

    rows[rows.length - 2] = {
      ...previousMaximum,
      score: duplicateMaximum.score,
    }
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.duplicateMaximumAggregatePatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.table('posts').where('user_id', 1).max('score')
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = rows.pop()
    if (!deletedRow) {
      throw new Error('Expected benchmark duplicate aggregate delete row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime duplicate extreme aggregate metadata silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures patched duplicate extreme aggregate metadata silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.patchedDuplicateMinimumAggregatePatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.table('posts').where('user_id', 1).min('score')
      },
    })
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const firstMinimum = {
      id: 1001,
      score: 9_000,
      title: 'Post 1001',
      user_id: 1,
    }
    const duplicateMinimum = {
      id: 1002,
      score: 9_000,
      title: 'Post 1002',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    rows.push(firstMinimum)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(firstMinimum))
    rows.push(duplicateMinimum)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchInsertInvalidation(duplicateMinimum))
    const firstMinimumIndex = rows.indexOf(firstMinimum)
    if (firstMinimumIndex < 0) {
      throw new Error('Expected patched duplicate minimum benchmark row to exist.')
    }

    rows.splice(firstMinimumIndex, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(firstMinimum))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(aggregateBackfillQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: [],
        value: 9_000,
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime patched duplicate extreme aggregate metadata silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures duplicate extreme aggregate update metadata silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const duplicateMaximum = rows.at(-1)
    const previousMaximum = rows.at(-2)
    if (!duplicateMaximum || !previousMaximum || typeof duplicateMaximum.score !== 'number') {
      throw new Error('Expected benchmark duplicate aggregate update rows to exist.')
    }

    const duplicatedPreviousMaximum = {
      ...previousMaximum,
      score: duplicateMaximum.score,
    }
    rows[rows.length - 2] = duplicatedPreviousMaximum
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.duplicateMaximumAggregateUpdatePatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.table('posts').where('user_id', 1).max('score')
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const updatedRow = {
      ...duplicatedPreviousMaximum,
      score: duplicateMaximum.score - 1,
    }
    rows[rows.length - 2] = updatedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createPatchScoreUpdateInvalidation(updatedRow, duplicatedPreviousMaximum),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime duplicate extreme aggregate update metadata silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures duplicate extreme aggregate upsert metadata silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const duplicateMaximum = rows.at(-1)
    const previousMaximum = rows.at(-2)
    if (!duplicateMaximum || !previousMaximum || typeof duplicateMaximum.score !== 'number') {
      throw new Error('Expected benchmark duplicate aggregate upsert rows to exist.')
    }

    const duplicatedPreviousMaximum = {
      ...previousMaximum,
      score: duplicateMaximum.score,
    }
    rows[rows.length - 2] = duplicatedPreviousMaximum
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.duplicateMaximumAggregateUpsertPatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.table('posts').where('user_id', 1).max('score')
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const upsertedRow = {
      ...duplicatedPreviousMaximum,
      score: duplicateMaximum.score - 1,
    }
    rows[rows.length - 2] = upsertedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createPatchUpsertInvalidation(upsertedRow, duplicatedPreviousMaximum),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime duplicate extreme aggregate upsert metadata silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model duplicate extreme aggregate metadata silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const duplicateMaximum = rows.at(-1)
    const previousMaximum = rows.at(-2)
    if (!duplicateMaximum || !previousMaximum || typeof duplicateMaximum.score !== 'number') {
      throw new Error('Expected benchmark duplicate model aggregate rows to exist.')
    }

    rows[rows.length - 2] = {
      ...previousMaximum,
      score: duplicateMaximum.score,
    }
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const Post = createBenchmarkPostModel()
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.modelDuplicateMaximumAggregatePatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.model(Post).query().where('user_id', 1).max('score')
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = rows.pop()
    if (!deletedRow) {
      throw new Error('Expected benchmark duplicate model aggregate delete row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createPatchDeleteInvalidation(deletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model duplicate extreme aggregate metadata silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model duplicate extreme aggregate update metadata silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const duplicateMaximum = rows.at(-1)
    const previousMaximum = rows.at(-2)
    if (!duplicateMaximum || !previousMaximum || typeof duplicateMaximum.score !== 'number') {
      throw new Error('Expected benchmark duplicate model aggregate update rows to exist.')
    }

    const duplicatedPreviousMaximum = {
      ...previousMaximum,
      score: duplicateMaximum.score,
    }
    rows[rows.length - 2] = duplicatedPreviousMaximum
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const Post = createBenchmarkPostModel()
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.modelDuplicateMaximumAggregateUpdatePatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.model(Post).query().where('user_id', 1).max('score')
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const updatedRow = {
      ...duplicatedPreviousMaximum,
      score: duplicateMaximum.score - 1,
    }
    rows[rows.length - 2] = updatedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createPatchScoreUpdateInvalidation(updatedRow, duplicatedPreviousMaximum),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model duplicate extreme aggregate update metadata silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model duplicate extreme aggregate upsert metadata silence without aggregate backfill', async () => {
    const rows = createAggregatePatchBenchmarkRows()
    const duplicateMaximum = rows.at(-1)
    const previousMaximum = rows.at(-2)
    if (!duplicateMaximum || !previousMaximum || typeof duplicateMaximum.score !== 'number') {
      throw new Error('Expected benchmark duplicate model aggregate upsert rows to exist.')
    }

    const duplicatedPreviousMaximum = {
      ...previousMaximum,
      score: duplicateMaximum.score,
    }
    rows[rows.length - 2] = duplicatedPreviousMaximum
    const adapter = new BenchmarkModelAdapter(rows)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const Post = createBenchmarkPostModel()
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.modelDuplicateMaximumAggregateUpsertPatch',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context.model(Post).query().where('user_id', 1).max('score')
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const upsertedRow = {
      ...duplicatedPreviousMaximum,
      score: duplicateMaximum.score - 1,
    }
    rows[rows.length - 2] = upsertedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createPatchUpsertInvalidation(upsertedRow, duplicatedPreviousMaximum),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model duplicate extreme aggregate upsert metadata silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  })

  it('measures model paginated relation aggregate merge patch transport across many shared subscribers', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 51,
      id: 1001,
      score: 11_001,
      title: 'Post 1001',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(aggregateBackfillQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: ['data', 50],
        fields: {
          posts_avg_score: 10_526,
          posts_max_score: 11_001,
          posts_sum_score: 21_052,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated relation aggregate merge patch transport',
      metrics: {
        emittedPatches,
        aggregateBackfillQueries,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model relation duplicate extreme aggregate update silence without aggregate backfill', async () => {
    const { duplicateRow, tables } = createDuplicateRelationExtremeBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationExtremeAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const updatedRow = {
      ...duplicateRow,
      score: duplicateRow.score - 1,
    }
    tables.posts[tables.posts.length - 1] = updatedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createRelationAggregateScoreUpdateInvalidation(updatedRow, duplicateRow),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model relation duplicate extreme aggregate update silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures returned-row relation aggregate target filtering before patching', () => {
    const targetCount = 100
    const targets = Object.freeze(Array.from({ length: targetCount }, (_, index) => {
      return createBenchmarkRelationAggregatePatchTarget(index + 1, index)
    }))
    const authorFiftyMutation = createRuntimeRelationAggregateUpsertMutation(50, 1_050, 10_050, 10_049)
    const authorFiftyOneMutation = createRuntimeRelationAggregateUpsertMutation(51, 1_051, 10_051, 10_050)
    const backfills = {
      aggregates: new Map(),
      aggregateSql: new Map(),
      entries: [],
      mutationMetadata: new WeakMap(),
      mutations: new Map([
        [
          `${connectionName}:${tableName}`,
          Object.freeze([
            authorFiftyMutation,
            authorFiftyOneMutation,
          ]),
        ],
      ]),
      paginationGroupedCounts: new Map(),
      paginationCounts: new Map(),
      rowGroups: new Map(),
      rows: new Map(),
    } satisfies BackfillCache

    const startedAt = performance.now()
    const relevantTargets = collectRelevantMutationTargets(targets, backfills)
    const durationMs = Number((performance.now() - startedAt).toFixed(3))
    const retainedMutations = relevantTargets.reduce((count, target) => count + target.mutations.length, 0)

    expect(relevantTargets).toHaveLength(2)
    expect(retainedMutations).toBe(2)
    expect(relevantTargets[0]?.target.query.predicates[0]?.value).toBe(50)
    expect(relevantTargets[0]?.mutations).toEqual([authorFiftyMutation])
    expect(relevantTargets[1]?.target.query.predicates[0]?.value).toBe(51)
    expect(relevantTargets[1]?.mutations).toEqual([authorFiftyOneMutation])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime returned-row relation aggregate target filtering',
      metrics: {
        durationMs,
        inputMutations: 2,
        relevantTargets: relevantTargets.length,
        retainedMutations,
        targetCount,
      },
    }))
  })

  it('measures model relation duplicate extreme aggregate silence after aggregate backfill metadata rebuild', async () => {
    const { duplicateRow, tables } = createDuplicateRelationExtremeBenchmarkTables()
    const unknownUpdateRow = tables.posts[50]
    if (!unknownUpdateRow || typeof unknownUpdateRow.author_id !== 'number') {
      throw new Error('Expected benchmark relation aggregate unknown update row to exist.')
    }

    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationExtremeAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const renamedRow = {
      ...unknownUpdateRow,
      title: 'Unknown relation update 51',
    }
    tables.posts[50] = renamedRow

    const backfillStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createRelationAggregateUnknownUpdateInvalidation(
        renamedRow as BenchmarkPostRow & { readonly author_id: number },
      ),
    )
    const backfillDurationMs = Number((performance.now() - backfillStartedAt).toFixed(3))
    const backfillAggregateQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length
    const backfillExtremeValueWindowQueries = adapter.queries.filter(query => query.sql.includes('__holo_value_count')).length
    const deletedRow = tables.posts.pop()
    if (!deletedRow || deletedRow.id !== duplicateRow.id) {
      throw new Error('Expected benchmark relation duplicate aggregate delete row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createRelationAggregateDeleteInvalidation(deletedRow as BenchmarkPostRow & { readonly author_id: number }),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const totalAggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(backfillAggregateQueries).toBe(1)
    expect(backfillExtremeValueWindowQueries).toBe(1)
    expect(totalAggregateBackfillQueries).toBe(1)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model relation duplicate extreme aggregate post-backfill metadata silence',
      metrics: {
        backfillAggregateQueries,
        backfillDurationMs,
        backfillExtremeValueWindowQueries,
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalAggregateBackfillQueries,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures batched model relation aggregate exact target fanout after metadata rebuild', async () => {
    const { duplicateRow, tables } = createDuplicateRelationExtremeBenchmarkTables()
    const secondUnknownUpdateRow = tables.posts[51]
    if (!secondUnknownUpdateRow || typeof secondUnknownUpdateRow.author_id !== 'number' || typeof secondUnknownUpdateRow.score !== 'number') {
      throw new Error('Expected benchmark relation aggregate second duplicate row to exist.')
    }

    const secondDuplicateRow = {
      author_id: secondUnknownUpdateRow.author_id,
      id: patchRowCount + 2,
      score: secondUnknownUpdateRow.score,
      title: `Post ${patchRowCount + 2}`,
      user_id: secondUnknownUpdateRow.user_id,
    }
    tables.posts.push(secondDuplicateRow)
    const unknownUpdateRow = tables.posts[50]
    if (!unknownUpdateRow || typeof unknownUpdateRow.author_id !== 'number') {
      throw new Error('Expected benchmark relation aggregate unknown update row to exist.')
    }

    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationExtremeAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const renamedFirstRow = {
      ...unknownUpdateRow,
      title: 'Unknown relation update 51',
    }
    const renamedSecondRow = {
      ...secondUnknownUpdateRow,
      title: 'Unknown relation update 52',
    }
    tables.posts[50] = renamedFirstRow
    tables.posts[51] = renamedSecondRow

    const backfillStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createRelationAggregateUnknownUpdateInvalidation(
        renamedFirstRow as BenchmarkPostRow & { readonly author_id: number },
      ),
      createRelationAggregateUnknownUpdateInvalidation(
        renamedSecondRow as BenchmarkPostRow & { readonly author_id: number },
      ),
    ])
    const backfillDurationMs = Number((performance.now() - backfillStartedAt).toFixed(3))
    const backfillAggregateQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length
    const backfillExtremeCountQueries = adapter.queries.filter(query => query.sql.includes('"score" =') || query.sql.includes('"score" IN')).length
    const deletedSecondRow = tables.posts.pop()
    const deletedFirstRow = tables.posts.pop()
    if (!deletedFirstRow || deletedFirstRow.id !== duplicateRow.id || !deletedSecondRow || deletedSecondRow.id !== secondDuplicateRow.id) {
      throw new Error('Expected benchmark relation duplicate aggregate batch delete rows to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createRelationAggregateDeleteInvalidation(deletedFirstRow as BenchmarkPostRow & { readonly author_id: number }),
      createRelationAggregateDeleteInvalidation(deletedSecondRow as BenchmarkPostRow & { readonly author_id: number }),
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const totalAggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(backfillAggregateQueries).toBe(2)
    expect(backfillExtremeCountQueries).toBe(1)
    expect(totalAggregateBackfillQueries).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime batched model relation aggregate exact target fanout',
      metrics: {
        backfillAggregateQueries,
        backfillDurationMs,
        backfillExtremeCountQueries,
        emittedPatches,
        invalidatedAuthors: 2,
        pageRows: 100,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalAggregateBackfillQueries,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures mixed batched model relation aggregate mutation fanout after metadata rebuild', async () => {
    const { duplicateRow, tables } = createDuplicateRelationExtremeBenchmarkTables()
    const secondUnknownUpdateRow = tables.posts[51]
    if (!secondUnknownUpdateRow || typeof secondUnknownUpdateRow.author_id !== 'number' || typeof secondUnknownUpdateRow.score !== 'number') {
      throw new Error('Expected benchmark relation aggregate second duplicate row to exist.')
    }

    const secondDuplicateRow = {
      author_id: secondUnknownUpdateRow.author_id,
      id: patchRowCount + 2,
      score: secondUnknownUpdateRow.score,
      title: `Post ${patchRowCount + 2}`,
      user_id: secondUnknownUpdateRow.user_id,
    }
    tables.posts.push(secondDuplicateRow)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationExtremeAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const updatedFirstDuplicate = {
      ...duplicateRow,
      score: duplicateRow.score - 1,
    }
    const firstDuplicateIndex = tables.posts.findIndex(row => row.id === duplicateRow.id)
    if (firstDuplicateIndex < 0) {
      throw new Error('Expected benchmark relation duplicate aggregate update row to exist.')
    }

    const renamedSecondRow = {
      ...secondUnknownUpdateRow,
      title: 'Unknown relation update 52',
    }
    tables.posts[firstDuplicateIndex] = updatedFirstDuplicate
    tables.posts[51] = renamedSecondRow

    const backfillStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createRelationAggregateScoreUpdateInvalidation(updatedFirstDuplicate, duplicateRow),
      createRelationAggregateUnknownUpdateInvalidation(
        renamedSecondRow as BenchmarkPostRow & { readonly author_id: number },
      ),
    ])
    const backfillDurationMs = Number((performance.now() - backfillStartedAt).toFixed(3))
    const backfillAggregateQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length
    const backfillExtremeValueWindowQueries = adapter.queries.filter(query => query.sql.includes('__holo_value_count')).length
    const deletedSecondRow = tables.posts.pop()
    if (!deletedSecondRow || deletedSecondRow.id !== secondDuplicateRow.id) {
      throw new Error('Expected benchmark relation duplicate aggregate delete row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createRelationAggregateDeleteInvalidation(deletedSecondRow as BenchmarkPostRow & { readonly author_id: number }),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const totalAggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(backfillAggregateQueries).toBe(1)
    expect(backfillExtremeValueWindowQueries).toBe(1)
    expect(totalAggregateBackfillQueries).toBe(1)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime mixed batched model relation aggregate mutation fanout',
      metrics: {
        backfillAggregateQueries,
        backfillDurationMs,
        backfillExtremeValueWindowQueries,
        emittedPatches,
        invalidatedAuthors: 2,
        pageRows: 100,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalAggregateBackfillQueries,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model relation duplicate extreme aggregate delete silence without aggregate backfill', async () => {
    const { duplicateRow, tables } = createDuplicateRelationExtremeBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationExtremeAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts.pop()
    if (!deletedRow || deletedRow.id !== duplicateRow.id) {
      throw new Error('Expected benchmark relation duplicate aggregate delete row to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createRelationAggregateDeleteInvalidation(deletedRow as BenchmarkPostRow & { readonly author_id: number }),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model relation duplicate extreme aggregate delete silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model relation duplicate extreme aggregate upsert silence without aggregate backfill', async () => {
    const { duplicateRow, tables } = createDuplicateRelationExtremeBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationExtremeAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const upsertedRow = {
      ...duplicateRow,
      score: duplicateRow.score - 1,
    }
    tables.posts[tables.posts.length - 1] = upsertedRow

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(
      createRelationAggregateUpsertInvalidation(upsertedRow, duplicateRow),
    )
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(aggregateBackfillQueries).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model relation duplicate extreme aggregate upsert silence',
      metrics: {
        aggregateBackfillQueries,
        emittedPatches,
        pageRows: 100,
        patchDurationMs,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model paginated relation aggregate delete patch transport without rerunning or backfilling', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedRelationAggregatePatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedAuthorAggregates }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts[50]
    if (!deletedRow?.author_id) {
      throw new Error('Expected benchmark relation aggregate backfill row to exist.')
    }

    const patchStartedAt = performance.now()
    tables.posts.splice(50, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateDeleteInvalidation(
      deletedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const aggregateBackfillQueries = adapter.queries.filter(query => query.sql.includes('__holo_count')).length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(aggregateBackfillQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'merge',
        path: ['data', 50],
        fields: {
          posts_avg_score: null,
          posts_max_score: null,
          posts_min_score: null,
          posts_sum_score: 0,
        },
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated relation aggregate delete patch transport',
      metrics: {
        emittedPatches,
        aggregateBackfillQueries,
        pageRows: 100,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  })

  it('measures model has-many relation patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTitle = readNestedPostTitle(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = tables.posts[499]
    if (!previousRow || typeof previousRow.author_id !== 'number') {
      throw new Error('Expected benchmark has-many relation row to exist.')
    }

    const previousTitle = previousRow.title
    const patchedRow = {
      ...previousRow,
      author_id: previousRow.author_id,
      title: 'Updated 500',
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = patchedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationUpdateInvalidation(patchedRow, previousTitle))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'posts', 0, 'title'],
      value: 'Updated 500',
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model has-many relation patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model has-many relation delete patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTitle = readNestedPostTitle(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts[499]
    if (!deletedRow || typeof deletedRow.author_id !== 'number') {
      throw new Error('Expected benchmark has-many relation row to exist.')
    }
    const relationDeletedRow = {
      ...deletedRow,
      author_id: deletedRow.author_id,
    }

    const patchStartedAt = performance.now()
    tables.posts.splice(499, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateDeleteInvalidation(relationDeletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'posts'],
      index: 0,
      deleteCount: 1,
      values: [],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model has-many relation delete patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model has-one relation delete patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTitle = readNestedFeaturedPostTitle(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts[499]
    if (!deletedRow || typeof deletedRow.author_id !== 'number') {
      throw new Error('Expected benchmark has-one relation row to exist.')
    }
    const relationDeletedRow = {
      ...deletedRow,
      author_id: deletedRow.author_id,
    }

    const patchStartedAt = performance.now()
    tables.posts.splice(499, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateDeleteInvalidation(relationDeletedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTitle).toBe('Post 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'featuredPost'],
      value: null,
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model has-one relation delete patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model has-one relation parent key move patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    tables.posts.splice(500, 1)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialSourceTitle = ''
    let observedInitialTargetTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialSourceTitle = readNestedFeaturedPostTitle(snapshot.data[499])
        observedInitialTargetTitle = readNestedFeaturedPostTitle(snapshot.data[500])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = tables.posts[499]
    if (!previousRow || typeof previousRow.author_id !== 'number') {
      throw new Error('Expected benchmark has-one relation move row to exist.')
    }
    const movedRow = {
      ...previousRow,
      author_id: 501,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = movedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationParentKeyMoveInvalidation(
      movedRow,
      previousRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialSourceTitle).toBe('Post 500')
    expect(observedInitialTargetTitle).toBe('')
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: [499, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [500, 'featuredPost'],
        value: movedRow,
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model has-one relation parent key move patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures constrained model has-one relation parent key move patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const previousRow = tables.posts[499]
    if (!previousRow || typeof previousRow.author_id !== 'number') {
      throw new Error('Expected benchmark constrained has-one relation move row to exist.')
    }
    const publishedRow = {
      ...previousRow,
      title: 'Published',
    }
    tables.posts[499] = publishedRow
    const targetRow = tables.posts[500]
    if (targetRow) {
      tables.posts[500] = {
        ...targetRow,
        title: 'Draft',
      }
    }
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelConstrainedHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialSourceTitle = ''
    let observedInitialTargetTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialSourceTitle = readNestedFeaturedPostTitle(snapshot.data[499])
        observedInitialTargetTitle = readNestedFeaturedPostTitle(snapshot.data[500])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const movedRow = {
      ...publishedRow,
      author_id: 501,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = movedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationParentKeyMoveInvalidation(
      movedRow,
      publishedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialSourceTitle).toBe('Published')
    expect(observedInitialTargetTitle).toBe('')
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: [499, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [500, 'featuredPost'],
        value: movedRow,
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained model has-one relation parent key move patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures range-constrained model has-one relation parent key move patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const previousRow = tables.posts[499]
    if (!previousRow || typeof previousRow.author_id !== 'number') {
      throw new Error('Expected benchmark range has-one relation move row to exist.')
    }
    const scoredRow = {
      ...previousRow,
      score: 20_001,
    }
    tables.posts[499] = scoredRow
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelRangeHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialSourceTitle = ''
    let observedInitialTargetTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialSourceTitle = readNestedFeaturedPostTitle(snapshot.data[499])
        observedInitialTargetTitle = readNestedFeaturedPostTitle(snapshot.data[500])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const movedRow = {
      ...scoredRow,
      author_id: 501,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = movedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationParentKeyMoveInvalidation(
      movedRow,
      scoredRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialSourceTitle).toBe(scoredRow.title)
    expect(observedInitialTargetTitle).toBe('')
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: [499, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [500, 'featuredPost'],
        value: movedRow,
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime range-constrained model has-one relation parent key move patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures not-in constrained model has-one relation parent key move patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const previousRow = tables.posts[499]
    if (!previousRow || typeof previousRow.author_id !== 'number') {
      throw new Error('Expected benchmark not-in has-one relation move row to exist.')
    }
    const publishedRow = {
      ...previousRow,
      title: 'Published',
    }
    tables.posts[499] = publishedRow
    const targetRow = tables.posts[500]
    if (targetRow) {
      tables.posts[500] = {
        ...targetRow,
        title: 'Draft',
      }
    }
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelNotInHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialSourceTitle = ''
    let observedInitialTargetTitle = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialSourceTitle = readNestedFeaturedPostTitle(snapshot.data[499])
        observedInitialTargetTitle = readNestedFeaturedPostTitle(snapshot.data[500])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const movedRow = {
      ...publishedRow,
      author_id: 501,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = movedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationParentKeyMoveInvalidation(
      movedRow,
      publishedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialSourceTitle).toBe('Published')
    expect(observedInitialTargetTitle).toBe('')
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: [499, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [500, 'featuredPost'],
        value: movedRow,
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime not-in constrained model has-one relation parent key move patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model has-many eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }

    const patchStartedAt = performance.now()
    tables.authors.push(insertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorInsertInvalidation(insertedAuthor))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [{
        ...insertedAuthor,
        posts: [],
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model has-many eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures grouped has-many eager related hydration for batched parent inserts', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length
    const firstInsertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }
    const secondInsertedAuthor = {
      id: patchRowCount + 2,
      name: `Author ${patchRowCount + 2}`,
    }
    const firstRelatedPost = {
      author_id: firstInsertedAuthor.id,
      id: patchRowCount + 1,
      score: 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 1,
    }
    const secondRelatedPost = {
      author_id: secondInsertedAuthor.id,
      id: patchRowCount + 2,
      score: 2,
      title: `Post ${patchRowCount + 2}`,
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(firstRelatedPost, secondRelatedPost)
    tables.authors.push(firstInsertedAuthor, secondInsertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createAuthorInsertInvalidation(firstInsertedAuthor),
      createAuthorInsertInvalidation(secondInsertedAuthor),
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueries = adapter.queries.slice(setupQueryCount)
    const groupedRelatedHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "author_id" IN (?, ?)').length
    const singleRelatedHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "author_id" = ?').length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(groupedRelatedHydrationQueries).toBe(1)
    expect(singleRelatedHydrationQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [
        {
          ...firstInsertedAuthor,
          posts: [firstRelatedPost],
        },
        {
          ...secondInsertedAuthor,
          posts: [secondRelatedPost],
        },
      ],
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime grouped has-many eager related hydration',
      metrics: {
        emittedPatches,
        groupedRelatedHydrationQueries,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        singleRelatedHydrationQueries,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures projected eager relation hidden update silence without relation backfill', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const { Author } = createBenchmarkAuthorPostModels()
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = defineRealtimeQuery({
      name: 'benchmark.posts.projectedEagerHiddenUpdate',
      access: 'public',
      handler: async ({ db: context }) => {
        counters.queryExecutions += 1
        return await context
          .model(Author)
          .query()
          .select('id', 'name')
          .with('posts')
          .orderBy('id')
          .getJson()
      },
    })
    let emittedPatches = 0
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length
    const author = tables.authors[499]
    if (!author) {
      throw new Error('Expected benchmark projected eager author to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorHiddenUpdateInvalidation(author))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueryCount = adapter.queries.length - setupQueryCount

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(0)
    expect(patchQueryCount).toBe(0)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime projected eager relation hidden update silence',
      metrics: {
        emittedPatches,
        patchDurationMs,
        patchQueryCount,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model has-one eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }

    const patchStartedAt = performance.now()
    tables.authors.push(insertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorInsertInvalidation(insertedAuthor))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [{
        ...insertedAuthor,
        featuredPost: null,
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model has-one eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures grouped has-one eager related hydration for batched parent inserts', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length
    const firstInsertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }
    const secondInsertedAuthor = {
      id: patchRowCount + 2,
      name: `Author ${patchRowCount + 2}`,
    }
    const firstRelatedPost = {
      author_id: firstInsertedAuthor.id,
      id: patchRowCount + 1,
      score: 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 1,
    }
    const secondRelatedPost = {
      author_id: secondInsertedAuthor.id,
      id: patchRowCount + 2,
      score: 2,
      title: `Post ${patchRowCount + 2}`,
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(firstRelatedPost, secondRelatedPost)
    tables.authors.push(firstInsertedAuthor, secondInsertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createAuthorInsertInvalidation(firstInsertedAuthor),
      createAuthorInsertInvalidation(secondInsertedAuthor),
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueries = adapter.queries.slice(setupQueryCount)
    const groupedRelatedHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "author_id" IN (?, ?)').length
    const singleRelatedHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "author_id" = ? LIMIT 1').length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(groupedRelatedHydrationQueries).toBe(1)
    expect(singleRelatedHydrationQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [
        {
          ...firstInsertedAuthor,
          featuredPost: firstRelatedPost,
        },
        {
          ...secondInsertedAuthor,
          featuredPost: secondRelatedPost,
        },
      ],
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime grouped has-one eager related hydration',
      metrics: {
        emittedPatches,
        groupedRelatedHydrationQueries,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        singleRelatedHydrationQueries,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures grouped ordered has-one eager related hydration with top-one SQL', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelOrderedHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length
    const firstInsertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }
    const secondInsertedAuthor = {
      id: patchRowCount + 2,
      name: `Author ${patchRowCount + 2}`,
    }
    const firstOlderPost = {
      author_id: firstInsertedAuthor.id,
      id: patchRowCount + 1,
      score: 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 1,
    }
    const secondOlderPost = {
      author_id: secondInsertedAuthor.id,
      id: patchRowCount + 2,
      score: 2,
      title: `Post ${patchRowCount + 2}`,
      user_id: 1,
    }
    const firstLatestPost = {
      author_id: firstInsertedAuthor.id,
      id: patchRowCount + 3,
      score: 3,
      title: `Post ${patchRowCount + 3}`,
      user_id: 1,
    }
    const secondLatestPost = {
      author_id: secondInsertedAuthor.id,
      id: patchRowCount + 4,
      score: 4,
      title: `Post ${patchRowCount + 4}`,
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(firstOlderPost, secondOlderPost, firstLatestPost, secondLatestPost)
    tables.authors.push(firstInsertedAuthor, secondInsertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createAuthorInsertInvalidation(firstInsertedAuthor),
      createAuthorInsertInvalidation(secondInsertedAuthor),
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueries = adapter.queries.slice(setupQueryCount)
    const groupedTopOneSql = 'SELECT * FROM (SELECT *, "author_id" AS "__holo_related_group_id", ROW_NUMBER() OVER (PARTITION BY "author_id" ORDER BY "id" DESC) AS "__holo_related_row_number" FROM "posts" WHERE "author_id" IN (?, ?)) AS "__holo_grouped_related_rows" WHERE "__holo_related_row_number" <= ? ORDER BY "__holo_related_group_id" ASC, "__holo_related_row_number" ASC'
    const groupedTopOneHydrationQueries = patchQueries.filter(query => query.sql === groupedTopOneSql).length
    const groupedOverfetchHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "author_id" IN (?, ?) ORDER BY "id" DESC').length
    const singleRelatedHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "author_id" = ? ORDER BY "id" DESC LIMIT 1').length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(groupedTopOneHydrationQueries).toBe(1)
    expect(groupedOverfetchHydrationQueries).toBe(0)
    expect(singleRelatedHydrationQueries).toBe(0)
    expect(patchQueries.find(candidate => candidate.sql === groupedTopOneSql)?.bindings).toEqual([
      firstInsertedAuthor.id,
      secondInsertedAuthor.id,
      1,
    ])
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [
        {
          ...firstInsertedAuthor,
          featuredPost: firstLatestPost,
        },
        {
          ...secondInsertedAuthor,
          featuredPost: secondLatestPost,
        },
      ],
    }])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime grouped ordered has-one eager related hydration top-one',
      metrics: {
        emittedPatches,
        groupedOverfetchHydrationQueries,
        groupedTopOneHydrationQueries,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        singleRelatedHydrationQueries,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures ordered model has-many eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const insertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }
    const secondPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 2,
      score: 2,
      title: `Post ${patchRowCount + 2}`,
      user_id: 1,
    }
    const firstPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 1,
      score: 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 1,
    }
    tables.posts.push(secondPost, firstPost)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelOrderedHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    tables.authors.push(insertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorInsertInvalidation(insertedAuthor))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [{
        ...insertedAuthor,
        posts: [firstPost, secondPost],
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime ordered model has-many eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures ordered model has-one eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const insertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }
    const lowerPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 1,
      score: 1,
      title: `Post ${patchRowCount + 1}`,
      user_id: 1,
    }
    const selectedPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 2,
      score: 2,
      title: `Post ${patchRowCount + 2}`,
      user_id: 1,
    }
    tables.posts.push(lowerPost, selectedPost)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelOrderedHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    tables.authors.push(insertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorInsertInvalidation(insertedAuthor))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [{
        ...insertedAuthor,
        featuredPost: selectedPost,
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime ordered model has-one eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures constrained model has-many eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const insertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }
    const firstPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 1,
      score: 1,
      title: 'Published',
      user_id: 1,
    }
    const draftPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 2,
      score: 2,
      title: 'Draft',
      user_id: 1,
    }
    const secondPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 3,
      score: 3,
      title: 'Published',
      user_id: 1,
    }
    tables.posts.push(secondPost, draftPost, firstPost)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelConstrainedHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    tables.authors.push(insertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorInsertInvalidation(insertedAuthor))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [{
        ...insertedAuthor,
        posts: [firstPost, secondPost],
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained model has-many eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures constrained model has-one eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const insertedAuthor = {
      id: patchRowCount + 1,
      name: `Author ${patchRowCount + 1}`,
    }
    const lowerPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 1,
      score: 1,
      title: 'Published',
      user_id: 1,
    }
    const draftPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 2,
      score: 2,
      title: 'Draft',
      user_id: 1,
    }
    const selectedPost = {
      author_id: insertedAuthor.id,
      id: patchRowCount + 3,
      score: 3,
      title: 'Published',
      user_id: 1,
    }
    tables.posts.push(lowerPost, draftPost, selectedPost)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelConstrainedHasOneRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))

    const patchStartedAt = performance.now()
    tables.authors.push(insertedAuthor)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorInsertInvalidation(insertedAuthor))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [{
        ...insertedAuthor,
        featuredPost: selectedPost,
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained model has-one eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to relation update patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialAuthorName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialAuthorName = readNestedAuthorName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousAuthor = tables.authors[499]
    if (!previousAuthor) {
      throw new Error('Expected benchmark belongs-to relation author to exist.')
    }

    const patchedAuthor = {
      ...previousAuthor,
      name: 'Updated Author 500',
    }

    const patchStartedAt = performance.now()
    tables.authors[499] = patchedAuthor
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createAuthorUpdateInvalidation(
      patchedAuthor,
      previousAuthor.name,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialAuthorName).toBe('Author 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'author', 'name'],
      value: patchedAuthor.name,
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to relation update patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to parent key swap patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialAuthorName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialAuthorName = readNestedAuthorName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousPost = tables.posts[499]
    if (!previousPost || typeof previousPost.author_id !== 'number') {
      throw new Error('Expected benchmark belongs-to parent row to exist.')
    }

    const patchedPost = {
      ...previousPost,
      author_id: 501,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = patchedPost
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createBelongsToParentKeyUpdateInvalidation(
      patchedPost,
      previousPost as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialAuthorName).toBe('Author 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'merge',
      path: [499],
      fields: {
        author: {
          id: 501,
          name: 'Author 501',
        },
        author_id: 501,
      },
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to parent key swap patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to parent key null swap patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialAuthorName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialAuthorName = readNestedAuthorName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousPost = tables.posts[499]
    if (!previousPost || typeof previousPost.author_id !== 'number') {
      throw new Error('Expected benchmark belongs-to nullable parent row to exist.')
    }

    const patchedPost = {
      ...previousPost,
      author_id: null,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = patchedPost
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createNullableBelongsToParentKeyUpdateInvalidation(
      patchedPost,
      previousPost as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialAuthorName).toBe('Author 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'merge',
      path: [499],
      fields: {
        author: null,
        author_id: null,
      },
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to parent key null swap patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 500,
      id: patchRowCount + 1,
      score: 20_001,
      title: 'Inserted belongs-to post',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [],
      index: patchRowCount,
      deleteCount: 0,
      values: [{
        ...insertedRow,
        author: {
          id: 500,
          name: 'Author 500',
        },
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures grouped belongs-to eager parent hydration for batched inserts', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData() {
        counters.emittedSnapshots += 1
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const setupQueryCount = adapter.queries.length
    const firstInsertedRow = {
      author_id: 500,
      id: patchRowCount + 1,
      score: 20_001,
      title: 'Inserted belongs-to post 1',
      user_id: 1,
    }
    const secondInsertedRow = {
      author_id: 501,
      id: patchRowCount + 2,
      score: 20_002,
      title: 'Inserted belongs-to post 2',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(firstInsertedRow, secondInsertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName,
      dependencies: [],
    }, [
      createRelationAggregateInsertInvalidation(firstInsertedRow),
      createRelationAggregateInsertInvalidation(secondInsertedRow),
    ])
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchQueries = adapter.queries.slice(setupQueryCount)
    const groupedParentHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "authors" WHERE "id" IN (?, ?)').length
    const singleParentHydrationQueries = patchQueries.filter(query => query.sql === 'SELECT * FROM "authors" WHERE "id" = ? LIMIT 1').length

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(groupedParentHydrationQueries).toBe(1)
    expect(singleParentHydrationQueries).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: patchRowCount,
        deleteCount: 0,
        values: [
          {
            ...firstInsertedRow,
            author: {
              id: 500,
              name: 'Author 500',
            },
          },
          {
            ...secondInsertedRow,
            author: {
              id: 501,
              name: 'Author 501',
            },
          },
        ],
      },
    ])

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime grouped belongs-to eager parent hydration',
      metrics: {
        emittedPatches,
        groupedParentHydrationQueries,
        patchDurationMs,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        singleParentHydrationQueries,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model paginated belongs-to eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 1,
      id: 0,
      score: 20_001,
      title: 'Inserted paginated belongs-to post',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{
          ...insertedRow,
          author: {
            id: 1,
            name: 'Author 1',
          },
        }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          lastPage: 11,
          total: patchRowCount + 1,
        },
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated belongs-to eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        pageRows: 100,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model paginated belongs-to eager delete backfill patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts.shift()
    const backfilledRow = tables.posts[99]
    if (!deletedRow || !backfilledRow) {
      throw new Error('Expected benchmark paginated belongs-to delete and backfill rows to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateDeleteInvalidation(
      deletedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [{
          ...backfilledRow,
          author: {
            id: 101,
            name: 'Author 101',
          },
        }],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: patchRowCount - 1,
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated belongs-to eager delete backfill patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        pageRows: 100,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model paginated offset-window belongs-to eager delete backfill patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelPaginatedOffsetBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTotal = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialTotal = snapshot.data.meta.total
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts.shift()
    const backfilledRow = tables.posts[199]
    if (!deletedRow || !backfilledRow) {
      throw new Error('Expected benchmark paginated offset belongs-to delete and backfill rows to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateDeleteInvalidation(
      deletedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTotal).toBe(patchRowCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [{
          ...backfilledRow,
          author: {
            id: 201,
            name: 'Author 201',
          },
        }],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: patchRowCount - 1,
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model paginated offset-window belongs-to eager delete backfill patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        pageRows: 100,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
        totalRows: observedInitialTotal,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model simple-paginated belongs-to eager delete backfill patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkSimplePaginatedRows }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts.shift()
    const backfilledRow = tables.posts[99]
    if (!deletedRow || !backfilledRow) {
      throw new Error('Expected benchmark simple-paginated belongs-to delete and backfill rows to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateDeleteInvalidation(
      deletedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [{
          ...backfilledRow,
          author: {
            id: 101,
            name: 'Author 101',
          },
        }],
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated belongs-to eager delete backfill patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        pageRows: 100,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model simple-paginated belongs-to eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelSimplePaginatedBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkSimplePaginatedRows }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 1,
      id: 0,
      score: 20_001,
      title: 'Inserted simple-paginated belongs-to post',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{
          ...insertedRow,
          author: {
            id: 1,
            name: 'Author 1',
          },
        }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model simple-paginated belongs-to eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        pageRows: 100,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model cursor-paginated belongs-to eager parent insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelCursorPaginatedBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkCursorPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = snapshot.data.nextCursor
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 1,
      id: 0,
      score: 20_001,
      title: 'Inserted cursor belongs-to post',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.unshift(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([99]),
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{
          ...insertedRow,
          author: {
            id: 1,
            name: 'Author 1',
          },
        }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 100,
        deleteCount: 1,
        values: [],
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model cursor-paginated belongs-to eager parent insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        pageRows: 100,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model cursor-paginated belongs-to eager delete backfill patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelCursorPaginatedBelongsToRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialCursor: string | null = null
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: BenchmarkCursorPaginatedRows }) {
        counters.emittedSnapshots += 1
        observedInitialCursor = snapshot.data.nextCursor
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedRow = tables.posts.shift()
    const backfilledRow = tables.posts[99]
    if (!deletedRow || !backfilledRow) {
      throw new Error('Expected benchmark cursor belongs-to delete and backfill rows to exist.')
    }

    const patchStartedAt = performance.now()
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateDeleteInvalidation(
      deletedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialCursor).toBe(encodeBenchmarkCursor([100]))
    expect(observedPatch?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: encodeBenchmarkCursor([101]),
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 99,
        deleteCount: 0,
        values: [{
          ...backfilledRow,
          author: {
            id: 101,
            name: 'Author 101',
          },
        }],
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model cursor-paginated belongs-to eager delete backfill patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        pageRows: 100,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures ordered model has-many relation insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelOrderedHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialPostCount = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialPostCount = readNestedPostCount(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 500,
      id: patchRowCount + 1,
      score: 20_001,
      title: 'Inserted ordered relation post',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialPostCount).toBe(1)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'posts'],
      index: 1,
      deleteCount: 0,
      values: [insertedRow],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime ordered model has-many relation insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures constrained model has-many relation insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelConstrainedHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialPostCount = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialPostCount = readNestedPostCount(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 500,
      id: patchRowCount + 1,
      score: 20_001,
      title: 'Published',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialPostCount).toBe(0)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'posts'],
      index: 0,
      deleteCount: 0,
      values: [insertedRow],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained model has-many relation insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures not-equal constrained model has-many relation insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelNotEqualHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialPostCount = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialPostCount = readNestedPostCount(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 500,
      id: patchRowCount + 1,
      score: 20_001,
      title: 'Published',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialPostCount).toBe(1)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'posts'],
      index: 1,
      deleteCount: 0,
      values: [insertedRow],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime not-equal constrained model has-many relation insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures in-constrained model has-many relation insert patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelInHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialPostCount = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialPostCount = readNestedPostCount(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 500,
      id: patchRowCount + 1,
      score: 20_001,
      title: 'Featured',
      user_id: 1,
    }

    const patchStartedAt = performance.now()
    tables.posts.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialPostCount).toBe(1)
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'posts'],
      index: 1,
      deleteCount: 0,
      values: [insertedRow],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime in-constrained model has-many relation insert patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures ordered model has-many relation parent key move patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    tables.posts.splice(500, 1)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelOrderedHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialSourceCount = 0
    let observedInitialTargetCount = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialSourceCount = readNestedPostCount(snapshot.data[499])
        observedInitialTargetCount = readNestedPostCount(snapshot.data[500])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousRow = tables.posts[499]
    if (!previousRow || typeof previousRow.author_id !== 'number') {
      throw new Error('Expected benchmark ordered has-many relation move row to exist.')
    }
    const movedRow = {
      ...previousRow,
      author_id: 501,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = movedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationParentKeyMoveInvalidation(
      movedRow,
      previousRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialSourceCount).toBe(1)
    expect(observedInitialTargetCount).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: [499, 'posts'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: [500, 'posts'],
        index: 0,
        deleteCount: 0,
        values: [movedRow],
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime ordered model has-many relation parent key move patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures constrained model has-many relation parent key move patch transport without rerunning the query', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const previousRow = tables.posts[499]
    if (!previousRow || typeof previousRow.author_id !== 'number') {
      throw new Error('Expected benchmark constrained has-many relation move row to exist.')
    }
    const publishedRow = {
      ...previousRow,
      title: 'Published',
    }
    tables.posts[499] = publishedRow
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelConstrainedHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialSourceCount = 0
    let observedInitialTargetCount = 0
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialSourceCount = readNestedPostCount(snapshot.data[499])
        observedInitialTargetCount = readNestedPostCount(snapshot.data[500])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const movedRow = {
      ...publishedRow,
      author_id: 501,
    }

    const patchStartedAt = performance.now()
    tables.posts[499] = movedRow
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationParentKeyMoveInvalidation(
      movedRow,
      publishedRow as BenchmarkPostRow & { readonly author_id: number },
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialSourceCount).toBe(1)
    expect(observedInitialTargetCount).toBe(0)
    expect(observedPatch?.operations).toEqual([
      {
        op: 'splice',
        path: [499, 'posts'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: [500, 'posts'],
        index: 0,
        deleteCount: 0,
        values: [movedRow],
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime constrained model has-many relation parent key move patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model has-many relation insert shared fallback without per-subscriber reruns', async () => {
    const tables = createRelationAggregateBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelHasManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedFinalPostCount = 0
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedFinalPostCount = readNestedPostCount(snapshot.data[499])
      },
      onPatch() {
        emittedPatches += 1
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const insertedRow = {
      author_id: 500,
      id: patchRowCount + 1,
      score: 20_001,
      title: 'Inserted relation post',
      user_id: 1,
    }

    const fallbackStartedAt = performance.now()
    tables.posts.push(insertedRow)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createRelationAggregateInsertInvalidation(insertedRow))
    const fallbackDurationMs = Number((performance.now() - fallbackStartedAt).toFixed(3))
    const refreshedDataBytes = jsonByteLength(realtimeRuntimeInternals.getRuntimeState().queryEntries.values().next().value?.current?.data)

    expect(counters.queryExecutions).toBe(2)
    expect(counters.emittedSnapshots).toBe(subscriptionCount * 2)
    expect(emittedPatches).toBe(0)
    expect(observedFinalPostCount).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model has-many relation insert shared fallback',
      metrics: {
        emittedPatches,
        fallbackDurationMs,
        fullDataBytes,
        queryExecutions: counters.queryExecutions,
        refreshedDataBytes,
        setupDurationMs,
        snapshots: counters.emittedSnapshots,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to-many relation attach patch transport without rerunning the query', async () => {
    const tables = createBelongsToManyBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTagName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTagName = readNestedTagName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const attachedTag: BenchmarkTagRow = {
      id: patchRowCount + 1,
      name: 'Attached Tag',
    }
    const attachedPivot: BenchmarkPostTagRow = {
      id: patchRowCount + 1,
      postId: 500,
      tagId: attachedTag.id,
    }

    const patchStartedAt = performance.now()
    tables.tags.push(attachedTag)
    tables.post_tags.push(attachedPivot)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createBelongsToManyAttachInvalidation(attachedPivot))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTagName).toBe('Tag 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'tags'],
      index: 1,
      deleteCount: 0,
      values: [{
        id: attachedTag.id,
        name: attachedTag.name,
        pivot: {
          id: attachedPivot.id,
          postId: attachedPivot.postId,
          tagId: attachedPivot.tagId,
        },
      }],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to-many relation attach patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to-many pivot update patch transport without rerunning the query', async () => {
    const tables = createBelongsToManyBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTagName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTagName = readNestedTagName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousPivot = tables.post_tags[499]
    if (!previousPivot || typeof previousPivot.weight !== 'number') {
      throw new Error('Expected benchmark belongs-to-many pivot row to exist.')
    }

    const patchedPivot = {
      ...previousPivot,
      weight: 2_000,
    }
    const patchStartedAt = performance.now()
    tables.post_tags[499] = patchedPivot
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createBelongsToManyPivotUpdateInvalidation(
      patchedPivot,
      previousPivot.weight,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTagName).toBe('Tag 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'tags', 0, 'pivot'],
      value: {
        id: patchedPivot.id,
        postId: patchedPivot.postId,
        tagId: patchedPivot.tagId,
        weight: patchedPivot.weight,
      },
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to-many pivot update patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to-many pivot order update move patch transport without rerunning the query', async () => {
    const tables = createBelongsToManyBenchmarkTables()
    const secondTag: BenchmarkTagRow = {
      id: patchRowCount + 1,
      name: 'Second Tag 500',
    }
    const secondPivot: BenchmarkPostTagRow = {
      id: patchRowCount + 1,
      postId: 500,
      tagId: secondTag.id,
      weight: 1_500,
    }
    tables.tags.push(secondTag)
    tables.post_tags.push(secondPivot)
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToManyWeightOrderedRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTagName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTagName = readNestedTagName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousPivot = tables.post_tags[499]
    if (!previousPivot || typeof previousPivot.weight !== 'number') {
      throw new Error('Expected benchmark belongs-to-many pivot row to exist.')
    }

    const patchedPivot = {
      ...previousPivot,
      weight: 2_000,
    }
    const patchStartedAt = performance.now()
    tables.post_tags[499] = patchedPivot
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createBelongsToManyPivotUpdateInvalidation(
      patchedPivot,
      previousPivot.weight,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTagName).toBe('Tag 500')
    expect(observedPatch?.operations).toEqual([
      {
        op: 'move',
        path: [499, 'tags'],
        from: 0,
        to: 1,
      },
      {
        op: 'replace',
        path: [499, 'tags', 1, 'pivot'],
        value: {
          id: patchedPivot.id,
          postId: patchedPivot.postId,
          tagId: patchedPivot.tagId,
          weight: patchedPivot.weight,
        },
      },
    ])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to-many pivot order update move patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to-many related row update patch transport without rerunning the query', async () => {
    const tables = createBelongsToManyBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTagName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTagName = readNestedTagName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const previousTag = tables.tags[499]
    if (!previousTag) {
      throw new Error('Expected benchmark belongs-to-many related row to exist.')
    }

    const patchedTag = {
      ...previousTag,
      name: 'Updated Tag 500',
    }
    const patchStartedAt = performance.now()
    tables.tags[499] = patchedTag
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createBelongsToManyRelatedUpdateInvalidation(
      patchedTag,
      previousTag.name,
    ))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTagName).toBe('Tag 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'replace',
      path: [499, 'tags', 0, 'name'],
      value: patchedTag.name,
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to-many related row update patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to-many related row delete patch transport without rerunning the query', async () => {
    const tables = createBelongsToManyBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTagName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTagName = readNestedTagName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const deletedTag = tables.tags[499]
    if (!deletedTag) {
      throw new Error('Expected benchmark belongs-to-many related row to exist.')
    }

    const patchStartedAt = performance.now()
    tables.tags.splice(499, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createBelongsToManyRelatedDeleteInvalidation(deletedTag))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTagName).toBe('Tag 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'tags'],
      index: 0,
      deleteCount: 1,
      values: [],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to-many related row delete patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures model belongs-to-many relation detach patch transport without rerunning the query', async () => {
    const tables = createBelongsToManyBenchmarkTables()
    const adapter = new BenchmarkModelAdapter(tables)
    const db = createBenchmarkRelationDatabaseContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: connectionName,
      connections: {
        [connectionName]: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const counters: BenchmarkCounters = {
      emittedSnapshots: 0,
      queryExecutions: 0,
    }
    const query = createModelBelongsToManyRelationPatchBenchmarkQuery(counters)
    let emittedPatches = 0
    let fullDataBytes = 0
    let observedInitialTagName = ''
    let observedPatch: BenchmarkPatch | undefined
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        counters.emittedSnapshots += 1
        if (fullDataBytes === 0) {
          fullDataBytes = jsonByteLength(snapshot.data)
        }
        observedInitialTagName = readNestedTagName(snapshot.data[499])
      },
      onPatch(patch: BenchmarkPatch) {
        emittedPatches += 1
        observedPatch = patch
      },
    }

    const setupStartedAt = performance.now()
    await Promise.all(Array.from({ length: subscriptionCount }, async () => {
      await subscribeRealtimeQuery(query, {}, patchOptions)
    }))
    const setupDurationMs = Number((performance.now() - setupStartedAt).toFixed(3))
    const detachedPivot = tables.post_tags[499]
    if (!detachedPivot) {
      throw new Error('Expected benchmark belongs-to-many pivot row to exist.')
    }

    const patchStartedAt = performance.now()
    tables.post_tags.splice(499, 1)
    await realtimeRuntimeInternals.handleDatabaseInvalidation(createBelongsToManyDetachInvalidation(detachedPivot))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(counters.queryExecutions).toBe(1)
    expect(counters.emittedSnapshots).toBe(subscriptionCount)
    expect(emittedPatches).toBe(subscriptionCount)
    expect(observedInitialTagName).toBe('Tag 500')
    expect(observedPatch?.operations).toEqual([{
      op: 'splice',
      path: [499, 'tags'],
      index: 0,
      deleteCount: 1,
      values: [],
    }])
    const patchBytes = jsonByteLength(observedPatch)
    expect(patchBytes).toBeLessThan(fullDataBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime model belongs-to-many relation detach patch transport',
      metrics: {
        emittedPatches,
        fullDataBytes,
        patchDurationMs,
        patchBytes,
        patchOperations: observedPatch?.operations.length ?? 0,
        queryExecutions: counters.queryExecutions,
        setupDurationMs,
        subscriptions: subscriptionCount,
      },
    }))
  }, longBenchmarkTimeoutMs)

  it('measures server patch operation coalescing for append bursts without expanding window slides', () => {
    const burstRows = createPatchBenchmarkRows()
    const burstOperations = burstRows.flatMap((row, index) => [
      createSplicePatchOperation([], index, 0, [row]),
      createSplicePatchOperation([], index + 1, 0, []),
    ])
    const rawBurstPatch = {
      operations: burstOperations,
      version: 1,
    }
    const compactStartedAt = performance.now()
    const compactedBurstOperations = compactPatchOperations(burstOperations)
    const compactDurationMs = Number((performance.now() - compactStartedAt).toFixed(3))
    const compactedBurstPatch = {
      operations: compactedBurstOperations,
      version: 1,
    }
    const slideBackfillRow = createPatchBenchmarkRows()[100]
    if (!slideBackfillRow) {
      throw new Error('Expected benchmark slide backfill row to exist.')
    }

    const slideOperations = [
      createSplicePatchOperation([], 0, 1, []),
      createSplicePatchOperation([], 99, 0, [slideBackfillRow]),
    ]
    const compactedSlideOperations = compactPatchOperations(slideOperations)
    const rawBurstBytes = jsonByteLength(rawBurstPatch)
    const compactedBurstBytes = jsonByteLength(compactedBurstPatch)
    const compactedOperation = compactedBurstOperations[0]

    expect(compactedBurstOperations).toHaveLength(1)
    expect(compactedOperation?.op).toBe('splice')
    if (compactedOperation?.op !== 'splice') {
      throw new Error('Expected compacted burst operation to be a splice.')
    }
    expect(compactedOperation.index).toBe(0)
    expect(compactedOperation.deleteCount).toBe(0)
    expect(compactedOperation.values).toHaveLength(patchRowCount)
    expect(compactedSlideOperations).toEqual(slideOperations)
    expect(compactedBurstBytes).toBeLessThan(rawBurstBytes)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime server patch operation coalescing',
      metrics: {
        compactDurationMs,
        compactedBurstBytes,
        compactedBurstOperations: compactedBurstOperations.length,
        rawBurstBytes,
        rawBurstOperations: burstOperations.length,
        slideOperations: compactedSlideOperations.length,
      },
    }))
  })

  it('measures client store patch application with structural sharing', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostRow[]>(
      'benchmark.posts.clientPatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows()
    store.setSnapshot({
      name: 'benchmark.posts.clientPatchRows',
      data: rows,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialRows = store.snapshot?.data
    if (!initialRows) {
      throw new Error('Expected benchmark store snapshot to be initialized.')
    }

    const operations = createClientPatchOperations(100)
    const changedIndexes = new Set(operations.map(operation => Number(operation.path[0])))
    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations,
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchedRows = store.snapshot?.data
    if (!patchedRows) {
      throw new Error('Expected benchmark store snapshot to remain initialized.')
    }

    let preservedRows = 0
    let changedRows = 0
    for (let index = 0; index < patchedRows.length; index += 1) {
      const row = patchedRows[index]
      if (!row) {
        throw new Error('Expected benchmark row to exist.')
      }

      if (changedIndexes.has(index)) {
        changedRows += 1
        expect(row).not.toBe(initialRows[index])
        expect(row.title).toBe(`Updated ${index + 1}`)
        continue
      }

      preservedRows += 1
      expect(row).toBe(initialRows[index])
    }

    const clonedRows = cloneRows(patchedRows)
    const fullSnapshotStartedAt = performance.now()
    store.setSnapshot({
      name: 'benchmark.posts.clientPatchRows',
      data: clonedRows,
      dependencies: [tableDependency(), 'db:main:comments'],
      version: 3,
    })
    const fullSnapshotDedupeDurationMs = Number((performance.now() - fullSnapshotStartedAt).toFixed(3))

    expect(store.snapshot?.data).toBe(patchedRows)
    expect(store.snapshot?.dependencies).toEqual([tableDependency(), 'db:main:comments'])
    expect(store.snapshot?.version).toBe(3)
    expect(emittedSnapshots).toBe(2)
    expect(changedRows).toBe(operations.length)
    expect(preservedRows).toBe(patchRowCount - operations.length)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client structural sharing',
      metrics: {
        changedRows,
        emittedSnapshots,
        fullSnapshotDedupeDurationMs,
        patchDurationMs,
        patchOperations: operations.length,
        patchRows: patchRowCount,
        preservedRows,
      },
    }))
  })

  it('measures client store merge patch application with structural sharing', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostRow[]>(
      'benchmark.posts.clientMergePatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows()
    store.setSnapshot({
      name: 'benchmark.posts.clientMergePatchRows',
      data: rows,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialRows = store.snapshot?.data
    if (!initialRows) {
      throw new Error('Expected benchmark store snapshot to be initialized.')
    }

    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'merge',
        path: [499],
        fields: {
          title: 'Updated 500',
          user_id: 2,
        },
      }],
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchedRows = store.snapshot?.data
    if (!patchedRows) {
      throw new Error('Expected benchmark store snapshot to remain initialized.')
    }

    expect(patchedRows).toHaveLength(patchRowCount)
    expect(patchedRows[499]).not.toBe(initialRows[499])
    expect(patchedRows[499]).toEqual({
      id: 500,
      title: 'Updated 500',
      user_id: 2,
    })
    expect(patchedRows[498]).toBe(initialRows[498])
    expect(patchedRows[500]).toBe(initialRows[500])
    expect(store.snapshot?.version).toBe(2)
    expect(emittedSnapshots).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client merge structural sharing',
      metrics: {
        changedRows: 1,
        emittedSnapshots,
        patchDurationMs,
        patchOperations: 1,
        patchRows: patchRowCount,
        preservedRows: patchRowCount - 1,
      },
    }))
  })

  it('measures client store nested wrapper merge patch application with structural sharing', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<BenchmarkPaginatedAuthorAggregates>(
      'benchmark.posts.clientNestedWrapperMergePatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const wrapper: BenchmarkPaginatedAuthorAggregates = {
      data: createRelationAggregateBenchmarkTables().authors.map(author => ({
        id: author.id,
        name: author.name,
        posts_avg_score: 10_000 + author.id,
        posts_max_score: 10_000 + author.id,
        posts_min_score: 10_000 + author.id,
        posts_sum_score: 10_000 + author.id,
      })),
      meta: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 10,
        pageName: 'page',
        perPage: 100,
        to: 100,
        total: patchRowCount,
      },
    }
    store.setSnapshot({
      name: 'benchmark.posts.clientNestedWrapperMergePatchRows',
      data: wrapper,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialWrapper = store.snapshot?.data
    if (!initialWrapper) {
      throw new Error('Expected benchmark store snapshot to be initialized.')
    }

    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'merge',
        path: ['data', 50],
        fields: {
          posts_avg_score: null,
          posts_max_score: null,
          posts_min_score: null,
          posts_sum_score: 0,
        },
      }],
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchedWrapper = store.snapshot?.data
    if (!patchedWrapper) {
      throw new Error('Expected benchmark store snapshot to remain initialized.')
    }

    expect(patchedWrapper).not.toBe(initialWrapper)
    expect(patchedWrapper.data).not.toBe(initialWrapper.data)
    expect(patchedWrapper.meta).toBe(initialWrapper.meta)
    expect(patchedWrapper.data).toHaveLength(patchRowCount)
    expect(patchedWrapper.data[50]).not.toBe(initialWrapper.data[50])
    expect(patchedWrapper.data[50]).toEqual({
      id: 51,
      name: 'Author 51',
      posts_avg_score: null,
      posts_max_score: null,
      posts_min_score: null,
      posts_sum_score: 0,
    })
    expect(patchedWrapper.data[49]).toBe(initialWrapper.data[49])
    expect(patchedWrapper.data[51]).toBe(initialWrapper.data[51])
    expect(store.snapshot?.version).toBe(2)
    expect(emittedSnapshots).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client nested wrapper merge structural sharing',
      metrics: {
        changedRows: 1,
        emittedSnapshots,
        patchDurationMs,
        patchOperations: 1,
        patchRows: patchRowCount,
        preservedMeta: 1,
        preservedRows: patchRowCount - 1,
      },
    }))
  })

  it('measures client store nested relation patch application with structural sharing', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostWithTagsRow[]>(
      'benchmark.posts.clientNestedRelationPatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows().map((row): BenchmarkPostWithTagsRow => ({
      ...row,
      tags: [
        { id: row.id * 10 + 1, name: `Tag ${row.id}.1`, pivot: { weight: 1 } },
        { id: row.id * 10 + 2, name: `Tag ${row.id}.2`, pivot: { weight: 2 } },
        { id: row.id * 10 + 3, name: `Tag ${row.id}.3`, pivot: { weight: 3 } },
      ],
    }))
    store.setSnapshot({
      name: 'benchmark.posts.clientNestedRelationPatchRows',
      data: rows,
      dependencies: [tableDependency(), 'db:main:tags', 'db:main:post_tags'],
      version: 1,
    })
    const initialRows = store.snapshot?.data
    const initialTargetRow = initialRows?.[499]
    const initialTargetTags = initialTargetRow?.tags
    const initialChangedTag = initialTargetTags?.[1]
    if (!initialRows || !initialTargetRow || !initialTargetTags || !initialChangedTag) {
      throw new Error('Expected benchmark nested relation snapshot to be initialized.')
    }

    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [
        {
          op: 'replace',
          path: [499, 'tags', 1, 'name'],
          value: 'Updated nested tag',
        },
        {
          op: 'replace',
          path: [499, 'tags', 1, 'pivot', 'weight'],
          value: 9_001,
        },
      ],
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchedRows = store.snapshot?.data
    const patchedTargetRow = patchedRows?.[499]
    const patchedTargetTags = patchedTargetRow?.tags
    const patchedChangedTag = patchedTargetTags?.[1]
    if (!patchedRows || !patchedTargetRow || !patchedTargetTags || !patchedChangedTag) {
      throw new Error('Expected benchmark nested relation snapshot to remain initialized.')
    }

    expect(patchedRows).toHaveLength(patchRowCount)
    expect(patchedRows).not.toBe(initialRows)
    expect(patchedTargetRow).not.toBe(initialTargetRow)
    expect(patchedTargetTags).not.toBe(initialTargetTags)
    expect(patchedChangedTag).not.toBe(initialChangedTag)
    expect(patchedChangedTag).toEqual({
      id: 5_002,
      name: 'Updated nested tag',
      pivot: {
        weight: 9_001,
      },
    })
    expect(patchedTargetTags[0]).toBe(initialTargetTags[0])
    expect(patchedTargetTags[2]).toBe(initialTargetTags[2])
    expect(patchedRows[498]).toBe(initialRows[498])
    expect(patchedRows[500]).toBe(initialRows[500])
    expect(store.snapshot?.version).toBe(2)
    expect(emittedSnapshots).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client nested relation structural sharing',
      metrics: {
        changedNestedRows: 1,
        changedRows: 1,
        emittedSnapshots,
        patchDurationMs,
        patchOperations: 2,
        patchRows: patchRowCount,
        preservedNestedRows: initialTargetTags.length - 1,
        preservedRows: patchRowCount - 1,
      },
    }))
  })

  it('measures client store no-op patch suppression with version advancement', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostRow[]>(
      'benchmark.posts.clientNoopPatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows()
    store.setSnapshot({
      name: 'benchmark.posts.clientNoopPatchRows',
      data: rows,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialRows = store.snapshot?.data
    if (!initialRows) {
      throw new Error('Expected benchmark store snapshot to be initialized.')
    }

    const patchStartedAt = performance.now()
    for (let version = 2; version <= subscriptionCount + 1; version += 1) {
      store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
        operations: [{
          op: 'merge',
          path: [499],
          fields: {
            title: 'Post 500',
          },
        }],
        version,
      }))
    }
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(store.snapshot?.data).toBe(initialRows)
    expect(store.snapshot?.version).toBe(subscriptionCount + 1)
    expect(emittedSnapshots).toBe(1)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client no-op patch suppression',
      metrics: {
        emittedSnapshots,
        patchDurationMs,
        patchOperations: subscriptionCount,
        patchRows: patchRowCount,
        suppressedSnapshots: subscriptionCount,
      },
    }))
  })

  it('measures client store no-op replace patch suppression with version advancement', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostRow[]>(
      'benchmark.posts.clientNoopReplacePatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows()
    store.setSnapshot({
      name: 'benchmark.posts.clientNoopReplacePatchRows',
      data: rows,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialRows = store.snapshot?.data
    if (!initialRows) {
      throw new Error('Expected benchmark store snapshot to be initialized.')
    }

    const patchStartedAt = performance.now()
    for (let version = 2; version <= subscriptionCount + 1; version += 1) {
      store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
        operations: [{
          op: 'replace',
          path: [499, 'title'],
          value: 'Post 500',
        }],
        version,
      }))
    }
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))

    expect(store.snapshot?.data).toBe(initialRows)
    expect(store.snapshot?.data[499]).toBe(initialRows[499])
    expect(store.snapshot?.version).toBe(subscriptionCount + 1)
    expect(emittedSnapshots).toBe(1)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client no-op replace patch suppression',
      metrics: {
        emittedSnapshots,
        patchDurationMs,
        patchOperations: subscriptionCount,
        patchRows: patchRowCount,
        suppressedSnapshots: subscriptionCount,
      },
    }))
  })

  it('measures client store move patch application with structural sharing', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostRow[]>(
      'benchmark.posts.clientMovePatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows()
    store.setSnapshot({
      name: 'benchmark.posts.clientMovePatchRows',
      data: rows,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialRows = store.snapshot?.data
    const movedRow = initialRows?.[499]
    if (!initialRows || !movedRow) {
      throw new Error('Expected benchmark store snapshot to be initialized.')
    }

    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [{
        op: 'move',
        path: [],
        from: 499,
        to: 0,
      }],
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchedRows = store.snapshot?.data
    if (!patchedRows) {
      throw new Error('Expected benchmark store snapshot to remain initialized.')
    }

    expect(patchedRows).toHaveLength(patchRowCount)
    expect(patchedRows[0]).toBe(movedRow)
    expect(patchedRows[1]).toBe(initialRows[0])
    expect(patchedRows[500]).toBe(initialRows[500])
    expect(store.snapshot?.version).toBe(2)
    expect(emittedSnapshots).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client move structural sharing',
      metrics: {
        emittedSnapshots,
        patchDurationMs,
        patchOperations: 1,
        patchRows: patchRowCount,
      },
    }))
  })

  it('measures client store limited-window slide patch application with structural sharing', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<readonly BenchmarkPostRow[]>(
      'benchmark.posts.clientSlidePatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows().slice(0, 100)
    store.setSnapshot({
      name: 'benchmark.posts.clientSlidePatchRows',
      data: rows,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialRows = store.snapshot?.data
    const backfilledRow = createPatchBenchmarkRows()[100]
    if (!initialRows || !backfilledRow) {
      throw new Error('Expected benchmark store snapshot and backfill row to be initialized.')
    }

    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [
        {
          op: 'splice',
          path: [],
          index: 0,
          deleteCount: 1,
          values: [],
        },
        {
          op: 'splice',
          path: [],
          index: 99,
          deleteCount: 0,
          values: [backfilledRow],
        },
      ],
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchedRows = store.snapshot?.data
    if (!patchedRows) {
      throw new Error('Expected benchmark store snapshot to remain initialized.')
    }

    expect(patchedRows).toHaveLength(100)
    expect(patchedRows[0]).toBe(initialRows[1])
    expect(patchedRows[98]).toBe(initialRows[99])
    expect(patchedRows[99]).toBe(backfilledRow)
    expect(store.snapshot?.version).toBe(2)
    expect(emittedSnapshots).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client limited-window slide structural sharing',
      metrics: {
        emittedSnapshots,
        patchDurationMs,
        patchOperations: 2,
        patchRows: 100,
        preservedRows: 99,
      },
    }))
  })

  it('measures client store paginated wrapper slide and meta patch application with structural sharing', () => {
    const store = realtimeClientInternals.createRealtimeQueryStore<BenchmarkPaginatedRows>(
      'benchmark.posts.clientPaginatedSlidePatchRows',
      {},
      createIdleBenchmarkTransport(),
    )
    let emittedSnapshots = 0
    store.subscribe(() => {
      emittedSnapshots += 1
    })

    const rows = createPatchBenchmarkRows().slice(0, 100)
    const wrapper: BenchmarkPaginatedRows = {
      data: rows,
      meta: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 11,
        pageName: 'page',
        perPage: 100,
        to: 100,
        total: patchRowCount + 1,
      },
    }
    store.setSnapshot({
      name: 'benchmark.posts.clientPaginatedSlidePatchRows',
      data: wrapper,
      dependencies: [tableDependency()],
      version: 1,
    })
    const initialWrapper = store.snapshot?.data
    const backfilledRow = createPatchBenchmarkRows()[100]
    if (!initialWrapper || !backfilledRow) {
      throw new Error('Expected benchmark wrapper snapshot and backfill row to be initialized.')
    }

    const patchStartedAt = performance.now()
    store.setSnapshot(realtimeClientInternals.applyWireSnapshotPatch(store.snapshot!, {
      operations: [
        {
          op: 'splice',
          path: ['data'],
          index: 0,
          deleteCount: 1,
          values: [],
        },
        {
          op: 'splice',
          path: ['data'],
          index: 99,
          deleteCount: 0,
          values: [backfilledRow],
        },
        {
          op: 'merge',
          path: ['meta'],
          fields: {
            total: patchRowCount,
          },
        },
      ],
      version: 2,
    }))
    const patchDurationMs = Number((performance.now() - patchStartedAt).toFixed(3))
    const patchedWrapper = store.snapshot?.data
    if (!patchedWrapper) {
      throw new Error('Expected benchmark wrapper snapshot to remain initialized.')
    }

    expect(patchedWrapper).not.toBe(initialWrapper)
    expect(patchedWrapper.data).not.toBe(initialWrapper.data)
    expect(patchedWrapper.meta).not.toBe(initialWrapper.meta)
    expect(patchedWrapper.data).toHaveLength(100)
    expect(patchedWrapper.data[0]).toBe(initialWrapper.data[1])
    expect(patchedWrapper.data[98]).toBe(initialWrapper.data[99])
    expect(patchedWrapper.data[99]).toBe(backfilledRow)
    expect(patchedWrapper.meta).toEqual({
      ...initialWrapper.meta,
      total: patchRowCount,
    })
    expect(store.snapshot?.version).toBe(2)
    expect(emittedSnapshots).toBe(2)

    console.info(JSON.stringify({
      benchmark: '@holo-js/realtime client paginated wrapper slide structural sharing',
      metrics: {
        emittedSnapshots,
        patchDurationMs,
        patchOperations: 3,
        patchRows: 100,
        preservedRows: 99,
      },
    }))
  })
})
