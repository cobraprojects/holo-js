import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createCapabilities,
  createDatabase,
  configureDB,
  createConnectionManager,
  recordDatabaseQueryDependencies,
  resetDatabaseDependencyInvalidationListeners,
  resetDB,
  belongsTo,
  belongsToMany,
  column,
  defineGeneratedTable,
  defineModel,
  hasMany,
  hasOne,
  queryCacheInternals,
  type DatabaseContext,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
} from '@holo-js/db'
import { field, schema } from '@holo-js/validation'
import {
  configureRealtimeClientTransport,
  createRealtimeClient,
  defineRealtimeMutation,
  defineRealtimeQuery,
  isRealtimeDefinition,
  resetRealtimeClientRuntime,
} from '../src/index'
import {
  configureRealtimeRuntime,
  executeRealtimeMutation,
  executeRealtimeQuery,
  RealtimeAuthUnavailableError,
  RealtimeError,
  RealtimeForbiddenError,
  RealtimeUnauthorizedError,
  realtimeRuntimeInternals,
  resetRealtimeRuntime,
  resolveRealtimeDefinition,
  subscribeRealtimeQuery,
} from '../src/server'
import {
  compactPatchOperations,
  createSplicePatchOperation,
} from '../src/runtime/patch-operations'
import { collectRelevantMutationTargets } from '../src/runtime/query-relevant-mutations'
import type { AuthenticatedAuthUser } from '@holo-js/auth'
import { recordDatabaseQueryObservation } from '../../db/src/cache'
import type {
  RealtimeAuthModule,
  RealtimeSubscribeOptions,
} from '../src/index'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import type { BackfillCache, QueryPatchTarget } from '../src/runtime/query-state'

const DATABASE_DEPENDENCY_METADATA_KEY = '__holoDatabaseDependencyMetadata__'

type MemoryRow = Record<string, unknown>
type MemoryTables = Record<string, MemoryRow[]>
type RealtimePatchForTest = {
  readonly dependencies?: readonly string[]
  readonly operations: readonly (
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
  )[]
  readonly version: number
}
type InternalRealtimeSubscribeOptionsForTest<TResult> = RealtimeSubscribeOptions<TResult> & {
  readonly onPatch?: (patch: RealtimePatchForTest) => void | Promise<void>
}

class MemoryAdapter implements DriverAdapter {
  private connected = false
  readonly rows: Record<string, unknown>[] = [
    { id: 1, title: 'First' },
  ]

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(): Promise<DriverQueryResult<TRow>> {
    return {
      rows: this.rows.map(row => ({ ...row })) as TRow[],
      rowCount: this.rows.length,
    }
  }

  async execute(): Promise<DriverExecutionResult> {
    this.rows.push({
      id: this.rows.length + 1,
      title: `Post ${this.rows.length + 1}`,
    })

    return {
      affectedRows: 1,
      lastInsertId: this.rows.length,
    }
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}
}

function readPlaceholderIndexes(rawPlaceholders: string): number[] {
  return rawPlaceholders.split(', ').map((part, index) => {
    const rawIndex = part.replace('?', '')
    return rawIndex ? Number(rawIndex) - 1 : index
  })
}

function readPlaceholderBindingIndex(sql: string, placeholderIndex: number, rawIndex: string | undefined): number {
  if (rawIndex) {
    return Number(rawIndex) - 1
  }

  return sql.slice(0, placeholderIndex).split('?').length - 1
}

function readLimitBinding(
  sql: string,
  bindings: readonly unknown[],
  match: RegExpExecArray,
  prefix: string,
): number {
  const literal = match[2]
  if (literal) {
    return Number(literal)
  }

  return Number(bindings[readPlaceholderBindingIndex(sql, match.index + prefix.length, match[1])])
}

function compareMemoryValues(left: unknown, right: unknown): number | undefined {
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

function applyMemoryPredicate(left: unknown, operator: string, right: unknown): boolean {
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
      const comparison = compareMemoryValues(left, right)
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

function filterMemoryRows(sql: string, bindings: readonly unknown[], rows: readonly MemoryRow[]): MemoryRow[] {
  const whereMatch = sql.match(/ WHERE (.+?)( GROUP BY| ORDER BY| LIMIT| OFFSET|$)/)
  if (!whereMatch) {
    return [...rows]
  }

  const clauses = whereMatch[1]!.split(' AND ')
  return rows.filter((row) => {
    let bindingIndex = 0
    return clauses.every((clause) => {
      const inMatch = clause.match(/^(?:"[^"]+"\.)?"([^"]+)" (NOT IN|IN) \((.+)\)$/)
      if (inMatch) {
        const [, column, operator, rawPlaceholders] = inMatch
        const indexes = rawPlaceholders!.split(', ').map((part, index) => {
          const rawIndex = part.replace('?', '')
          return rawIndex ? Number(rawIndex) - 1 : bindingIndex + index
        })
        const present = indexes.map(index => bindings[index]).includes(row[column!])
        bindingIndex += indexes.length
        return operator === 'IN' ? present : !present
      }

      const comparisonMatch = clause.match(/^(?:"[^"]+"\.)?"([^"]+)" (=|!=|<>|>=|>|<=|<|LIKE) \?(\d*)$/)
      if (comparisonMatch) {
        const [, column, operator, index] = comparisonMatch
        const valueIndex = index ? Number(index) - 1 : bindingIndex
        bindingIndex += 1
        return applyMemoryPredicate(row[column!], operator!, bindings[valueIndex])
      }

      return true
    })
  })
}

function projectMemoryAggregateRows(rawSelection: string, rows: readonly MemoryRow[]): MemoryRow[] | undefined {
  const aggregateRow: MemoryRow = {}
  if (!projectMemoryAggregateSelections(rawSelection, rows, aggregateRow)) {
    return undefined
  }

  return [aggregateRow]
}

function readMemoryGroupColumns(sql: string): readonly string[] {
  const groupBy = sql.match(/ GROUP BY (.+?)( HAVING| ORDER BY| LIMIT| OFFSET|$)/)?.[1]
  if (!groupBy) {
    return []
  }

  const columns = groupBy.split(', ').map(column => column.match(/^"([^"]+)"$/)?.[1])
  return columns.every((column): column is string => Boolean(column))
    ? Object.freeze(columns)
    : []
}

function readMemoryHavingCountMatcher(sql: string, bindings: readonly unknown[]): ((count: number) => boolean) | undefined {
  const match = sql.match(/ HAVING COUNT\(\*\) (=|!=|<>|>=|>|<=|<) \?(\d*)/)
  if (!match) {
    return undefined
  }

  const [, operator, rawIndex] = match
  const bindingIndex = rawIndex ? Number(rawIndex) - 1 : bindings.length - 1
  return count => applyMemoryPredicate(count, operator!, bindings[bindingIndex])
}

function createMemoryGroupKey(row: MemoryRow, columns: readonly string[]): string {
  return JSON.stringify(columns.map(column => row[column]))
}

function projectMemoryGroupedRows(
  sql: string,
  bindings: readonly unknown[],
  rawSelection: string,
  groupColumns: readonly string[],
  rows: readonly MemoryRow[],
): MemoryRow[] | undefined {
  const groupedRows = new Map<string, MemoryRow[]>()
  const groupValues = new Map<string, readonly unknown[]>()
  for (const row of rows) {
    const key = createMemoryGroupKey(row, groupColumns)
    const values = groupValues.get(key) ?? Object.freeze(groupColumns.map(column => row[column]))
    const group = groupedRows.get(key) ?? []
    group.push(row)
    groupedRows.set(key, group)
    groupValues.set(key, values)
  }

  const results: MemoryRow[] = []
  const matchesHaving = readMemoryHavingCountMatcher(sql, bindings)
  for (const [key, group] of groupedRows) {
    if (matchesHaving && !matchesHaving(group.length)) {
      continue
    }

    const values = groupValues.get(key)
    if (!values) {
      return undefined
    }

    const projected: MemoryRow = {}
    for (let index = 0; index < groupColumns.length; index += 1) {
      projected[groupColumns[index]!] = values[index]
    }

    if (!projectMemoryAggregateSelections(rawSelection, group, projected, groupColumns)) {
      return undefined
    }

    results.push(projected)
  }

  return results
}

function projectMemoryAggregateSelections(
  rawSelection: string,
  rows: readonly MemoryRow[],
  target: MemoryRow,
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

    const [, aggregate, , column, alias] = match
    if (aggregate === 'COUNT') {
      target[alias!] = rows.length
      continue
    }

    if (!column) {
      return false
    }

    const values: number[] = []
    for (const row of rows) {
      const value = row[column]
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return false
      }

      values.push(value)
    }

    if (values.length === 0) {
      target[alias!] = null
      continue
    }

    if (aggregate === 'SUM') {
      target[alias!] = values.reduce((sum, value) => sum + value, 0)
      continue
    }

    if (aggregate === 'AVG') {
      target[alias!] = values.reduce((sum, value) => sum + value, 0) / values.length
      continue
    }

    target[alias!] = aggregate === 'MIN' ? Math.min(...values) : Math.max(...values)
  }

  return true
}

function projectMemoryRows(sql: string, bindings: readonly unknown[], rows: readonly MemoryRow[]): MemoryRow[] {
  const selectMatch = sql.match(/^SELECT (.+?) FROM /)
  const rawSelection = selectMatch?.[1]
  if (!rawSelection || rawSelection === '*') {
    return rows.map(row => ({ ...row }))
  }

  const groupColumns = readMemoryGroupColumns(sql)
  if (groupColumns.length > 0) {
    const groupedRows = projectMemoryGroupedRows(sql, bindings, rawSelection, groupColumns, rows)
    if (groupedRows) {
      return groupedRows
    }
  }

  const aggregateRows = projectMemoryAggregateRows(rawSelection, rows)
  if (aggregateRows) {
    return aggregateRows
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
    const projected: MemoryRow = {}
    for (const selection of selections) {
      projected[selection!.resultKey] = row[selection!.column]
    }
    return projected
  })
}

function createMemoryWhereMatcher(rawWhere: string, bindings: readonly unknown[], fallbackBindingIndex: number): (row: MemoryRow) => boolean {
  const whereMatch = rawWhere.match(/^"([^"]+)" = \?(\d*)$/)
  const whereColumn = whereMatch?.[1] ?? ''
  const whereBindingIndex = whereMatch?.[2] ? Number(whereMatch[2]) - 1 : fallbackBindingIndex
  return row => row[whereColumn] === bindings[whereBindingIndex]
}

class RelationalMemoryAdapter implements DriverAdapter {
  private connected = false
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly executions: Array<{ sql: string, bindings: readonly unknown[] }> = []

  constructor(readonly tables: MemoryTables) {}

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
    const returningUpsertMatch = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES (.+) ON CONFLICT \((.+)\) DO UPDATE SET (.+) RETURNING \*$/)
    if (returningUpsertMatch) {
      const [, tableName, rawColumns, rawValues, rawConflictColumns, rawAssignments] = returningUpsertMatch
      const rows = this.upsertRows(tableName!, rawColumns!, rawValues!, rawConflictColumns!, rawAssignments!, bindings)
      return {
        rows: rows.map(row => ({ ...row })) as TRow[],
        rowCount: rows.length,
      }
    }

    const returningInsertMatch = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES (.+) RETURNING \*$/)
    if (returningInsertMatch) {
      const [, tableName, rawColumns, rawValues] = returningInsertMatch
      const rows = this.insertRows(tableName!, rawColumns!, rawValues!, bindings)
      return {
        rows: rows.map(row => ({ ...row })) as TRow[],
        rowCount: rows.length,
      }
    }

    const returningUpdateMatch = sql.match(/^UPDATE "([^"]+)" SET (.+?) WHERE (.+) RETURNING \*$/)
    if (returningUpdateMatch) {
      const [, tableName, rawAssignments, rawWhere] = returningUpdateMatch
      const rows = this.updateRows(tableName!, rawAssignments!, rawWhere!, bindings)
      return {
        rows: rows.map(row => ({ ...row })) as TRow[],
        rowCount: rows.length,
      }
    }

    const returningDeleteMatch = sql.match(/^DELETE FROM "([^"]+)" WHERE (.+) RETURNING \*$/)
    if (returningDeleteMatch) {
      const [, tableName, rawWhere] = returningDeleteMatch
      const rows = this.deleteRows(tableName!, rawWhere!, bindings)
      return {
        rows: rows.map(row => ({ ...row })) as TRow[],
        rowCount: rows.length,
      }
    }

    const tableName = sql.match(/ FROM "([^"]+)"/)?.[1] ?? ''
    let rows = filterMemoryRows(sql, bindings, this.tables[tableName] ?? [])

    const orderMatch = sql.match(/ ORDER BY "([^"]+)" (ASC|DESC)/)
    if (orderMatch) {
      const [, column, direction] = orderMatch
      rows = [...rows].sort((left, right) => {
        const leftValue = left[column!]
        const rightValue = right[column!]
        if (leftValue === rightValue) {
          return 0
        }

        const ascending = leftValue! < rightValue! ? -1 : 1
        return direction === 'ASC' ? ascending : -ascending
      })
    }

    const limitMatch = / LIMIT (?:\?(\d*)|(\d+))/.exec(sql)
    const offsetMatch = / OFFSET (?:\?(\d*)|(\d+))/.exec(sql)
    const offset = offsetMatch
      ? readLimitBinding(sql, bindings, offsetMatch, ' OFFSET ')
      : 0
    const limit = limitMatch
      ? readLimitBinding(sql, bindings, limitMatch, ' LIMIT ')
      : undefined
    const pagedRows = typeof limit === 'number'
      ? rows.slice(offset, offset + limit)
      : rows.slice(offset)

    return {
      rows: projectMemoryRows(sql, bindings, pagedRows) as TRow[],
      rowCount: pagedRows.length,
    }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executions.push({ sql, bindings })
    const updateMatch = sql.match(/^UPDATE "([^"]+)" SET (.+?) WHERE (.+)$/)
    if (updateMatch) {
      const [, tableName, rawAssignments, rawWhere] = updateMatch
      return { affectedRows: this.updateRows(tableName!, rawAssignments!, rawWhere!, bindings).length }
    }

    const deleteMatch = sql.match(/^DELETE FROM "([^"]+)" WHERE (.+)$/)
    if (deleteMatch) {
      const [, tableName, rawWhere] = deleteMatch
      return { affectedRows: this.deleteRows(tableName!, rawWhere!, bindings).length }
    }

    const insertMatch = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES (.+)$/)
    if (!insertMatch) {
      return { affectedRows: 0 }
    }

    const [, tableName, rawColumns, rawValues] = insertMatch
    const rows = this.insertRows(tableName!, rawColumns!, rawValues!, bindings)

    return {
      affectedRows: rows.length,
      lastInsertId: rows.at(-1)?.id as number | string | undefined,
    }
  }

  private insertRows(
    tableName: string,
    rawColumns: string,
    rawValues: string,
    bindings: readonly unknown[],
  ): MemoryRow[] {
    const rows = this.createRowsFromValues(tableName, rawColumns, rawValues, bindings)
    const table = this.tables[tableName] ?? (this.tables[tableName] = [])
    for (const row of rows) {
      table.push(row)
    }

    return rows
  }

  private createRowsFromValues(
    tableName: string,
    rawColumns: string,
    rawValues: string,
    bindings: readonly unknown[],
  ): MemoryRow[] {
    const columns = rawColumns.split(', ').map(part => part.replaceAll('"', ''))
    const groups = [...rawValues.matchAll(/\(([^)]+)\)/g)]
    const table = this.tables[tableName] ?? []
    const nextId = table.reduce((max, current) => Math.max(max, Number(current.id ?? 0)), 0) + 1
    return groups.map((group, rowIndex) => {
      const placeholders = group[1]!.split(', ')
      const row: MemoryRow = {}
      for (let index = 0; index < columns.length; index += 1) {
        const rawIndex = placeholders[index]!.replace('?', '')
        const bindingIndex = rawIndex ? Number(rawIndex) - 1 : rowIndex * columns.length + index
        row[columns[index]!] = bindings[bindingIndex]
      }
      if (!Object.prototype.hasOwnProperty.call(row, 'id')) {
        row.id = nextId + rowIndex
      }
      if (tableName === 'todos' && !Object.prototype.hasOwnProperty.call(row, 'created_at')) {
        row.created_at = `2026-06-24T10:00:0${table.length + rowIndex + 1}.000Z`
      }
      return row
    })
  }

  private upsertRows(
    tableName: string,
    rawColumns: string,
    rawValues: string,
    rawConflictColumns: string,
    rawAssignments: string,
    bindings: readonly unknown[],
  ): MemoryRow[] {
    const rows = this.createRowsFromValues(tableName, rawColumns, rawValues, bindings)
    const table = this.tables[tableName] ?? (this.tables[tableName] = [])
    const conflictColumns = rawConflictColumns.split(', ').map(part => part.replaceAll('"', ''))
    const assignments = rawAssignments.split(', ').map((assignment) => {
      const assignmentMatch = assignment.match(/^"([^"]+)" = EXCLUDED\."([^"]+)"$/)
      if (!assignmentMatch) {
        throw new Error(`Unexpected SQL assignment format: ${assignment}`)
      }

      return { column: assignmentMatch[1]!, sourceColumn: assignmentMatch[2]! }
    })
    const returnedRows: MemoryRow[] = []

    for (const row of rows) {
      const existing = table.find(candidate => conflictColumns.every(column => candidate[column] === row[column]))
      if (!existing) {
        table.push(row)
        returnedRows.push(row)
        continue
      }

      for (const assignment of assignments) {
        existing[assignment.column] = row[assignment.sourceColumn]
      }
      returnedRows.push(existing)
    }

    return returnedRows
  }

  private updateRows(
    tableName: string,
    rawAssignments: string,
    rawWhere: string,
    bindings: readonly unknown[],
  ): MemoryRow[] {
    const table = this.tables[tableName] ?? []
    const assignments = rawAssignments.split(', ').map((assignment, index) => {
      const assignmentMatch = assignment.match(/^"([^"]+)" = \?(\d*)$/)
      if (!assignmentMatch) {
        throw new Error(`Unexpected SQL assignment format: ${assignment}`)
      }

      const [, column, rawPlaceholder] = assignmentMatch
      if (!column) {
        throw new Error(`Unexpected SQL assignment format: ${assignment}`)
      }

      const bindingIndex = rawPlaceholder ? Number(rawPlaceholder) - 1 : index
      return { column, value: bindings[bindingIndex] }
    })
    const matchesWhere = createMemoryWhereMatcher(rawWhere, bindings, assignments.length)
    const rows: MemoryRow[] = []
    for (const row of table) {
      if (!matchesWhere(row)) {
        continue
      }

      for (const assignment of assignments) {
        row[assignment.column] = assignment.value
      }
      rows.push(row)
    }

    return rows
  }

  private deleteRows(
    tableName: string,
    rawWhere: string,
    bindings: readonly unknown[],
  ): MemoryRow[] {
    const table = this.tables[tableName] ?? []
    const matchesWhere = createMemoryWhereMatcher(rawWhere, bindings, 0)
    const deletedRows: MemoryRow[] = []
    const remainingRows: MemoryRow[] = []

    for (const row of table) {
      if (matchesWhere(row)) {
        deletedRows.push(row)
        continue
      }

      remainingRows.push(row)
    }

    this.tables[tableName] = remainingRows
    return deletedRows
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}
}

const dialect: Dialect = {
  name: 'sqlite',
  capabilities: createCapabilities(),
  quoteIdentifier(identifier: string): string {
    return `"${identifier}"`
  },
  createPlaceholder(): string {
    return '?'
  },
}

const returningDialect: Dialect = {
  ...dialect,
  capabilities: createCapabilities({ returning: true }),
}

const postsViewsAggregateBackfillSql = 'SELECT COUNT(*) AS "__holo_count", SUM("views") AS "__holo_sum_0", AVG("views") AS "__holo_avg_0", MIN("views") AS "__holo_min_0", MAX("views") AS "__holo_max_0" FROM "posts"'

function createContext(adapter: DriverAdapter = new MemoryAdapter()): DatabaseContext {
  return createDatabase({
    adapter,
    dialect,
    connectionName: 'main',
  })
}

function createReturningContext(adapter: DriverAdapter): DatabaseContext {
  return createDatabase({
    adapter,
    dialect: returningDialect,
    connectionName: 'main',
  })
}

function createAuthModule(users: Readonly<Record<string, AuthenticatedAuthUser | null>>): RealtimeAuthModule {
  return {
    getAuthRuntime() {
      return {
        user: async () => users.default ?? null,
        provider: async () => users.default ? 'local' : null,
        guard(name: string) {
          return {
            user: async () => users[name] ?? null,
            provider: async () => users[name] ? 'local' : null,
          }
        },
      }
    },
  }
}

afterEach(() => {
  resetRealtimeClientRuntime()
  resetRealtimeRuntime()
  resetDatabaseDependencyInvalidationListeners()
  resetDB()
})

describe('@holo-js/realtime', () => {
  it('compacts adjacent boundary splice operations without expanding window slides', () => {
    const firstInsertedRow = { id: 3, title: 'Third' }
    const secondInsertedRow = { id: 4, title: 'Fourth' }
    const windowBackfillRow = { id: 101, title: 'Backfill' }

    expect(compactPatchOperations([
      createSplicePatchOperation([], 2, 0, [firstInsertedRow]),
      createSplicePatchOperation([], 3, 0, [secondInsertedRow]),
      createSplicePatchOperation([], 4, 0, []),
    ])).toEqual([{
      op: 'splice',
      path: [],
      index: 2,
      deleteCount: 0,
      values: [firstInsertedRow, secondInsertedRow],
    }])

    expect(compactPatchOperations([
      createSplicePatchOperation([], 0, 1, []),
      createSplicePatchOperation([], 99, 0, [windowBackfillRow]),
    ])).toEqual([
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
        values: [windowBackfillRow],
      },
    ])
  })

  it('filters relevant target mutations using returned mutation rows', () => {
    const mutationIndexKey = 'main:posts'
    const authorOneMutation = Object.freeze({
      connectionName: 'main',
      kind: 'upsert',
      predicates: [],
      previousRows: [{
        author_id: 1,
        id: 1,
        score: 7,
      }],
      rows: [{
        author_id: 1,
        id: 1,
        score: 6,
      }],
      tableName: 'posts',
      values: {
        author_id: 1,
        id: 1,
        score: 6,
      },
    } satisfies DatabaseMutationEvent)
    const authorTwoMutation = Object.freeze({
      connectionName: 'main',
      kind: 'upsert',
      predicates: [],
      previousRows: [{
        author_id: 2,
        id: 2,
        score: 11,
      }],
      rows: [{
        author_id: 2,
        id: 2,
        score: 10,
      }],
      tableName: 'posts',
      values: {
        author_id: 2,
        id: 2,
        score: 10,
      },
    } satisfies DatabaseMutationEvent)
    const target = Object.freeze({
      currentValue: 11,
      index: 0,
      mutationIndexKey,
      patchCapability: 'patchable',
      query: Object.freeze({
        aggregate: Object.freeze({
          column: 'score',
          kind: 'max',
        }),
        connectionName: 'main',
        dependencies: [],
        orderBy: [],
        patchable: true,
        predicates: [Object.freeze({
          column: 'author_id',
          operator: '=',
          value: 2,
        })],
        tableName: 'posts',
      }),
      resultPath: [],
      resultPathKey: '',
      skipsPatching: false,
    } satisfies QueryPatchTarget)
    const backfills = {
      aggregates: new Map(),
      aggregateSql: new Map(),
      entries: [],
      mutationMetadata: new WeakMap(),
      mutations: new Map([
        [
          mutationIndexKey,
          Object.freeze([
            authorOneMutation,
            authorTwoMutation,
          ]),
        ],
      ]),
      paginationGroupedCounts: new Map(),
      paginationCounts: new Map(),
      rowGroups: new Map(),
      rows: new Map(),
    } satisfies BackfillCache

    const targets = collectRelevantMutationTargets([target], backfills)

    expect(targets).toHaveLength(1)
    expect(targets[0]?.mutations).toEqual([authorTwoMutation])
  })

  it('executes public queries with validated args and auto-generated names', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      args: schema({
        limit: field.number().integer(),
      }),
      access: 'public',
      handler: async ({ args, auth, db: context }) => {
        expect(auth).toBeNull()
        expect(args.limit).toBe(10)
        return context.table('posts').limit(args.limit).get()
      },
    })

    const result = await executeRealtimeQuery(query, { limit: 10 })

    expect(result.name).toMatch(/^realtime\.query\.\d+$/)
    expect(result.data).toEqual([{ id: 1, title: 'First' }])
    expect(result.dependencies).toEqual(['db:main:posts'])
    expect('queries' in result).toBe(false)
  })

  it('keeps structured query observations internal to active query entries', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      name: 'posts.observed',
      access: 'public',
      handler: async ({ db: context }) => {
        return await context.table('posts')
          .where('title', 'First')
          .orderBy('id', 'desc')
          .limit(5)
          .get()
      },
    })

    const subscription = await subscribeRealtimeQuery(query)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]

    expect(entry?.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      tableName: 'posts',
      limit: 5,
      orderBy: [{ column: 'id', direction: 'desc' }],
      patchable: true,
      predicates: [{ column: 'title', operator: '=', value: 'First' }],
    })])
    expect('queries' in subscription.current).toBe(false)
  })

  it('uses the configured DB facade when no realtime database binding is provided', async () => {
    const db = createContext()
    configureDB({
      connection: () => db,
    } as never)
    configureRealtimeRuntime({
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: [{ id: 1, title: 'First' }],
    })
  })

  it('allows public queries when auth is installed but not configured', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ auth }) => auth,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: null,
    })
  })

  it('treats configured anonymous auth as optional for public queries', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        default: null,
      }),
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ auth }) => auth,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: null,
    })
  })

  it('exposes model repositories through the realtime db context', async () => {
    const repository = { name: 'PostRepository' }
    const connection = {
      model: () => repository,
    } as unknown as DatabaseContext
    const context = realtimeRuntimeInternals.createRealtimeDatabaseContext(connection)

    expect(context.connection).toBe(connection)
    expect(context.model({} as never)).toBe(repository)
  })

  it('honors custom definition names', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      name: 'posts.list',
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      name: 'posts.list',
    })
  })

  it('executes callable query and mutation definitions directly on the server', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const listPosts = defineRealtimeQuery({
      args: schema({
        limit: field.number().integer(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        const rows = await context.table('posts').limit(args.limit).get()

        return {
          rows,
          limit: args.limit,
        }
      },
    })
    const createPost = defineRealtimeMutation({
      args: schema({
        title: field.string().required(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        await context.table('posts').insert({ title: args.title })

        return {
          created: args.title,
        }
      },
    })

    await expect(listPosts({ limit: 1 })).resolves.toEqual({
      rows: [{ id: 1, title: 'First' }],
      limit: 1,
    })
    await expect(createPost({ title: 'Second' })).resolves.toEqual({
      created: 'Second',
    })
    await expect(listPosts({ limit: 2 })).resolves.toEqual({
      rows: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Post 2' },
      ],
      limit: 2,
    })
  })

  it('persists mutation database writes without a broadcast worker or client transport', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const listPosts = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table('posts').orderBy('id').get(),
    })
    const renamePost = defineRealtimeMutation({
      args: schema({
        title: field.string().required(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        await context.table('posts').insert({ title: args.title })

        return await context.table('posts').orderBy('id').get()
      },
    })

    await expect(renamePost({ title: 'Worker independent' })).resolves.toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Worker independent' },
    ])
    await expect(listPosts()).resolves.toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Worker independent' },
    ])
    expect(adapter.executions).toHaveLength(1)
    expect(adapter.executions[0]?.sql).toContain('INSERT INTO "posts"')
  })

  it('keeps mutation-only execution off realtime DB invalidation listener overhead', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const renamePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })

        return { ok: true }
      },
    })

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)

    await expect(executeRealtimeMutation(renamePost)).resolves.toMatchObject({
      data: { ok: true },
    })

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(realtimeRuntimeInternals.getRuntimeState().unsubscribeFromDatabase).toBeUndefined()
    expect(adapter.queries).toEqual([])
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "posts" SET "title" = ? WHERE "id" = ?',
        bindings: ['Updated', 1],
      },
    ])
  })

  it('keeps direct query execution off live realtime DB invalidation listener overhead', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const listPosts = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table('posts').orderBy('id').get(),
    })
    const renamePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })

        return { ok: true }
      },
    })

    await expect(executeRealtimeQuery(listPosts)).resolves.toMatchObject({
      data: [{ id: 1, title: 'First' }],
      dependencies: ['db:main:posts'],
    })

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(realtimeRuntimeInternals.getRuntimeState().unsubscribeFromDatabase).toBeUndefined()

    adapter.queries.length = 0
    adapter.executions.length = 0

    await expect(executeRealtimeMutation(renamePost)).resolves.toMatchObject({
      data: { ok: true },
    })

    expect(adapter.queries).toEqual([])
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "posts" SET "title" = ? WHERE "id" = ?',
        bindings: ['Updated', 1],
      },
    ])
  })

  it('ignores direct invalidation calls while realtime has no active query entries', async () => {
    const state = realtimeRuntimeInternals.getRuntimeState()

    await expect(realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })).resolves.toBeUndefined()
    await expect(realtimeRuntimeInternals.handleBatchedDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })).resolves.toBeUndefined()

    expect(state.invalidationBatch).toBeUndefined()
    expect(state.queryEntries.size).toBe(0)
    expect(state.refreshes.size).toBe(0)
  })

  it('detaches realtime DB invalidation listeners after the last subscription unsubscribes', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const listPosts = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table('posts').orderBy('id').get(),
    })
    const renamePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })

        return { ok: true }
      },
    })

    const firstSubscription = await subscribeRealtimeQuery(listPosts)
    const secondSubscription = await subscribeRealtimeQuery(listPosts)

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(true)
    expect(realtimeRuntimeInternals.getRuntimeState().queryEntries.size).toBe(1)

    firstSubscription.unsubscribe()

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(true)
    expect(realtimeRuntimeInternals.getRuntimeState().queryEntries.size).toBe(1)

    secondSubscription.unsubscribe()

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(realtimeRuntimeInternals.getRuntimeState().unsubscribeFromDatabase).toBeUndefined()
    expect(realtimeRuntimeInternals.getRuntimeState().queryEntries.size).toBe(0)

    adapter.queries.length = 0
    adapter.executions.length = 0

    await expect(executeRealtimeMutation(renamePost)).resolves.toMatchObject({
      data: { ok: true },
    })

    expect(adapter.queries).toEqual([])
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "posts" SET "title" = ? WHERE "id" = ?',
        bindings: ['Updated', 1],
      },
    ])
  })

  it('rolls back realtime DB invalidation listeners when subscription startup fails', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table('posts').get(),
    })

    await expect(subscribeRealtimeQuery(query, {}, {
      onData: () => {
        throw new Error('Initial subscriber failed.')
      },
    })).rejects.toThrow('Initial subscriber failed.')

    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(realtimeRuntimeInternals.getRuntimeState().unsubscribeFromDatabase).toBeUndefined()
    expect(realtimeRuntimeInternals.getRuntimeState().subscriptions.size).toBe(0)
    expect(realtimeRuntimeInternals.getRuntimeState().queryEntries.size).toBe(0)
  })

  it('identifies realtime definitions and rejects invalid access guard configuration', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async () => true,
    })
    const conflictingGuards = defineRealtimeQuery({
      access: {
        require: 'public',
        guard: 'web',
        guards: ['admin'],
      },
      handler: async () => true,
    })
    const emptyGuards = defineRealtimeQuery({
      access: {
        require: 'public',
        guards: [],
      },
      handler: async () => true,
    })

    expect(isRealtimeDefinition(query)).toBe(true)
    expect(isRealtimeDefinition({})).toBe(false)
    await expect(executeRealtimeQuery(conflictingGuards)).rejects.toBeInstanceOf(RealtimeError)
    await expect(executeRealtimeQuery(emptyGuards)).rejects.toBeInstanceOf(RealtimeError)
  })

  it('refreshes subscribed queries after direct Holo DB writes invalidate matching dependencies', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.create',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return { ok: true }
      },
    })

    const subscription = await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown[] }) => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(mutation)

    expect(subscription.current.data).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Post 2' },
    ])
    expect(snapshots).toEqual([
      [{ id: 1, title: 'First' }],
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Post 2' },
      ],
    ])
  })

  it('uses internal structured dependency metadata when present on invalidation events', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.metadata',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').get()
      },
    })
    const event = {
      connectionName: 'main',
      dependencies: Object.freeze([]),
    }
    Object.defineProperty(event, DATABASE_DEPENDENCY_METADATA_KEY, {
      enumerable: false,
      value: Object.freeze({
        directDependencies: Object.freeze(['db:main:posts']),
        exactPredicates: Object.freeze([]),
        hasMutationDependency: false,
        predicates: Object.freeze([]),
        tableDependencies: Object.freeze([]),
      }),
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown[] }) => {
        snapshots.push(snapshot.data)
      },
    })
    adapter.rows.push({ id: 2, title: 'Metadata' })
    await realtimeRuntimeInternals.handleDatabaseInvalidation(event)

    expect(queryRuns).toBe(2)
    expect(snapshots).toEqual([
      [{ id: 1, title: 'First' }],
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Metadata' },
      ],
    ])
  })

  it('coalesces duplicate subscription refreshes by query key during invalidation bursts', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    let blockNextRefresh = false
    let releaseRefresh = () => {}
    let resolveRefreshStarted = () => {}
    const refreshStarted = new Promise<void>((resolve) => {
      resolveRefreshStarted = resolve
    })
    const firstSnapshots: unknown[][] = []
    const secondSnapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const rows = await context.table('posts').get()
        if (blockNextRefresh) {
          blockNextRefresh = false
          resolveRefreshStarted()
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve
          })
        }

        return rows
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        firstSnapshots.push(snapshot.data)
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        secondSnapshots.push(snapshot.data)
      },
    })

    expect(queryRuns).toBe(1)

    blockNextRefresh = true
    const firstInvalidation = realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })
    await refreshStarted

    const burstInvalidations = Array.from({ length: 5 }, async () => await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    }))
    releaseRefresh()
    await Promise.all([firstInvalidation, ...burstInvalidations])

    expect(queryRuns).toBe(3)
    expect(firstSnapshots).toHaveLength(1)
    expect(secondSnapshots).toHaveLength(1)
    expect(firstSnapshots).toEqual(secondSnapshots)
  })

  it('does not publish duplicate snapshots when refreshed data is unchanged', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id').get()
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })

    expect(queryRuns).toBe(2)
    expect(snapshots).toEqual([[{ id: 1, title: 'First' }]])
  })

  it('publishes dependency-only refreshes when data is unchanged', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
      comments: [{ id: 1, body: 'Initial' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let readComments = false
    let queryRuns = 0
    const snapshots: Array<{
      readonly data: readonly string[]
      readonly dependencies: readonly string[]
      readonly version: number
    }> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async () => {
        queryRuns += 1
        recordDatabaseQueryDependencies([
          readComments ? 'db:main:comments' : 'db:main:posts',
        ])
        return ['same']
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push({
          data: snapshot.data,
          dependencies: snapshot.dependencies,
          version: snapshot.version,
        })
      },
    })
    readComments = true
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:comments'],
    })

    expect(queryRuns).toBe(3)
    expect(snapshots).toEqual([
      {
        data: ['same'],
        dependencies: ['db:main:posts'],
        version: 1,
      },
      {
        data: ['same'],
        dependencies: ['db:main:comments'],
        version: 2,
      },
    ])
  })

  it('refreshes structurally unpatchable observed queries after matching mutations', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[] = []
    const patches: RealtimePatchForTest[] = []
    const dependencies = ['db:main:posts']
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async () => {
        queryRuns += 1
        const postCount = adapter.tables.posts?.length ?? 0
        recordDatabaseQueryDependencies(dependencies)
        recordDatabaseQueryObservation({
          connectionName: 'main',
          dependencies,
          orderBy: [],
          patchable: false,
          predicates: [],
          result: postCount,
          selections: [],
          tableName: 'posts',
        })

        return postCount
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: number }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'refresh' })
    expect(queryRuns).toBe(2)
    expect(snapshots).toEqual([1, 2])
    expect(patches).toEqual([])
  })

  it('shares unpatchable refresh fallback across mixed subscribers', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const patchSnapshots: number[] = []
    const snapshotOnlySnapshots: number[] = []
    const secondSnapshotOnlySnapshots: number[] = []
    const patches: RealtimePatchForTest[] = []
    const dependencies = ['db:main:posts']
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async () => {
        queryRuns += 1
        const postCount = adapter.tables.posts?.length ?? 0
        recordDatabaseQueryDependencies(dependencies)
        recordDatabaseQueryObservation({
          connectionName: 'main',
          dependencies,
          orderBy: [],
          patchable: false,
          predicates: [],
          result: postCount,
          selections: [],
          tableName: 'posts',
        })

        return postCount
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Second' })
        return true
      },
    })

    const patchOptions: InternalRealtimeSubscribeOptionsForTest<number> = {
      onData(snapshot: { readonly data: number }) {
        patchSnapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData(snapshot: { readonly data: number }) {
        snapshotOnlySnapshots.push(snapshot.data)
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData(snapshot: { readonly data: number }) {
        secondSnapshotOnlySnapshots.push(snapshot.data)
      },
    })
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'refresh' })
    expect(queryRuns).toBe(2)
    expect(patchSnapshots).toEqual([1, 2])
    expect(snapshotOnlySnapshots).toEqual([1, 2])
    expect(secondSnapshotOnlySnapshots).toEqual([1, 2])
    expect(patches).toEqual([])
  })

  it('patches having grouped count rows across mixed subscribers without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 2, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    type GroupedPostCount = {
      readonly author_id: number
      readonly total: number
    }
    let queryRuns = 0
    const patchSnapshots: GroupedPostCount[][] = []
    const snapshotOnlySnapshots: GroupedPostCount[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectCount('total')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).insert({ author_id: 1, title: 'Fourth' })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostCount[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostCount[] }) {
        patchSnapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData(snapshot: { readonly data: readonly GroupedPostCount[] }) {
        snapshotOnlySnapshots.push([...snapshot.data])
      },
    })
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(patchSnapshots).toEqual([
      [
        { author_id: 1, total: 2 },
      ],
    ])
    expect(snapshotOnlySnapshots).toEqual([
      [
        { author_id: 1, total: 2 },
      ],
      [
        { author_id: 1, total: 3 },
      ],
    ])
    expect(patches).toHaveLength(1)
  })

  it('patches hidden having grouped count rows without rerunning or backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 2, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    type GroupedPostCount = {
      readonly author_id: number
      readonly total: number
    }
    let queryRuns = 0
    const snapshots: GroupedPostCount[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectCount('total')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).insert({ author_id: 2, title: 'Fourth' })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostCount[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostCount[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    const queryCountAfterSubscribe = adapter.queries.length
    await executeRealtimeMutation(createPost)
    const mutationQueries = adapter.queries.slice(queryCountAfterSubscribe)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, total: 2 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, total: 2 },
      { author_id: 2, total: 2 },
    ])
    expect(patches).toHaveLength(1)
    expect(mutationQueries.some(query => query.sql.includes('__holo_grouped_aggregate_value'))).toBe(false)
  })

  it('patches redundant having grouped count rows without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 2, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    type GroupedPostCount = {
      readonly author_id: number
      readonly total: number
    }
    let queryRuns = 0
    const snapshots: GroupedPostCount[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectCount('total')
          .groupBy('author_id')
          .having('count(*)', '>=', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).insert({ author_id: 2, title: 'Fourth' })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostCount[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostCount[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, total: 2 },
        { author_id: 2, total: 1 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, total: 2 },
      { author_id: 2, total: 2 },
    ])
    expect(patches).toHaveLength(1)
  })

  it('patches grouped count rows without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 2, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    type GroupedPostCount = {
      readonly author_id: number
      readonly total: number
    }
    let queryRuns = 0
    const snapshots: GroupedPostCount[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectCount('total')
          .groupBy('author_id')
          .orderBy('author_id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).insert({ id: 4, author_id: 3, title: 'Fourth' })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostCount[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostCount[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, total: 2 },
        { author_id: 2, total: 1 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, total: 2 },
      { author_id: 2, total: 1 },
      { author_id: 3, total: 1 },
    ])
    expect(patches).toHaveLength(1)
  })

  it('patches grouped sum rows without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 11, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostScore = {
      readonly author_id: number
      readonly score_total: number | null
    }
    let queryRuns = 0
    const snapshots: GroupedPostScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectSum('score_total', 'score')
          .groupBy('author_id')
          .orderBy('author_id')
          .get()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).where('id', 1).update({ score: 13 })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostScore[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(updatePost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, score_total: 12 },
        { author_id: 2, score_total: 11 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, score_total: 20 },
      { author_id: 2, score_total: 11 },
    ])
    expect(patches).toHaveLength(1)
  })

  it('patches hidden having grouped sum rows without rerunning or backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 11, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostScore = {
      readonly author_id: number
      readonly score_total: number | null
    }
    let queryRuns = 0
    const snapshots: GroupedPostScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectSum('score_total', 'score')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).insert({ author_id: 2, score: 6, title: 'Fourth' })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostScore[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    const queryCountAfterSubscribe = adapter.queries.length
    await executeRealtimeMutation(createPost)
    const mutationQueries = adapter.queries.slice(queryCountAfterSubscribe)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, score_total: 12 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, score_total: 12 },
      { author_id: 2, score_total: 17 },
    ])
    expect(patches).toHaveLength(1)
    expect(mutationQueries.some(query => query.sql.includes('__holo_grouped_aggregate_value'))).toBe(false)
  })

  it('patches hidden having grouped average rows without rerunning or backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 11, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostScore = {
      readonly author_id: number
      readonly average_score: number | null
    }
    let queryRuns = 0
    const snapshots: GroupedPostScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectAvg('average_score', 'score')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).insert({ author_id: 2, score: 6, title: 'Fourth' })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostScore[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    const queryCountAfterSubscribe = adapter.queries.length
    await executeRealtimeMutation(createPost)
    const mutationQueries = adapter.queries.slice(queryCountAfterSubscribe)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, average_score: 6 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, average_score: 6 },
      { author_id: 2, average_score: 8.5 },
    ])
    expect(patches).toHaveLength(1)
    expect(mutationQueries.some(query => query.sql.includes('__holo_grouped_aggregate_value'))).toBe(false)
  })

  it('patches observed grouped average rows from hidden state without rerunning or backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostScore = {
      readonly author_id: number
      readonly average_score: number | null
    }
    let queryRuns = 0
    const snapshots: GroupedPostScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectAvg('average_score', 'score')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).where('id', 1).update({ score: 9 })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostScore[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const queryCountAfterSubscribe = adapter.queries.length
    await executeRealtimeMutation(updatePost)
    const mutationQueries = adapter.queries.slice(queryCountAfterSubscribe)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, average_score: 6 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, average_score: 8 },
    ])
    expect(patches).toHaveLength(1)
    expect(mutationQueries.some(query => query.sql.includes('AVG("score")'))).toBe(false)
    expect(mutationQueries.some(query => query.sql.includes('__holo_grouped_aggregate_value'))).toBe(false)
  })

  it('patches grouped max rows without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 11, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostScore = {
      readonly author_id: number
      readonly best_score: number | null
    }
    let queryRuns = 0
    const snapshots: GroupedPostScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectMax('best_score', 'score')
          .groupBy('author_id')
          .orderBy('author_id')
          .get()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).where('id', 1).update({ score: 13 })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostScore[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(updatePost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, best_score: 7 },
        { author_id: 2, best_score: 11 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, best_score: 13 },
      { author_id: 2, best_score: 11 },
    ])
    expect(patches).toHaveLength(1)
  })

  it('backfills grouped max rows without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 13, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 11, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostScore = {
      readonly author_id: number
      readonly best_score: number | null
    }
    let queryRuns = 0
    const snapshots: GroupedPostScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectMax('best_score', 'score')
          .groupBy('author_id')
          .orderBy('author_id')
          .get()
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).where('id', 1).delete()
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostScore[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(deletePost)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, best_score: 13 },
        { author_id: 2, best_score: 11 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, best_score: 7 },
      { author_id: 2, best_score: 11 },
    ])
    expect(patches).toHaveLength(1)
  })

  it('patches hidden having grouped min and max rows without rerunning or backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 11, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostMaximumScore = {
      readonly author_id: number
      readonly best_score: number | null
    }
    type GroupedPostMinimumScore = {
      readonly author_id: number
      readonly lowest_score: number | null
    }
    let maxQueryRuns = 0
    let minQueryRuns = 0
    const maxSnapshots: GroupedPostMaximumScore[][] = []
    const minSnapshots: GroupedPostMinimumScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const maxQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        maxQueryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectMax('best_score', 'score')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const minQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        minQueryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectMin('lowest_score', 'score')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).insert({ author_id: 2, score: 6, title: 'Fourth' })
        return true
      },
    })

    const maxPatchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostMaximumScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostMaximumScore[] }) {
        maxSnapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }
    const minPatchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostMinimumScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostMinimumScore[] }) {
        minSnapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const maxSubscription = await subscribeRealtimeQuery(maxQuery, {}, maxPatchOptions)
    const minSubscription = await subscribeRealtimeQuery(minQuery, {}, minPatchOptions)
    const entries = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()]
    const queryCountAfterSubscribe = adapter.queries.length
    await executeRealtimeMutation(createPost)
    const mutationQueries = adapter.queries.slice(queryCountAfterSubscribe)

    expect(entries.map(entry => entry.patchTargets[0]?.patchCapability)).toEqual(['patchable', 'patchable'])
    expect(maxQueryRuns).toBe(1)
    expect(minQueryRuns).toBe(1)
    expect(maxSnapshots).toEqual([
      [
        { author_id: 1, best_score: 7 },
      ],
    ])
    expect(minSnapshots).toEqual([
      [
        { author_id: 1, lowest_score: 5 },
      ],
    ])
    expect(maxSubscription.current.data).toEqual([
      { author_id: 1, best_score: 7 },
      { author_id: 2, best_score: 11 },
    ])
    expect(minSubscription.current.data).toEqual([
      { author_id: 1, lowest_score: 5 },
      { author_id: 2, lowest_score: 6 },
    ])
    expect(patches).toHaveLength(2)
    expect(mutationQueries.some(query => query.sql.includes('__holo_grouped_aggregate_value'))).toBe(false)
  })

  it('patches having grouped max runner-up rows without rerunning or backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 6, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    type GroupedPostMaximumScore = {
      readonly author_id: number
      readonly best_score: number | null
    }
    let queryRuns = 0
    const snapshots: GroupedPostMaximumScore[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table(posts)
          .select('author_id')
          .addSelectMax('best_score', 'score')
          .groupBy('author_id')
          .having('count(*)', '>', 1)
          .orderBy('author_id')
          .get()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table(posts).where('id', 3).update({ score: 4 })
        return true
      },
    })
    const patchOptions: InternalRealtimeSubscribeOptionsForTest<readonly GroupedPostMaximumScore[]> = {
      onData(snapshot: { readonly data: readonly GroupedPostMaximumScore[] }) {
        snapshots.push([...snapshot.data])
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    const subscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    const queryCountAfterSubscribe = adapter.queries.length
    await executeRealtimeMutation(updatePost)
    const mutationQueries = adapter.queries.slice(queryCountAfterSubscribe)

    expect(entry?.patchTargets[0]).toMatchObject({ patchCapability: 'patchable' })
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { author_id: 1, best_score: 7 },
      ],
    ])
    expect(subscription.current.data).toEqual([
      { author_id: 1, best_score: 6 },
    ])
    expect(patches).toHaveLength(1)
    expect(mutationQueries.some(queryLog => queryLog.sql.includes('__holo_grouped_aggregate_value'))).toBe(false)
  })

  it('skips detail subscriptions when a different row is invalidated', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts:row:id:2'],
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts:row:id:1'],
    })

    expect(queryRuns).toBe(2)
    expect(snapshots).toEqual([{ id: 1, title: 'First' }])
  })

  it('refreshes detail subscriptions after broad row invalidations', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })

    await subscribeRealtimeQuery(query)
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts:row:*'],
    })

    expect(queryRuns).toBe(2)
  })

  it('patches detail subscriptions after matching updates', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const renamePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(renamePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { id: 1, title: 'First' },
      { id: 1, title: 'Updated' },
    ])
  })

  it('groups exact detail row backfills for batched unknown updates', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const firstPatches: RealtimePatchForTest[] = []
    const secondPatches: RealtimePatchForTest[] = []
    let firstQueryRuns = 0
    let secondQueryRuns = 0
    const firstQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        firstQueryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const secondQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        secondQueryRuns += 1
        return await context.table('posts').where('id', 2).first()
      },
    })
    const firstPatchOptions = {
      onData: () => undefined,
      onPatch(patch: RealtimePatchForTest) {
        firstPatches.push(patch)
      },
    }
    const secondPatchOptions = {
      onData: () => undefined,
      onPatch(patch: RealtimePatchForTest) {
        secondPatches.push(patch)
      },
    }

    await subscribeRealtimeQuery(firstQuery, {}, firstPatchOptions)
    await subscribeRealtimeQuery(secondQuery, {}, secondPatchOptions)
    const setupQueryCount = adapter.queries.length
    const posts = adapter.tables.posts
    if (!posts) {
      throw new Error('Expected posts table to exist.')
    }
    posts[0] = { id: 1, title: 'Updated First' }
    posts[1] = { id: 2, title: 'Updated Second' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: '',
      dependencies: [],
    }, [
      {
        connectionName: 'main',
        dependencies: ['db:main:posts:row:id:1'],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 1,
          }],
          tableName: 'posts',
        }],
      },
      {
        connectionName: 'main',
        dependencies: ['db:main:posts:row:id:2'],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 2,
          }],
          tableName: 'posts',
        }],
      },
    ])

    const patchQueries = adapter.queries.slice(setupQueryCount)
    expect(firstQueryRuns).toBe(1)
    expect(secondQueryRuns).toBe(1)
    expect(firstPatches[0]?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated First',
    }])
    expect(secondPatches[0]?.operations).toEqual([{
      op: 'replace',
      path: ['title'],
      value: 'Updated Second',
    }])
    expect(patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "id" IN (?, ?)')).toHaveLength(1)
    expect(patchQueries.filter(query => query.sql === 'SELECT * FROM "posts" WHERE "id" = ? LIMIT 1')).toHaveLength(0)
  })

  it('delivers compact patches to internal patch subscribers while preserving snapshot fallback', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const patchOnlyPatches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const renamePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }
    const patchOnlyOptions: InternalRealtimeSubscribeOptionsForTest<unknown> = {
      onPatch(patch: RealtimePatchForTest) {
        patchOnlyPatches.push(patch)
      },
    }

    const patchSubscription = await subscribeRealtimeQuery(query, {}, patchOptions)
    const patchOnlySubscription = await subscribeRealtimeQuery(query, {}, patchOnlyOptions)
    const fallbackSubscription = await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(renamePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { id: 1, title: 'First' },
    ])
    expect(fallbackSnapshots).toEqual([
      { id: 1, title: 'First' },
      { id: 1, title: 'Updated' },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      operations: [
        {
          op: 'replace',
          path: ['title'],
          value: 'Updated',
        },
      ],
      version: 2,
    })
    expect(patches[0]?.dependencies).toBeUndefined()
    expect(patchOnlyPatches).toEqual(patches)
    expect(patchSubscription.current.data).toEqual({ id: 1, title: 'Updated' })
    expect(patchOnlySubscription.current.data).toEqual({ id: 1, title: 'Updated' })
    expect(fallbackSubscription.current.data).toEqual({ id: 1, title: 'Updated' })
    patchSubscription.unsubscribe()
    patchOnlySubscription.unsubscribe()
    fallbackSubscription.unsubscribe()
    expect(patchSubscription.current.data).toEqual({ id: 1, title: 'Updated' })
    expect(patchOnlySubscription.current.data).toEqual({ id: 1, title: 'Updated' })
    expect(fallbackSubscription.current.data).toEqual({ id: 1, title: 'Updated' })
  })

  it('updates snapshot-only subscribers from patched canonical data without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const renamePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })

    const subscription = await subscribeRealtimeQuery(query, {}, {
      onData(snapshot) {
        snapshots.push(snapshot.data)
      },
    })
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]

    expect(entry?.patchSubscriberRefs.size).toBe(0)
    expect(entry?.snapshotSubscriberRefs.size).toBe(1)

    await executeRealtimeMutation(renamePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { id: 1, title: 'First' },
      { id: 1, title: 'Updated' },
    ])
    expect(subscription.current.data).toEqual({ id: 1, title: 'Updated' })

    subscription.unsubscribe()
  })

  it('delivers field-level replace patches for stable list updates', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id').get()
      },
    })
    const renameSecondPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Second Updated' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(renameSecondPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[1, 2]])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [1, 'title'],
        value: 'Second Updated',
      },
    ])
  })

  it('delivers bounded field-level replace patches for multi-row stable list updates', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 2, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id').get()
      },
    })
    const renamePosts = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('author_id', 1).update({ title: 'Updated' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(renamePosts)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[1, 2, 3]])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [1, 'title'],
        value: 'Updated',
      },
      {
        op: 'replace',
        path: [2, 'title'],
        value: 'Updated',
      },
    ])
  })

  it('delivers merge patches for stable multi-field row updates', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First', views: 1 }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated', views: 2 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { id: 1, title: 'First', views: 1 },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          title: 'Updated',
          views: 2,
        },
      },
    ])
  })

  it('delivers a merge patch for wide stable row updates without rerunning the query handler', async () => {
    const initialPost = {
      id: 1,
      title: 'First',
      field_1: 'a',
      field_2: 'b',
      field_3: 'c',
      field_4: 'd',
      field_5: 'e',
      field_6: 'f',
      field_7: 'g',
      field_8: 'h',
      field_9: 'i',
    }
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ ...initialPost }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({
          field_1: 'aa',
          field_2: 'bb',
          field_3: 'cc',
          field_4: 'dd',
          field_5: 'ee',
          field_6: 'ff',
          field_7: 'gg',
          field_8: 'hh',
          field_9: 'ii',
        })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([initialPost])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          field_1: 'aa',
          field_2: 'bb',
          field_3: 'cc',
          field_4: 'dd',
          field_5: 'ee',
          field_6: 'ff',
          field_7: 'gg',
          field_8: 'hh',
          field_9: 'ii',
        },
      },
    ])
  })

  it('falls back to a row replace patch when update shape changes without rerunning the query handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ metadata: 'visible' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([{ id: 1, title: 'First' }])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [],
        value: {
          id: 1,
          metadata: 'visible',
          title: 'First',
        },
      },
    ])
  })

  it('patches subscribed sole query records without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First', views: 1 }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).sole()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated', views: 2 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { id: 1, title: 'First', views: 1 },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      fields: {
        title: 'Updated',
        views: 2,
      },
      op: 'merge',
      path: [],
    }])
  })

  it('patches subscribed exact record queries to undefined when changed predicates stop matching without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, status: 'open', title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).where('status', 'open').first()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ status: 'closed', title: 'Updated' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { id: 1, status: 'open', title: 'First' },
    ])
    expect(patches.map(patch => patch.operations)).toEqual([
      [{
        op: 'replace',
        path: [],
        valueKind: 'undefined',
      }],
    ])
  })

  it('patches subscribed exact value queries without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First', views: 1 }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).value('title')
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated', views: 2 })
        return true
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual(['First'])
    expect(patches.map(patch => patch.operations)).toEqual([
      [{
        op: 'replace',
        path: [],
        value: 'Updated',
      }],
      [{
        op: 'replace',
        path: [],
        valueKind: 'undefined',
      }],
    ])
  })

  it('keeps subscribed exact value queries silent for irrelevant updates without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First', views: 1 }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).value('title')
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ views: 2 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual(['First'])
    expect(patches).toEqual([])
  })

  it('patches subscribed exact value queries to undefined when changed predicates stop matching without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, status: 'open', title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).where('status', 'open').value('title')
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ status: 'closed', title: 'Updated' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual(['First'])
    expect(patches.map(patch => patch.operations)).toEqual([
      [{
        op: 'replace',
        path: [],
        valueKind: 'undefined',
      }],
    ])
  })

  it('patches subscribed pluck queries without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .pluck('title')
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([['First', 'Second']])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      op: 'replace',
      path: [1],
      value: 'Updated Second',
    }])
  })

  it('keeps subscribed pluck queries silent for irrelevant updates without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First', views: 1 },
        { id: 2, author_id: 1, title: 'Second', views: 1 },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .pluck('title')
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ views: 2 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([['First', 'Second']])
    expect(patches).toEqual([])
  })

  it('delivers compact splice patches for pluck inserts and deletes without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .pluck('title')
      },
    })
    const insertPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, author_id: 1, title: 'Third' })
        return true
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(insertPost)
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([['First', 'Second']])
    expect(patches).toHaveLength(2)
    expect(patches[0]?.operations).toEqual([{
      deleteCount: 0,
      index: 2,
      op: 'splice',
      path: [],
      values: ['Third'],
    }])
    expect(patches[1]?.operations).toEqual([{
      deleteCount: 1,
      index: 0,
      op: 'splice',
      path: [],
      values: [],
    }])
  })

  it('patches nested pluck arrays when a query returns a wrapper object', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          titles: await context
            .table('posts')
            .where('author_id', 1)
            .orderBy('id')
            .pluck('title'),
        }
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([{ titles: ['First', 'Second'] }])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      op: 'replace',
      path: ['titles', 1],
      value: 'Updated Second',
    }])
  })

  it('delivers compact move patches for ordered pluck updates without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, priority: 10, title: 'First' },
        { id: 2, priority: 20, title: 'Second' },
        { id: 3, priority: 30, title: 'Third' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .orderBy('priority')
          .pluck('title')
      },
    })
    const movePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).update({ priority: 5 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(movePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([['First', 'Second', 'Third']])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      from: 2,
      op: 'move',
      path: [],
      to: 0,
    }])
  })

  it('patches subscribed exists queries without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, author_id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('author_id', 1).exists()
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([true])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: false,
    }])
  })

  it('keeps subscribed exists queries silent while updating aggregate count metadata', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, author_id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('author_id', 1).exists()
      },
    })
    const insertPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Second' })
        return true
      },
    })
    const deleteFirstPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const deleteSecondPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(insertPost)
    await executeRealtimeMutation(deleteFirstPost)
    await executeRealtimeMutation(deleteSecondPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([true])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: false,
    }])
  })

  it('patches subscribed doesntExist queries without rerunning the handler', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('author_id', 1).doesntExist()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'First' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(createPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([true])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: false,
    }])
  })

  it('keeps subscribed doesntExist queries silent while updating aggregate count metadata', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, author_id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('author_id', 1).doesntExist()
      },
    })
    const insertPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Second' })
        return true
      },
    })
    const deleteFirstPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const deleteSecondPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(insertPost)
    await executeRealtimeMutation(deleteFirstPost)
    await executeRealtimeMutation(deleteSecondPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([false])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      op: 'replace',
      path: [],
      value: true,
    }])
  })

  it('does not publish patched detail subscriptions when matching updates keep row data unchanged', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 1).first()
      },
    })
    const keepPostTitle = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'First' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(keepPostTitle)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { id: 1, title: 'First' },
    ])
  })

  it('patches empty detail subscriptions after matching inserts', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('id', 2).first()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Second' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(createPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      undefined,
      { id: 2, title: 'Second' },
    ])
  })

  it('patches ordered predicate subscriptions when mutation rows are sufficient', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const createForOtherAuthor = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 2, title: 'Other' })
        return true
      },
    })
    const createForSubscribedAuthor = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'Mine' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(createForOtherAuthor)
    await executeRealtimeMutation(createForSubscribedAuthor)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [1],
      [1, 4],
    ])
  })

  it('patches selected column subscriptions without leaking unselected fields', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, body: 'Hidden', title: 'First' },
        { id: 2, author_id: 2, body: 'Hidden', title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const patchSnapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('id', 'author_id', 'title')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, body: 'Hidden', title: 'Mine' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        patchSnapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(createPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [{ id: 1, author_id: 1, title: 'First' }],
      [
        { id: 1, author_id: 1, title: 'First' },
        { id: 3, author_id: 1, title: 'Mine' },
      ],
    ])
  })

  it('backfills selected limited ordered subscriptions without leaking unselected fields', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, body: 'Hidden', title: 'First' },
        { id: 2, body: 'Hidden', title: 'Second' },
        { id: 3, body: 'Hidden', title: 'Third' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const patchSnapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('id', 'title')
          .orderBy('id')
          .limit(2)
          .get()
      },
    })
    const deleteFirstPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        patchSnapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(deleteFirstPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
      [
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    ])
    expect(patchSnapshots).toEqual([
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [
          { id: 3, title: 'Third' },
        ],
      },
    ])
    expect(patches[0]?.dependencies).toBeUndefined()
  })

  it('backfills filtered selected limited subscriptions without selected predicates or handler reruns', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, body: 'Hidden', title: 'First' },
        { id: 2, author_id: 2, body: 'Hidden', title: 'Second' },
        { id: 3, author_id: 1, body: 'Hidden', title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const patchSnapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('id', 'title')
          .where('author_id', 1)
          .orderBy('id')
          .limit(2)
          .get()
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        patchSnapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    const posts = adapter.tables.posts
    if (!posts) {
      throw new Error('Expected posts table to exist.')
    }
    posts[1] = { id: 2, author_id: 1, body: 'Hidden', title: 'Second' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 2,
        }],
        tableName: 'posts',
      }],
    })

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { id: 1, title: 'First' },
        { id: 3, title: 'Third' },
      ],
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    ])
    expect(patchSnapshots).toEqual([
      [
        { id: 1, title: 'First' },
        { id: 3, title: 'Third' },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [1],
        value: { id: 2, title: 'Second' },
      },
    ])
  })

  it('patches selected subscriptions from returning update rows without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, body: 'Hidden', title: 'First' },
        { id: 2, author_id: 2, body: 'Hidden', title: 'Second' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('id', 'author_id', 'title')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const movePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(movePost)

    expect(queryRuns).toBe(1)
    expect(adapter.executions).toHaveLength(0)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT "id", "author_id", "title" FROM "posts" WHERE "author_id" = ? ORDER BY "id" ASC',
      'UPDATE "posts" SET "author_id" = ? WHERE "id" = ? RETURNING *',
    ])
    expect(snapshots).toEqual([
      [{ id: 1, author_id: 1, title: 'First' }],
      [],
    ])
  })

  it('patches selected returning updates in place without leaking unselected fields', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, body: 'Hidden', title: 'First' },
        { id: 2, author_id: 1, body: 'Hidden', title: 'Second' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('id', 'author_id', 'title')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const updateTitle = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(updateTitle)

    expect(queryRuns).toBe(1)
    expect(adapter.executions).toHaveLength(0)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT "id", "author_id", "title" FROM "posts" WHERE "author_id" = ? ORDER BY "id" ASC',
      'UPDATE "posts" SET "title" = ? WHERE "id" = ? RETURNING *',
    ])
    expect(snapshots).toEqual([
      [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
      [
        { id: 1, author_id: 1, title: 'Updated' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    ])
  })

  it('patches exact selected records without selected identity or handler reruns', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, body: 'Hidden', title: 'First' },
        { id: 2, body: 'Hidden', title: 'Second' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<Readonly<Record<string, unknown>> | null | undefined> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('title')
          .where('id', 1)
          .first()
      },
    })
    const updateTitle = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: Readonly<Record<string, unknown>> | null | undefined }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updateTitle)

    expect(queryRuns).toBe(1)
    expect(adapter.executions).toHaveLength(0)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT "title" FROM "posts" WHERE "id" = ? LIMIT 1',
      'UPDATE "posts" SET "title" = ? WHERE "id" = ? RETURNING *',
    ])
    expect(snapshots).toEqual([
      { title: 'First' },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['title'],
        value: 'Updated',
      },
    ])
    expect(patches[0]?.dependencies).toBeUndefined()
  })

  it('patches exact selected record deletes without selected identity or handler reruns', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, body: 'Hidden', title: 'First' },
        { id: 2, body: 'Hidden', title: 'Second' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<Readonly<Record<string, unknown>> | null | undefined> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('title')
          .where('id', 1)
          .first()
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: Readonly<Record<string, unknown>> | null | undefined }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(adapter.executions).toHaveLength(0)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT "title" FROM "posts" WHERE "id" = ? LIMIT 1',
      'DELETE FROM "posts" WHERE "id" = ? RETURNING *',
    ])
    expect(snapshots).toEqual([
      { title: 'First' },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [],
        valueKind: 'undefined',
      },
    ])
    expect(patches[0]?.dependencies).toBeUndefined()
  })

  it('patches exact selected record inserts from empty results without selected identity or handler reruns', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, body: 'Hidden', title: 'First' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<Readonly<Record<string, unknown>> | null | undefined> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('title')
          .where('id', 3)
          .first()
      },
    })
    const insertPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, body: 'Hidden', title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: Readonly<Record<string, unknown>> | null | undefined }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(insertPost)

    expect(queryRuns).toBe(1)
    expect(adapter.executions).toHaveLength(0)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT "title" FROM "posts" WHERE "id" = ? LIMIT 1',
      'INSERT INTO "posts" ("id", "body", "title") VALUES (?, ?, ?) RETURNING *',
    ])
    expect(snapshots).toEqual([
      undefined,
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [],
        value: {
          title: 'Third',
        },
      },
    ])
    expect(patches[0]?.dependencies).toBeUndefined()
  })

  it('patches selected subscriptions when returning upserts move rows out of predicates', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, body: 'Hidden', title: 'First' },
        { id: 2, author_id: 2, body: 'Hidden', title: 'Second' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .select('id', 'author_id', 'title')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const movePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 1, author_id: 2, body: 'Hidden', title: 'First' },
          ['id'],
          ['author_id'],
        )
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(movePost)

    expect(queryRuns).toBe(1)
    expect(adapter.executions).toHaveLength(0)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT "id", "author_id", "title" FROM "posts" WHERE "author_id" = ? ORDER BY "id" ASC',
      'SELECT * FROM "posts" WHERE "id" IN (?)',
      'INSERT INTO "posts" ("id", "author_id", "body", "title") VALUES (?, ?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "author_id" = EXCLUDED."author_id" RETURNING *',
    ])
    expect(snapshots).toEqual([
      [{ id: 1, author_id: 1, title: 'First' }],
      [],
    ])
  })

  it('patches limited ordered inserts with database-generated returned columns', async () => {
    const adapter = new RelationalMemoryAdapter({
      todos: [
        { id: 1, title: 'First', created_at: '2026-06-24T10:00:01.000Z' },
        { id: 2, title: 'Second', created_at: '2026-06-24T09:00:00.000Z' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('todos')
          .orderBy('created_at', 'desc')
          .limit(100)
          .get()
      },
    })
    const createTodo = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('todos').insert({ title: 'Third' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(createTodo)

    expect(queryRuns).toBe(1)
    expect(adapter.executions).toHaveLength(0)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "todos" ORDER BY "created_at" DESC LIMIT 100',
      'INSERT INTO "todos" ("title") VALUES (?) RETURNING *',
    ])
    expect(snapshots).toEqual([
      [1, 2],
      [3, 1, 2],
    ])
  })

  it('patches nested rows when a query returns a wrapper object', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<{ readonly rows: readonly number[], readonly scope: string }> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const rows = await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()

        return {
          rows,
          scope: 'mine',
        }
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'Mine' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push({
          rows: snapshot.data.rows.map(row => Number(row.id)),
          scope: snapshot.data.scope,
        })
      },
    })
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.queries[0]?.resultPath).toEqual(['rows'])
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { rows: [1], scope: 'mine' },
      { rows: [1, 3], scope: 'mine' },
    ])
  })

  it('patches nested selected rows for stable returning upserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, body: 'Hidden', title: 'First' },
        { id: 2, author_id: 1, body: 'Hidden', title: 'Second' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<{ readonly rows: readonly Readonly<Record<string, unknown>>[], readonly scope: string }> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const rows = await context
          .table('posts')
          .select('id', 'author_id', 'title')
          .where('author_id', 1)
          .orderBy('id')
          .get()

        return {
          rows,
          scope: 'mine',
        }
      },
    })
    const upsertPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 1, author_id: 1, body: 'Hidden', title: 'Updated' },
          ['id'],
          ['title'],
        )
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly rows: readonly Readonly<Record<string, unknown>>[], readonly scope: string } }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(upsertPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        rows: [
          { id: 1, author_id: 1, title: 'First' },
          { id: 2, author_id: 1, title: 'Second' },
        ],
        scope: 'mine',
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['rows', 0, 'title'],
        value: 'Updated',
      },
    ])
  })

  it('patches nested rows for multi-row stable returning upserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 2, title: 'Other' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const rows = await context
          .table('posts')
          .where('author_id', 1)
          .get()

        return { rows }
      },
    })
    const upsertPosts = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert([
          { id: 1, author_id: 1, title: 'Updated First' },
          { id: 2, author_id: 1, title: 'Updated Second' },
        ], ['id'], ['title'])
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: { readonly rows: readonly Readonly<Record<string, unknown>>[] } }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(upsertPosts)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        rows: [
          { id: 1, author_id: 1, title: 'First' },
          { id: 2, author_id: 1, title: 'Second' },
        ],
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['rows', 0, 'title'],
        value: 'Updated First',
      },
      {
        op: 'replace',
        path: ['rows', 1, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('patches wrapper queries when one db result is exposed in multiple places', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<{ readonly duplicate: readonly number[], readonly rows: readonly number[] }> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const rows = await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()

        return {
          duplicate: rows,
          rows,
        }
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'Mine' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push({
          duplicate: snapshot.data.duplicate.map(row => Number(row.id)),
          rows: snapshot.data.rows.map(row => Number(row.id)),
        })
      },
    })
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.queries.map(observation => observation.resultPath)).toEqual([
      ['duplicate'],
      ['rows'],
    ])
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { duplicate: [1], rows: [1] },
      { duplicate: [1, 2], rows: [1, 2] },
    ])
  })

  it('patches multiple nested query results from one mutation', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<{ readonly all: readonly number[], readonly mine: readonly number[] }> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const all = await context
          .table('posts')
          .orderBy('id')
          .get()
        const mine = await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()

        return {
          all,
          mine,
        }
      },
    })
    const createPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'Mine' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push({
          all: snapshot.data.all.map(row => Number(row.id)),
          mine: snapshot.data.mine.map(row => Number(row.id)),
        })
      },
    })
    const entry = [...realtimeRuntimeInternals.getRuntimeState().queryEntries.values()][0]
    await executeRealtimeMutation(createPost)

    expect(entry?.queries.map(observation => observation.resultPath)).toEqual([
      ['all'],
      ['mine'],
    ])
    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { all: [1, 2], mine: [1] },
      { all: [1, 2, 3], mine: [1, 3] },
    ])
  })

  it('patches same-row updates in ordered predicate subscriptions', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: string[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const createForOtherAuthor = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 2, title: 'Other' })
        return true
      },
    })
    const updateSubscribedAuthor = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => String(row.title)))
      },
    })
    await Promise.all([
      executeRealtimeMutation(createForOtherAuthor),
      executeRealtimeMutation(updateSubscribedAuthor),
    ])

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      ['First'],
      ['Updated'],
    ])
  })

  it('patches ordered updates in place when the row stays between the same neighbors', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, priority: 10, title: 'First' },
        { id: 2, priority: 20, title: 'Second' },
        { id: 3, priority: 30, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly number[]> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .orderBy('priority')
          .get()
      },
    })
    const updatePriority = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ priority: 21 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.priority)))
      },
    })
    await executeRealtimeMutation(updatePriority)

    expect(queryRuns).toBe(1)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "posts" ORDER BY "priority" ASC',
      'SELECT * FROM "posts" WHERE "id" = ?',
    ])
    expect(adapter.executions.map(execution => execution.sql)).toEqual([
      'UPDATE "posts" SET "priority" = ? WHERE "id" = ?',
    ])
    expect(snapshots).toEqual([
      [10, 20, 30],
      [10, 21, 30],
    ])
  })

  it('delivers compact move patches when ordered updates move one row', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, priority: 10, title: 'First' },
        { id: 2, priority: 20, title: 'Second' },
        { id: 3, priority: 30, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly number[]> = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .orderBy('priority')
          .get()
      },
    })
    const movePriority = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).update({ priority: 5 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(movePriority)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[1, 2, 3]])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'move',
        path: [],
        from: 2,
        to: 0,
      },
      {
        op: 'replace',
        path: [0, 'priority'],
        value: 5,
      },
    ])
    expect(patches[0]?.dependencies).toBeUndefined()
  })

  it('patches multi-row ordered updates without sorting when scan order stays valid', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 2, priority: 10, title: 'First' },
        { id: 2, author_id: 1, priority: 20, title: 'Second' },
        { id: 3, author_id: 1, priority: 30, title: 'Third' },
        { id: 4, author_id: 2, priority: 40, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly number[]> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .orderBy('priority')
          .get()
      },
    })
    const updatePriorities = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('author_id', 1).update({ priority: 25 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.priority)))
      },
    })
    await executeRealtimeMutation(updatePriorities)

    expect(queryRuns).toBe(1)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "posts" ORDER BY "priority" ASC',
      'SELECT * FROM "posts" WHERE "author_id" = ?',
    ])
    expect(adapter.executions.map(execution => execution.sql)).toEqual([
      'UPDATE "posts" SET "priority" = ? WHERE "author_id" = ?',
    ])
    expect(snapshots).toEqual([
      [10, 20, 30, 40],
      [10, 25, 25, 40],
    ])
  })

  it('sorts patched multi-row ordered updates when scan order breaks', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 2, priority: 10, title: 'First' },
        { id: 2, author_id: 1, priority: 20, title: 'Second' },
        { id: 3, author_id: 1, priority: 30, title: 'Third' },
        { id: 4, author_id: 2, priority: 40, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: Array<readonly number[]> = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .orderBy('priority')
          .get()
      },
    })
    const updatePriorities = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('author_id', 1).update({ priority: 5 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.priority)))
      },
    })
    await executeRealtimeMutation(updatePriorities)

    expect(queryRuns).toBe(1)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "posts" ORDER BY "priority" ASC',
      'SELECT * FROM "posts" WHERE "author_id" = ?',
    ])
    expect(adapter.executions.map(execution => execution.sql)).toEqual([
      'UPDATE "posts" SET "priority" = ? WHERE "author_id" = ?',
    ])
    expect(snapshots).toEqual([
      [10, 20, 30, 40],
      [5, 5, 10, 40],
    ])
  })

  it('patches predicate subscriptions when an update moves a row out of the result set', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const moveSubscribedRow = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(moveSubscribedRow)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [1],
      [],
    ])
  })

  it('patches deletes when the current ordered result has enough data', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [1, 2],
      [2],
    ])
  })

  it('backfills full limited ordered windows after matching deletes', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .limit(2)
          .get()
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(adapter.queries).toHaveLength(3)
    expect(snapshots).toEqual([
      [1, 2],
      [2, 3],
    ])
  })

  it('backfills offset ordered windows without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .offset(1)
          .limit(2)
          .get()
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "posts" WHERE "author_id" = ? ORDER BY "id" ASC LIMIT 2 OFFSET 1',
      'SELECT * FROM "posts" WHERE "id" = ?',
      'SELECT * FROM "posts" WHERE "author_id" = ? ORDER BY "id" ASC LIMIT 2 OFFSET 1',
    ])
    expect(snapshots).toEqual([
      [2, 3],
      [3],
    ])
  })

  it('patches offset ordered window row updates without backfilling unchanged membership', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: string[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .offset(1)
          .limit(2)
          .get()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => String(row.title)))
      },
    })
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "posts" WHERE "author_id" = ? ORDER BY "id" ASC LIMIT 2 OFFSET 1',
      'SELECT * FROM "posts" WHERE "id" = ?',
    ])
    expect(snapshots).toEqual([
      ['Second', 'Third'],
      ['Updated Second', 'Third'],
    ])
  })

  it('coalesces full limited ordered window backfills across query entries', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let listRuns = 0
    let wrapperRuns = 0
    const listSnapshots: number[][] = []
    const wrapperSnapshots: number[][] = []
    const listQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        listRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .limit(2)
          .get()
      },
    })
    const wrapperQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        wrapperRuns += 1
        const rows = await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .limit(2)
          .get()

        return { rows }
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })

    await subscribeRealtimeQuery(listQuery, {}, {
      onData: snapshot => {
        listSnapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await subscribeRealtimeQuery(wrapperQuery, {}, {
      onData: snapshot => {
        wrapperSnapshots.push(snapshot.data.rows.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(deletePost)

    expect(listRuns).toBe(1)
    expect(wrapperRuns).toBe(1)
    expect(adapter.queries).toHaveLength(4)
    expect(listSnapshots).toEqual([
      [1, 2],
      [2, 3],
    ])
    expect(wrapperSnapshots).toEqual([
      [1, 2],
      [2, 3],
    ])
  })

  it('patches full limited ordered windows when updated rows enter the window', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 20, title: 'First' },
        { id: 2, author_id: 1, score: 10, title: 'Second' },
        { id: 3, author_id: 1, score: 0, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('score', 'desc')
          .limit(2)
          .get()
      },
    })
    const promotePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).update({ score: 30 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(promotePost)

    expect(queryRuns).toBe(1)
    expect(adapter.queries).toHaveLength(2)
    expect(snapshots).toEqual([
      [1, 2],
      [3, 1],
    ])
  })

  it('backfills limited ordered rows for unknown updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 20, title: 'First' },
        { id: 2, author_id: 1, score: 10, title: 'Second' },
        { id: 3, author_id: 1, score: 0, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('score', 'desc')
          .limit(2)
          .get()
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    const posts = adapter.tables.posts
    if (!posts) {
      throw new Error('Expected posts table to exist.')
    }
    posts[2] = { id: 3, author_id: 1, score: 30, title: 'Third' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 3,
        }],
        tableName: 'posts',
      }],
    })

    expect(queryRuns).toBe(1)
    expect(adapter.queries).toHaveLength(2)
    expect(snapshots).toEqual([
      [1, 2],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 0,
        deleteCount: 0,
        values: [
          { id: 3, author_id: 1, score: 30, title: 'Third' },
        ],
      },
      {
        op: 'splice',
        path: [],
        index: 2,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches shrinking limited windows when the current result is not full', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .limit(3)
          .get()
      },
    })
    const movePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const deletePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(movePost)
    await executeRealtimeMutation(deletePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [1, 2],
      [2],
      [],
    ])
  })

  it('patches predicate subscriptions when an update moves a row into the result set', async () => {
    const db = createContext(new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const moveOtherRow = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('author_id', 2).update({ author_id: 1 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await executeRealtimeMutation(moveOtherRow)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [1],
      [1, 2],
    ])
  })

  it('batches committed write bursts into one visible refresh with the final data', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').get()
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.create',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await Promise.all(Array.from({ length: 5 }, async () => await executeRealtimeMutation(mutation)))

    expect(queryRuns).toBe(2)
    expect(snapshots).toHaveLength(2)
    expect(snapshots.at(-1)).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Post 2' },
      { id: 3, title: 'Post 3' },
      { id: 4, title: 'Post 4' },
      { id: 5, title: 'Post 5' },
      { id: 6, title: 'Post 6' },
    ])
  })

  it('patches committed write bursts without rerunning supported query handlers', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [{ id: 1, author_id: 1, title: 'First' }],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const fallbackSnapshots: number[][] = []
    const patchSnapshots: number[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      name: 'posts.patchableBurst',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.createPatchableBurst',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'Next' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        patchSnapshots.push(snapshot.data.map(row => Number(row.id)))
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data.map(row => Number(row.id)))
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await Promise.all(Array.from({ length: 5 }, async () => await executeRealtimeMutation(mutation)))

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      [1],
      [1, 2, 3, 4, 5, 6],
    ])
    expect(patchSnapshots).toEqual([[1]])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          { id: 2, author_id: 1, title: 'Next' },
          { id: 3, author_id: 1, title: 'Next' },
          { id: 4, author_id: 1, title: 'Next' },
          { id: 5, author_id: 1, title: 'Next' },
          { id: 6, author_id: 1, title: 'Next' },
        ],
      },
    ])
  })

  it('delivers compact splice patches for ordered row deletes without rerunning handlers', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      name: 'posts.compactDelete',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.deleteCompact',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[1, 2, 3]])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('delivers compact splice patches for ordered middle inserts without rerunning handlers', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: number[][] = []
    const patches: RealtimePatchForTest[] = []
    const query = defineRealtimeQuery({
      name: 'posts.compactMiddleInsert',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('author_id', 1)
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.insertCompactMiddle',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: readonly Readonly<Record<string, unknown>>[] }) {
        snapshots.push(snapshot.data.map(row => Number(row.id)))
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[1, 3]])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          { id: 2, author_id: 1, title: 'Second' },
        ],
      },
    ])
  })

  it('refreshes same-query subscribers with one rerun after committed writes', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const firstSnapshots: unknown[][] = []
    const secondSnapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').get()
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.create',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        firstSnapshots.push(snapshot.data)
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        secondSnapshots.push(snapshot.data)
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(2)
    expect(firstSnapshots).toHaveLength(2)
    expect(secondSnapshots).toHaveLength(2)
    expect(firstSnapshots.at(-1)).toEqual(secondSnapshots.at(-1))
  })

  it('isolates user subscription callback failures while refreshing matching subscriptions', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let shouldFailQuery = false
    let shouldFailOnData = false
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      name: 'posts.live',
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })
    const failingQuery = defineRealtimeQuery({
      name: 'posts.failing',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').get()
        if (shouldFailQuery) {
          throw new Error('query failed')
        }

        return []
      },
    })
    const mutation = defineRealtimeMutation({
      name: 'posts.create',
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return { ok: true }
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: () => {
        if (shouldFailOnData) {
          throw new Error('onData failed')
        }
      },
    })
    await subscribeRealtimeQuery(failingQuery, {}, {
      onError: () => {
        throw new Error('onError failed')
      },
    })
    shouldFailQuery = true
    shouldFailOnData = true

    await expect(executeRealtimeMutation(mutation)).resolves.toMatchObject({
      data: { ok: true },
    })

    expect(snapshots.at(-1)).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Post 2' },
    ])
    expect(consoleError).toHaveBeenCalledWith(
      '[@holo-js/realtime] Realtime subscription onData callback failed.',
      expect.any(Error),
    )
    expect(consoleError).toHaveBeenCalledWith(
      '[@holo-js/realtime] Realtime subscription onError callback failed.',
      expect.any(Error),
    )
  })

  it('patches ordered belongs-to-many relation queries when related rows are attached without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
      tags: [
        { id: 10, name: 'Existing' },
      ],
      post_tags: [
        { id: 100, postId: 1, tagId: 10 },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const tags = defineGeneratedTable('tags', {
      id: column.id(),
      name: column.string(),
    })
    const postTags = defineGeneratedTable('post_tags', {
      id: column.id(),
      postId: column.integer(),
      tagId: column.integer(),
    })
    const Tag = defineModel(tags)
    const Post = defineModel(posts, {
      relations: {
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId').withPivot('id').orderByPivot('id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('tags').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('tags').insert({ id: 11, name: 'New' })
        await context.table('post_tags').insert({ postId: 1, tagId: 11 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          title: 'First',
          tags: [
            {
              id: 10,
              name: 'Existing',
              pivot: {
                id: 100,
                postId: 1,
                tagId: 10,
              },
            },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'tags'],
        index: 1,
        deleteCount: 0,
        values: [
          {
            id: 11,
            name: 'New',
            pivot: {
              id: 101,
              postId: 1,
              tagId: 11,
            },
          },
        ],
      },
    ])
  })

  it('patches ordered belongs-to-many relation queries when related rows update without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
      tags: [
        { id: 10, name: 'Existing' },
      ],
      post_tags: [
        { id: 100, postId: 1, tagId: 10 },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const tags = defineGeneratedTable('tags', {
      id: column.id(),
      name: column.string(),
    })
    const postTags = defineGeneratedTable('post_tags', {
      id: column.id(),
      postId: column.integer(),
      tagId: column.integer(),
    })
    const Tag = defineModel(tags)
    const Post = defineModel(posts, {
      relations: {
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId').withPivot('id').orderByPivot('id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('tags').orderBy('id').get()
      },
    })
    const updateTag = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('tags').where('id', 10).update({ name: 'Updated' })
        return true
      },
    })
    const updateTagAgain = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('tags').where('id', 10).update({ name: 'Updated Again' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updateTag)
    await executeRealtimeMutation(updateTagAgain)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          title: 'First',
          tags: [
            {
              id: 10,
              name: 'Existing',
              pivot: {
                id: 100,
                postId: 1,
                tagId: 10,
              },
            },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(2)
    expect(patches.map(patch => patch.operations)).toEqual([
      [
        {
          op: 'replace',
          path: [0, 'tags', 0, 'name'],
          value: 'Updated',
        },
      ],
      [
        {
          op: 'replace',
          path: [0, 'tags', 0, 'name'],
          value: 'Updated Again',
        },
      ],
    ])
  })

  it('patches ordered belongs-to-many relation queries when pivot rows update without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
      tags: [
        { id: 10, name: 'Existing' },
      ],
      post_tags: [
        { id: 100, postId: 1, tagId: 10, weight: 1 },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
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
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId').withPivot('id', 'weight').orderByPivot('id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('tags').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('post_tags').where('id', 100).update({ weight: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          title: 'First',
          tags: [
            {
              id: 10,
              name: 'Existing',
              pivot: {
                id: 100,
                postId: 1,
                tagId: 10,
                weight: 1,
              },
            },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'tags', 0, 'pivot'],
        value: {
          id: 100,
          postId: 1,
          tagId: 10,
          weight: 2,
        },
      },
    ])
  })

  it('delivers compact move patches for ordered belongs-to-many relation pivot updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
      tags: [
        { id: 10, name: 'First Tag' },
        { id: 11, name: 'Second Tag' },
      ],
      post_tags: [
        { id: 100, postId: 1, tagId: 10, weight: 1 },
        { id: 101, postId: 1, tagId: 11, weight: 2 },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
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
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId').withPivot('id', 'weight').orderByPivot('weight'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('tags').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('post_tags').where('id', 100).update({ weight: 3 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          title: 'First',
          tags: [
            {
              id: 10,
              name: 'First Tag',
              pivot: {
                id: 100,
                postId: 1,
                tagId: 10,
                weight: 1,
              },
            },
            {
              id: 11,
              name: 'Second Tag',
              pivot: {
                id: 101,
                postId: 1,
                tagId: 11,
                weight: 2,
              },
            },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'move',
        path: [0, 'tags'],
        from: 0,
        to: 1,
      },
      {
        op: 'replace',
        path: [0, 'tags', 1, 'pivot'],
        value: {
          id: 100,
          postId: 1,
          tagId: 10,
          weight: 3,
        },
      },
    ])
  })

  it('patches ordered belongs-to-many relation queries when related rows delete without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
      tags: [
        { id: 10, name: 'Existing' },
        { id: 11, name: 'Deleted' },
      ],
      post_tags: [
        { id: 100, postId: 1, tagId: 10 },
        { id: 101, postId: 1, tagId: 11 },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const tags = defineGeneratedTable('tags', {
      id: column.id(),
      name: column.string(),
    })
    const postTags = defineGeneratedTable('post_tags', {
      id: column.id(),
      postId: column.integer(),
      tagId: column.integer(),
    })
    const Tag = defineModel(tags)
    const Post = defineModel(posts, {
      relations: {
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId').withPivot('id').orderByPivot('id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('tags').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('tags').where('id', 11).delete()
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          title: 'First',
          tags: [
            {
              id: 10,
              name: 'Existing',
              pivot: {
                id: 100,
                postId: 1,
                tagId: 10,
              },
            },
            {
              id: 11,
              name: 'Deleted',
              pivot: {
                id: 101,
                postId: 1,
                tagId: 11,
              },
            },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'tags'],
        index: 1,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches ordered belongs-to-many relation queries when related rows are detached without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
      ],
      tags: [
        { id: 10, name: 'Existing' },
        { id: 11, name: 'Detached' },
      ],
      post_tags: [
        { id: 100, postId: 1, tagId: 10 },
        { id: 101, postId: 1, tagId: 11 },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const tags = defineGeneratedTable('tags', {
      id: column.id(),
      name: column.string(),
    })
    const postTags = defineGeneratedTable('post_tags', {
      id: column.id(),
      postId: column.integer(),
      tagId: column.integer(),
    })
    const Tag = defineModel(tags)
    const Post = defineModel(posts, {
      relations: {
        tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId').withPivot('id').orderByPivot('id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('tags').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('post_tags').where('id', 101).delete()
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          title: 'First',
          tags: [
            {
              id: 10,
              name: 'Existing',
              pivot: {
                id: 100,
                postId: 1,
                tagId: 10,
              },
            },
            {
              id: 11,
              name: 'Detached',
              pivot: {
                id: 101,
                postId: 1,
                tagId: 11,
              },
            },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'tags'],
        index: 1,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches subscribed has-many relation queries after stable related row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Author).query().with('posts').orderBy('id').get()
      },
    })
    const updatePost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updatePost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'posts', 0, 'title'],
        value: 'Updated',
      },
    ])
  })

  it('patches subscribed has-many relation queries after related row deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Author).query().with('posts').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
            { id: 2, author_id: 1, title: 'Second' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'posts'],
        index: 1,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches subscribed has-one relation inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Author).query().with('featuredPost').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 1, author_id: 1, title: 'First' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          featuredPost: null,
          id: 1,
          name: 'Ada',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'featuredPost'],
        value: { id: 1, author_id: 1, title: 'First' },
      },
    ])
  })

  it('patches subscribed has-one relation deletes to null without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Author).query().with('featuredPost').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          featuredPost: { id: 1, author_id: 1, title: 'First' },
          id: 1,
          name: 'Ada',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'featuredPost'],
        value: null,
      },
    ])
  })

  it('patches subscribed has-one relation parent key moves without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Author).query().with('featuredPost').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          featuredPost: { id: 1, author_id: 1, title: 'First' },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: null,
          id: 2,
          name: 'Grace',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [1, 'featuredPost'],
        value: { id: 1, author_id: 2, title: 'First' },
      },
    ])
  })

  it('patches constrained has-one relation parent key moves without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'Published' },
        { id: 2, author_id: 2, title: 'Draft' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('featuredPost', relationQuery => relationQuery.where('title', 'Published').orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          featuredPost: { id: 1, author_id: 1, title: 'Published' },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: null,
          id: 2,
          name: 'Grace',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [1, 'featuredPost'],
        value: { id: 1, author_id: 2, title: 'Published' },
      },
    ])
  })

  it('patches range-constrained has-one relation parent key moves without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 20, title: 'First' },
        { id: 2, author_id: 2, score: 5, title: 'Draft' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('featuredPost', relationQuery => relationQuery.where('score', '>', 10).orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          featuredPost: { id: 1, author_id: 1, score: 20, title: 'First' },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: null,
          id: 2,
          name: 'Grace',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [1, 'featuredPost'],
        value: { id: 1, author_id: 2, score: 20, title: 'First' },
      },
    ])
  })

  it('patches not-in constrained has-one relation parent key moves without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'Published' },
        { id: 2, author_id: 2, title: 'Draft' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('featuredPost', relationQuery => relationQuery.whereNotIn('title', ['Draft']).orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          featuredPost: { id: 1, author_id: 1, title: 'Published' },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: null,
          id: 2,
          name: 'Grace',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'featuredPost'],
        value: null,
      },
      {
        op: 'replace',
        path: [1, 'featuredPost'],
        value: { id: 1, author_id: 2, title: 'Published' },
      },
    ])
  })

  it('patches subscribed has-one eager parent inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Author).query().with('featuredPost').orderBy('id').getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').insert({ id: 2, name: 'Grace' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      [
        {
          featuredPost: { id: 1, author_id: 1, title: 'First' },
          id: 1,
          name: 'Ada',
        },
      ],
      [
        {
          featuredPost: { id: 1, author_id: 1, title: 'First' },
          id: 1,
          name: 'Ada',
        },
        {
          featuredPost: null,
          id: 2,
          name: 'Grace',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          {
            featuredPost: null,
            id: 2,
            name: 'Grace',
          },
        ],
      },
    ])
  })

  it('patches ordered has-one eager parent inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
        { id: 3, author_id: 2, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('featuredPost', relationQuery => relationQuery.orderBy('id', 'desc'))
          .orderBy('id')
          .getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').insert({ id: 2, name: 'Grace' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          {
            featuredPost: { id: 3, author_id: 2, title: 'Third' },
            id: 2,
            name: 'Grace',
          },
        ],
      },
    ])
  })

  it('patches constrained has-one eager parent inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Draft' },
        { id: 3, author_id: 2, title: 'Published' },
        { id: 4, author_id: 2, title: 'Published' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        featuredPost: hasOne(() => Post, 'author_id'),
      },
    })
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('featuredPost', relationQuery => relationQuery.where('title', 'Published').orderBy('id', 'desc'))
          .orderBy('id')
          .getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').insert({ id: 2, name: 'Grace' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          {
            featuredPost: { id: 4, author_id: 2, title: 'Published' },
            id: 2,
            name: 'Grace',
          },
        ],
      },
    ])
  })

  it('patches subscribed belongs-to relation updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').where('id', 1).update({ name: 'Grace' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 1,
          title: 'First',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'author', 'name'],
        value: 'Grace',
      },
    ])
  })

  it('patches subscribed belongs-to relation inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').insert({ id: 1, name: 'Ada' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          author: null,
          author_id: 1,
          id: 1,
          title: 'First',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'author'],
        value: { id: 1, name: 'Ada' },
      },
    ])
  })

  it('patches subscribed belongs-to relation deletes to null without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 1,
          title: 'First',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'author'],
        value: null,
      },
    ])
  })

  it('patches subscribed belongs-to relation swaps after parent foreign key updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 1,
          title: 'First',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'merge',
        path: [0],
        fields: {
          author: { id: 2, name: 'Grace' },
          author_id: 2,
        },
      },
    ])
  })

  it('patches subscribed belongs-to relation swaps to null after parent foreign key updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: null })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 1,
          title: 'First',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'merge',
        path: [0],
        fields: {
          author: null,
          author_id: null,
        },
      },
    ])
  })

  it('patches subscribed belongs-to relation swaps to missing related rows without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 99 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 1,
          title: 'First',
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'merge',
        path: [0],
        fields: {
          author: null,
          author_id: 99,
        },
      },
    ])
  })

  it('patches subscribed belongs-to eager parent inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 1, author_id: 1, title: 'First' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 0,
        deleteCount: 0,
        values: [
          {
            author: { id: 1, name: 'Ada' },
            author_id: 1,
            id: 1,
            title: 'First',
          },
        ],
      },
    ])
  })

  it('patches subscribed belongs-to eager parent inserts with missing related rows to null without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [],
      posts: [],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 1, author_id: 99, title: 'First' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 0,
        deleteCount: 0,
        values: [
          {
            author: null,
            author_id: 99,
            id: 1,
            title: 'First',
          },
        ],
      },
    ])
  })

  it('patches subscribed belongs-to eager firstJson inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').firstJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 1, author_id: 1, title: 'First' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      undefined,
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [],
        value: {
          author: { id: 1, name: 'Ada' },
          author_id: 1,
          id: 1,
          title: 'First',
        },
      },
    ])
  })

  it('patches subscribed belongs-to eager paginated inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').paginateJson(10, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 1, author_id: 1, title: 'First' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [],
        meta: {
          currentPage: 1,
          from: null,
          hasMorePages: false,
          lastPage: 1,
          pageName: 'page',
          perPage: 10,
          to: null,
          total: 0,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [
          {
            author: { id: 1, name: 'Ada' },
            author_id: 1,
            id: 1,
            title: 'First',
          },
        ],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          from: 1,
          to: 1,
          total: 1,
        },
      },
    ])
  })

  it('patches ordered has-many relation inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 3, author_id: 1, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Second' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
            { id: 3, author_id: 1, title: 'Third' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'posts'],
        index: 1,
        deleteCount: 0,
        values: [
          { id: 2, author_id: 1, title: 'Second' },
        ],
      },
    ])
  })

  it('patches constrained has-many relation inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'Published' },
        { id: 3, author_id: 1, title: 'Published' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.where('title', 'Published').orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Published' })
        await context.table('posts').insert({ id: 4, author_id: 1, title: 'Draft' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'Published' },
            { id: 3, author_id: 1, title: 'Published' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'posts'],
        index: 1,
        deleteCount: 0,
        values: [
          { id: 2, author_id: 1, title: 'Published' },
        ],
      },
    ])
  })

  it('patches not-equal constrained has-many relation inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'Published' },
        { id: 3, author_id: 1, title: 'Published' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.where('title', '!=', 'Draft').orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Published' })
        await context.table('posts').insert({ id: 4, author_id: 1, title: 'Draft' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'Published' },
            { id: 3, author_id: 1, title: 'Published' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'posts'],
        index: 1,
        deleteCount: 0,
        values: [
          { id: 2, author_id: 1, title: 'Published' },
        ],
      },
    ])
  })

  it('patches in-constrained has-many relation inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'Published' },
        { id: 3, author_id: 1, title: 'Featured' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.whereIn('title', ['Published', 'Featured']).orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Featured' })
        await context.table('posts').insert({ id: 4, author_id: 1, title: 'Draft' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'Published' },
            { id: 3, author_id: 1, title: 'Featured' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'posts'],
        index: 1,
        deleteCount: 0,
        values: [
          { id: 2, author_id: 1, title: 'Featured' },
        ],
      },
    ])
  })

  it('patches subscribed has-many eager parent inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts')
          .orderBy('id')
          .getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').insert({ id: 2, name: 'Grace' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
          ],
        },
      ],
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
          ],
        },
        {
          id: 2,
          name: 'Grace',
          posts: [],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          {
            id: 2,
            name: 'Grace',
            posts: [],
          },
        ],
      },
    ])
  })

  it('keeps projected eager relation queries silent for hidden parent updates without relation backfills', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, internal: 'old', name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      internal: column.string(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .select('id', 'name')
          .with('posts')
          .orderBy('id')
          .getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').where('id', 1).update({ internal: 'new' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    const queryCountBeforeMutation = adapter.queries.length
    await executeRealtimeMutation(mutation)
    const mutationQueries = adapter.queries.slice(queryCountBeforeMutation).map(query => query.sql)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
          ],
        },
      ],
    ])
    expect(patches).toEqual([])
    expect(mutationQueries).toEqual([
      'SELECT * FROM "authors" WHERE "id" = ?',
    ])
  })

  it('patches ordered has-many eager parent inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 3, author_id: 2, title: 'Third' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.orderBy('id'))
          .orderBy('id')
          .getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').insert({ id: 2, name: 'Grace' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          {
            id: 2,
            name: 'Grace',
            posts: [
              { id: 2, author_id: 2, title: 'Second' },
              { id: 3, author_id: 2, title: 'Third' },
            ],
          },
        ],
      },
    ])
  })

  it('patches constrained has-many eager parent inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 3, author_id: 2, title: 'Published' },
        { id: 2, author_id: 2, title: 'Draft' },
        { id: 4, author_id: 2, title: 'Published' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.where('title', 'Published').orderBy('id'))
          .orderBy('id')
          .getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('authors').insert({ id: 2, name: 'Grace' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [],
        index: 1,
        deleteCount: 0,
        values: [
          {
            id: 2,
            name: 'Grace',
            posts: [
              { id: 3, author_id: 2, title: 'Published' },
              { id: 4, author_id: 2, title: 'Published' },
            ],
          },
        ],
      },
    ])
  })

  it('patches ordered has-many relation parent key moves without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 3, author_id: 2, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
          ],
        },
        {
          id: 2,
          name: 'Grace',
          posts: [
            { id: 3, author_id: 2, title: 'Third' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'posts'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: [1, 'posts'],
        index: 0,
        deleteCount: 0,
        values: [
          { id: 1, author_id: 2, title: 'First' },
        ],
      },
    ])
  })

  it('patches constrained has-many relation parent key moves without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'Published' },
        { id: 2, author_id: 1, title: 'Draft' },
        { id: 3, author_id: 2, title: 'Published' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .with('posts', relationQuery => relationQuery.where('title', 'Published').orderBy('id'))
          .orderBy('id')
          .get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ author_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'Published' },
          ],
        },
        {
          id: 2,
          name: 'Grace',
          posts: [
            { id: 3, author_id: 2, title: 'Published' },
          ],
        },
      ],
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: [0, 'posts'],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'splice',
        path: [1, 'posts'],
        index: 0,
        deleteCount: 0,
        values: [
          { id: 1, author_id: 2, title: 'Published' },
        ],
      },
    ])
  })

  it('falls back once for shared has-many relation inserts without pretending unordered rows are patchable', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const firstSnapshots: unknown[] = []
    const secondSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Author).query().with('posts').orderBy('id').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Second' })
        return true
      },
    })
    const firstPatchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        firstSnapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }
    const secondPatchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        secondSnapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, firstPatchOptions)
    await subscribeRealtimeQuery(query, {}, secondPatchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(2)
    expect(patches).toEqual([])
    expect(firstSnapshots).toEqual([
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
          ],
        },
      ],
      [
        {
          id: 1,
          name: 'Ada',
          posts: [
            { id: 1, author_id: 1, title: 'First' },
            { id: 2, author_id: 1, title: 'Second' },
          ],
        },
      ],
    ])
    expect(secondSnapshots).toEqual(firstSnapshots)
  })

  it('patches subscribed paginated queries after inserts change the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 3,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 2,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 3, title: 'Third' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 3,
          lastPage: 2,
          hasMorePages: true,
        },
      },
    ])
  })

  it('patches subscribed simple-paginated queries after inserts change the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').simplePaginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 3, title: 'Third' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: true,
      },
    ])
  })

  it('patches subscribed paginated queries after deletes shrink the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 3,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 2,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 2,
          lastPage: 1,
          hasMorePages: false,
        },
      },
    ])
  })

  it('patches subscribed simple-paginated queries after deletes shrink the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').simplePaginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: false,
      },
    ])
  })

  it('patches subscribed paginated offset-window queries after earlier-page deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').paginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 5,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 4,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 2,
          from: 3,
          to: 4,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 4,
          lastPage: 2,
          hasMorePages: false,
        },
      },
    ])
  })

  it('patches subscribed belongs-to eager simple-paginated inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id', 'desc').simplePaginateJson(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, author_id: 1, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
        ],
        meta: {
          currentPage: 1,
          from: 1,
          hasMorePages: false,
          pageName: 'page',
          perPage: 2,
          to: 2,
        },
      },
      {
        data: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 3, title: 'Third' },
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
        ],
        meta: {
          currentPage: 1,
          from: 1,
          hasMorePages: true,
          pageName: 'page',
          perPage: 2,
          to: 2,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 3, title: 'Third' },
        ],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: true,
      },
    ])
  })

  it('patches subscribed belongs-to eager paginated offset-window delete backfills without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
        { id: 4, name: 'Margaret' },
        { id: 5, name: 'Barbara' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
        { id: 3, author_id: 3, title: 'Third' },
        { id: 4, author_id: 4, title: 'Fourth' },
        { id: 5, author_id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id', 'desc').paginateJson(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { author: { id: 3, name: 'Linus' }, author_id: 3, id: 3, title: 'Third' },
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
        ],
        meta: {
          total: 5,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
        ],
        meta: {
          total: 4,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 2,
          from: 3,
          to: 4,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
        ],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 4,
          lastPage: 2,
          hasMorePages: false,
        },
      },
    ])
  })

  it('patches subscribed simple-paginated offset-window queries after earlier-page deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').simplePaginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: false,
      },
    ])
  })

  it('patches subscribed paginated offset-window queries after earlier-page inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').paginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 6, title: 'Sixth' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 5,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 4, title: 'Fourth' },
          { id: 3, title: 'Third' },
        ],
        meta: {
          total: 6,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 4, title: 'Fourth' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 6,
      },
    ])
  })

  it('patches subscribed simple-paginated offset-window queries after earlier-page inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').simplePaginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 6, title: 'Sixth' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 4, title: 'Fourth' },
          { id: 3, title: 'Third' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 4, title: 'Fourth' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches subscribed paginated query data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Updated Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        total: 2,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Second',
      },
    ])
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "posts" ORDER BY "id" DESC',
      'SELECT * FROM "posts" WHERE "id" = ?',
    ])
  })

  it('backfills subscribed paginated query data for unknown updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    const posts = adapter.tables.posts
    if (!posts) {
      throw new Error('Expected posts table to exist.')
    }
    posts[1] = { id: 2, title: 'Updated Second' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 2,
        }],
        tableName: 'posts',
      }],
    })

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Updated Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        total: 2,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('backfills filtered paginated metadata for unknown updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, status: 'published', title: 'First' },
        { id: 2, status: 'draft', title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('status', 'published')
          .orderBy('id', 'desc')
          .paginate(2, 1)
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    const posts = adapter.tables.posts
    if (!posts) {
      throw new Error('Expected posts table to exist.')
    }
    posts[1] = { id: 2, status: 'published', title: 'Second' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 2,
        }],
        tableName: 'posts',
      }],
    })

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, status: 'published', title: 'Second' },
        { id: 1, status: 'published', title: 'First' },
      ],
      meta: {
        total: 2,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [
          { id: 2, status: 'published', title: 'Second' },
          { id: 1, status: 'published', title: 'First' },
        ],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 2,
          to: 2,
        },
      },
    ])
    expect(adapter.queries.filter(query => query.sql === 'SELECT COUNT(*) AS "__holo_count" FROM "posts" WHERE "status" = ?')).toHaveLength(1)
  })

  it('backfills filtered simple-paginated metadata for unknown updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, status: 'published', title: 'First' },
        { id: 2, status: 'draft', title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .table('posts')
          .where('status', 'published')
          .orderBy('id', 'desc')
          .simplePaginate(2, 1)
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    const posts = adapter.tables.posts
    if (!posts) {
      throw new Error('Expected posts table to exist.')
    }
    posts[1] = { id: 2, status: 'published', title: 'Second' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 2,
        }],
        tableName: 'posts',
      }],
    })

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, status: 'published', title: 'Second' },
        { id: 1, status: 'published', title: 'First' },
      ],
      meta: {
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 1,
        values: [
          { id: 2, status: 'published', title: 'Second' },
          { id: 1, status: 'published', title: 'First' },
        ],
      },
      {
        op: 'replace',
        path: ['meta', 'to'],
        value: 2,
      },
    ])
    expect(adapter.queries.filter(query => query.sql === 'SELECT COUNT(*) AS "__holo_count" FROM "posts" WHERE "status" = ?')).toHaveLength(1)
  })

  it('groups exact filtered paginated count backfills for batched unknown updates', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, status: 'published', title: 'First' },
        { id: 2, status: 'draft', title: 'Second' },
        { id: 3, status: 'archived', title: 'Third' },
        { id: 4, status: 'archived', title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const publishedPatches: RealtimePatchForTest[] = []
    const draftPatches: RealtimePatchForTest[] = []
    let publishedQueryRuns = 0
    let draftQueryRuns = 0
    const publishedQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        publishedQueryRuns += 1
        return await context
          .table('posts')
          .where('status', 'published')
          .orderBy('id', 'desc')
          .paginate(2, 1)
      },
    })
    const draftQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        draftQueryRuns += 1
        return await context
          .table('posts')
          .where('status', 'draft')
          .orderBy('id', 'desc')
          .paginate(2, 1)
      },
    })
    const readExactStatusDependency = (status: string): string => {
      return `db:main:posts:where-exact:status:${encodeURIComponent(JSON.stringify(status))}`
    }
    const publishedPatchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        publishedPatches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }
    const draftPatchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        draftPatches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(publishedQuery, {}, publishedPatchOptions)
    await subscribeRealtimeQuery(draftQuery, {}, draftPatchOptions)
    const posts = adapter.tables.posts
    if (!posts) {
      throw new Error('Expected posts table to exist.')
    }

    posts[2] = { id: 3, status: 'published', title: 'Third' }
    posts[3] = { id: 4, status: 'draft', title: 'Fourth' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: '',
      dependencies: [],
    }, [
      {
        connectionName: 'main',
        dependencies: ['db:main:posts', readExactStatusDependency('published')],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 3,
          }],
          tableName: 'posts',
        }],
      },
      {
        connectionName: 'main',
        dependencies: ['db:main:posts', readExactStatusDependency('draft')],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 4,
          }],
          tableName: 'posts',
        }],
      },
    ])

    expect(publishedQueryRuns).toBe(1)
    expect(draftQueryRuns).toBe(1)
    expect(publishedPatches).toHaveLength(1)
    expect(draftPatches).toHaveLength(1)
    expect(publishedPatches[0]?.operations).toContainEqual({
      fields: {
        total: 2,
        to: 2,
      },
      op: 'merge',
      path: ['meta'],
    })
    expect(draftPatches[0]?.operations).toContainEqual({
      fields: {
        total: 2,
        to: 2,
      },
      op: 'merge',
      path: ['meta'],
    })
    expect(adapter.queries.filter(query => query.sql === 'SELECT "status", COUNT(*) AS "__holo_count" FROM "posts" WHERE "status" IN (?, ?) GROUP BY "status"')).toHaveLength(1)
    expect(adapter.queries.filter(query => query.sql === 'SELECT COUNT(*) AS "__holo_count" FROM "posts" WHERE "status" = ?')).toHaveLength(0)
  })

  it('patches returning paginated query data after stable row updates without refreshing unchanged metadata', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Updated Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        total: 2,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Second',
      },
    ])
    expect(adapter.queries.map(query => query.sql)).toEqual([
      'SELECT * FROM "posts" ORDER BY "id" DESC',
      'UPDATE "posts" SET "title" = ? WHERE "id" = ? RETURNING *',
    ])
  })

  it('patches subscribed model paginated JSON data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginateJson(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Updated Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        total: 2,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('patches subscribed model paginated JSON data after deletes shrink the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginateJson(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 3,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 2,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        total: 2,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 2,
          lastPage: 1,
          hasMorePages: false,
        },
      },
    ])
  })

  it('patches subscribed model paginated JSON offset windows after earlier-page deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginateJson(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 5,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        total: 4,
        perPage: 2,
        pageName: 'page',
        currentPage: 2,
        lastPage: 2,
        from: 3,
        to: 4,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 4,
          lastPage: 2,
          hasMorePages: false,
        },
      },
    ])
  })

  it('patches subscribed model paginated JSON offset windows after earlier-page inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginateJson(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 6, title: 'Sixth' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 5,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 4, title: 'Fourth' },
        { id: 3, title: 'Third' },
      ],
      meta: {
        total: 6,
        perPage: 2,
        pageName: 'page',
        currentPage: 2,
        lastPage: 3,
        from: 3,
        to: 4,
        hasMorePages: true,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 4, title: 'Fourth' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 6,
      },
    ])
  })

  it('patches subscribed model collections after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { id: 2, title: 'Second' },
        { id: 1, title: 'First' },
      ],
    ])
    expect(fallbackSnapshots.at(-1)).toEqual([
      { id: 2, title: 'Updated Second' },
      { id: 1, title: 'First' },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('patches subscribed model relation aggregate loads without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withCount('posts')
          .withExists('posts')
          .orderBy('id')
          .getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'Second' })
        return true
      },
    })

    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[
      {
        id: 1,
        name: 'Ada',
        posts_count: 1,
        posts_exists: true,
      },
    ]])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'posts_count'],
        value: 2,
      },
    ])
  })

  it('patches subscribed model paginated relation aggregate loads without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Other' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withCount('posts')
          .withExists('posts')
          .orderBy('id')
          .paginateJson(1, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([{
      data: [
        {
          id: 1,
          name: 'Ada',
          posts_count: 1,
          posts_exists: true,
        },
      ],
      meta: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 1,
        to: 1,
        total: 2,
      },
    }])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'posts_count'],
        value: 2,
      },
    ])
    expect(adapter.queries.some(query => query.sql.startsWith('SELECT COUNT(*) AS "__holo_count"'))).toBe(false)
  })

  it('patches subscribed model paginated numeric relation aggregate loads without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 3, title: 'Other' },
      ],
    })
    const db = createReturningContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withSum('posts', 'score')
          .withAvg('posts', 'score')
          .withMin('posts', 'score')
          .withMax('posts', 'score')
          .orderBy('id')
          .paginateJson(1, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, score: 11, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([{
      data: [
        {
          id: 1,
          name: 'Ada',
          posts_avg_score: 6,
          posts_max_score: 7,
          posts_min_score: 5,
          posts_sum_score: 12,
        },
      ],
      meta: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 1,
        to: 1,
        total: 2,
      },
    }])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'merge',
        path: ['data', 0],
        fields: {
          posts_avg_score: 23 / 3,
          posts_max_score: 11,
          posts_sum_score: 23,
        },
      },
    ])
  })

  it('keeps duplicate subscribed relation minimum and maximum aggregate updates silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 5, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 1, score: 7, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withMin('posts', 'score')
          .withMax('posts', 'score')
          .orderBy('id')
          .getJson()
      },
    })
    const updateOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ score: 6 })
        return true
      },
    })
    const updateOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).update({ score: 6 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updateOneMinimumMutation)
    await executeRealtimeMutation(updateOneMaximumMutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[
      {
        id: 1,
        name: 'Ada',
        posts_max_score: 7,
        posts_min_score: 5,
      },
    ]])
    expect(patches).toEqual([])
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(0)
  })

  it('keeps duplicate subscribed relation minimum and maximum aggregate deletes silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 5, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 1, score: 7, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withMin('posts', 'score')
          .withMax('posts', 'score')
          .orderBy('id')
          .getJson()
      },
    })
    const deleteOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const deleteOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(deleteOneMinimumMutation)
    await executeRealtimeMutation(deleteOneMaximumMutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[
      {
        id: 1,
        name: 'Ada',
        posts_max_score: 7,
        posts_min_score: 5,
      },
    ]])
    expect(patches).toEqual([])
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(0)
  })

  it('preserves duplicate relation minimum and maximum aggregate metadata after aggregate backfills', async () => {
    const tables = {
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 5, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 1, score: 7, title: 'Fourth' },
        { id: 5, author_id: 2, score: 11, title: 'Other' },
      ],
    }
    const adapter = new RelationalMemoryAdapter(tables)
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withMin('posts', 'score')
          .withMax('posts', 'score')
          .orderBy('id')
          .getJson()
      },
    })
    const deleteOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    tables.posts[0] = { id: 1, author_id: 1, score: 5, title: 'Renamed' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts', 'db:main:posts:where-exact:author_id:1'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 1,
        }],
        tableName: 'posts',
      }],
    })
    await executeRealtimeMutation(deleteOneMaximumMutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[
      {
        id: 1,
        name: 'Ada',
        posts_max_score: 7,
        posts_min_score: 5,
      },
      {
        id: 2,
        name: 'Grace',
        posts_max_score: 11,
        posts_min_score: 11,
      },
    ]])
    expect(patches).toEqual([])
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(1)
  })

  it('filters batched relation aggregate backfills to exact invalidated predicates', async () => {
    const tables = {
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 2, score: 9, title: 'Fourth' },
        { id: 5, author_id: 2, score: 11, title: 'Fifth' },
        { id: 6, author_id: 2, score: 11, title: 'Sixth' },
        { id: 7, author_id: 3, score: 13, title: 'Seventh' },
      ],
    }
    const adapter = new RelationalMemoryAdapter(tables)
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withMax('posts', 'score')
          .orderBy('id')
          .getJson()
      },
    })
    const deleteFirstDuplicateMaximum = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const deleteSecondDuplicateMaximum = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    tables.posts[0] = { id: 1, author_id: 1, score: 5, title: 'Renamed first' }
    tables.posts[3] = { id: 4, author_id: 2, score: 9, title: 'Renamed fourth' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: [],
    }, [
      {
        connectionName: 'main',
        dependencies: ['db:main:posts', 'db:main:posts:where-exact:author_id:1'],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 1,
          }],
          tableName: 'posts',
        }],
      },
      {
        connectionName: 'main',
        dependencies: ['db:main:posts', 'db:main:posts:where-exact:author_id:2'],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 4,
          }],
          tableName: 'posts',
        }],
      },
    ])
    await executeRealtimeMutation(deleteFirstDuplicateMaximum)
    await executeRealtimeMutation(deleteSecondDuplicateMaximum)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[
      {
        id: 1,
        name: 'Ada',
        posts_max_score: 7,
      },
      {
        id: 2,
        name: 'Grace',
        posts_max_score: 11,
      },
      {
        id: 3,
        name: 'Linus',
        posts_max_score: 13,
      },
    ]])
    expect(patches).toEqual([])
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(2)
  })

  it('filters mixed batched relation aggregate mutations per exact invalidated predicate', async () => {
    const tables = {
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 2, score: 9, title: 'Fourth' },
        { id: 5, author_id: 2, score: 11, title: 'Fifth' },
        { id: 6, author_id: 2, score: 11, title: 'Sixth' },
        { id: 7, author_id: 3, score: 13, title: 'Seventh' },
      ],
    }
    const adapter = new RelationalMemoryAdapter(tables)
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withMax('posts', 'score')
          .orderBy('id')
          .getJson()
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    tables.posts[1] = { id: 2, author_id: 1, score: 6, title: 'Second' }
    tables.posts[3] = { id: 4, author_id: 2, score: 9, title: 'Renamed fourth' }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: [],
    }, [
      {
        connectionName: 'main',
        dependencies: ['db:main:posts', 'db:main:posts:where-exact:author_id:1'],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 2,
          }],
          previousRows: [{
            author_id: 1,
            id: 2,
            score: 7,
            title: 'Second',
          }],
          rows: [{
            author_id: 1,
            id: 2,
            score: 6,
            title: 'Second',
          }],
          tableName: 'posts',
          values: {
            score: 6,
          },
        }],
      },
      {
        connectionName: 'main',
        dependencies: ['db:main:posts', 'db:main:posts:where-exact:author_id:2'],
        mutations: [{
          connectionName: 'main',
          kind: 'update',
          predicates: [{
            column: 'id',
            operator: '=',
            value: 4,
          }],
          tableName: 'posts',
        }],
      },
    ])

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[
      {
        id: 1,
        name: 'Ada',
        posts_max_score: 7,
      },
      {
        id: 2,
        name: 'Grace',
        posts_max_score: 11,
      },
      {
        id: 3,
        name: 'Linus',
        posts_max_score: 13,
      },
    ]])
    expect(patches).toEqual([])
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(1)
  })

  it('keeps duplicate subscribed relation minimum and maximum aggregate upserts silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
      ],
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 5, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 1, score: 7, title: 'Fourth' },
      ],
    })
    const db = createReturningContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const Author = defineModel(authors, {
      relations: {
        posts: hasMany(() => Post, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Author)
          .query()
          .withMin('posts', 'score')
          .withMax('posts', 'score')
          .orderBy('id')
          .getJson()
      },
    })
    const upsertOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 1, author_id: 1, score: 6, title: 'First' },
          ['id'],
          ['score'],
        )
        return true
      },
    })
    const upsertOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 3, author_id: 1, score: 6, title: 'Third' },
          ['id'],
          ['score'],
        )
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(upsertOneMinimumMutation)
    await executeRealtimeMutation(upsertOneMaximumMutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[
      {
        id: 1,
        name: 'Ada',
        posts_max_score: 7,
        posts_min_score: 5,
      },
    ]])
    expect(patches).toEqual([])
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(0)
  })

  it('patches subscribed model count and existence queries without rerunning handlers', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const postQuery = context.model(Post).query().where('author_id', 1)
        return {
          count: await postQuery.count(),
          doesntExist: await postQuery.doesntExist(),
          exists: await postQuery.exists(),
        }
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, title: 'First' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([{
      count: 0,
      doesntExist: true,
      exists: false,
    }])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        fields: {
          count: 1,
          doesntExist: false,
          exists: true,
        },
        op: 'merge',
        path: [],
      },
    ])
  })

  it('keeps subscribed model existence queries silent while updating aggregate count metadata', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [{ id: 1, author_id: 1, title: 'First' }],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const postQuery = context.model(Post).query().where('author_id', 1)
        return {
          doesntExist: await postQuery.doesntExist(),
          exists: await postQuery.exists(),
        }
      },
    })
    const insertPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 2, author_id: 1, title: 'Second' })
        return true
      },
    })
    const deleteFirstPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const deleteSecondPost = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(insertPost)
    await executeRealtimeMutation(deleteFirstPost)
    await executeRealtimeMutation(deleteSecondPost)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([{
      doesntExist: false,
      exists: true,
    }])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        fields: {
          doesntExist: true,
          exists: false,
        },
        op: 'merge',
        path: [],
      },
    ])
  })

  it('patches subscribed model aggregate queries without rerunning handlers', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 2, score: 100, title: 'Other' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const postsByAuthor = () => context.model(Post).query().where('author_id', 1)
        return {
          average: await postsByAuthor().avg('score'),
          maximum: await postsByAuthor().max('score'),
          minimum: await postsByAuthor().min('score'),
          score: await postsByAuthor().sum('score'),
        }
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ author_id: 1, score: 11, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([{
      average: 6,
      maximum: 7,
      minimum: 5,
      score: 12,
    }])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        fields: {
          average: 23 / 3,
          maximum: 11,
          score: 23,
        },
        op: 'merge',
        path: [],
      },
    ])
  })

  it('keeps duplicate subscribed model extreme aggregates silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 7, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().where('author_id', 1).max('score')
      },
    })
    const deleteOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const deleteLastMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: number | null }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(deleteOneMaximumMutation)
    await executeRealtimeMutation(deleteLastMaximumMutation)

    expect(snapshots).toEqual([7])
    expect(patches).toEqual([
      {
        operations: [{
          op: 'replace',
          path: [],
          value: 5,
        }],
        version: 2,
      },
    ])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(0)
  })

  it('keeps duplicate subscribed model minimum and maximum aggregate updates silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 5, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 1, score: 7, title: 'Fourth' },
        { id: 5, author_id: 2, score: 100, title: 'Other' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const postsByAuthor = () => context.model(Post).query().where('author_id', 1)
        return {
          maximum: await postsByAuthor().max('score'),
          minimum: await postsByAuthor().min('score'),
        }
      },
    })
    const updateOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ score: 6 })
        return true
      },
    })
    const updateOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).update({ score: 6 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updateOneMinimumMutation)
    await executeRealtimeMutation(updateOneMaximumMutation)

    expect(snapshots).toEqual([{
      maximum: 7,
      minimum: 5,
    }])
    expect(patches).toEqual([])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(0)
  })

  it('keeps duplicate subscribed model minimum and maximum aggregate upserts silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, score: 5, title: 'First' },
        { id: 2, author_id: 1, score: 5, title: 'Second' },
        { id: 3, author_id: 1, score: 7, title: 'Third' },
        { id: 4, author_id: 1, score: 7, title: 'Fourth' },
        { id: 5, author_id: 2, score: 100, title: 'Other' },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      score: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        const postsByAuthor = () => context.model(Post).query().where('author_id', 1)
        return {
          maximum: await postsByAuthor().max('score'),
          minimum: await postsByAuthor().min('score'),
        }
      },
    })
    const upsertOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 1, author_id: 1, score: 6, title: 'First' },
          ['id'],
          ['score'],
        )
        return true
      },
    })
    const upsertOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 3, author_id: 1, score: 6, title: 'Third' },
          ['id'],
          ['score'],
        )
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(upsertOneMinimumMutation)
    await executeRealtimeMutation(upsertOneMaximumMutation)

    expect(snapshots).toEqual([{
      maximum: 7,
      minimum: 5,
    }])
    expect(patches).toEqual([])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql.includes('__holo_count'))).toHaveLength(0)
  })

  it('patches subscribed model value queries without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().where('id', 1).value('title')
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Updated' })
        return true
      },
    })
    const deleteMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)
    await executeRealtimeMutation(deleteMutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual(['First'])
    expect(patches.map(patch => patch.operations)).toEqual([
      [{
        op: 'replace',
        path: [],
        value: 'Updated',
      }],
      [{
        op: 'replace',
        path: [],
        valueKind: 'undefined',
      }],
    ])
  })

  it('patches subscribed model pluck queries without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 1, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context
          .model(Post)
          .query()
          .where('author_id', 1)
          .orderBy('id')
          .pluck('title')
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([['First', 'Second']])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([{
      op: 'replace',
      path: [1],
      value: 'Updated Second',
    }])
  })

  it('patches subscribed model single-record results after stable row updates without rerunning handlers', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    const queryRuns = {
      first: 0,
      firstJson: 0,
      sole: 0,
      soleJson: 0,
    }
    const firstQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns.first += 1
        return await context.model(Post).query().orderBy('id', 'desc').first()
      },
    })
    const firstJsonQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns.firstJson += 1
        return await context.model(Post).query().orderBy('id', 'desc').firstJson()
      },
    })
    const soleQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns.sole += 1
        return await context.model(Post).query().where('id', 2).sole()
      },
    })
    const soleJsonQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns.soleJson += 1
        return await context.model(Post).query().where('id', 2).soleJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const createPatchOptions = () => ({
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    })
    const createFallbackOptions = () => ({
      onData(snapshot: { readonly data: unknown }) {
        fallbackSnapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
    })

    await subscribeRealtimeQuery(firstQuery, {}, createPatchOptions())
    await subscribeRealtimeQuery(firstJsonQuery, {}, createPatchOptions())
    await subscribeRealtimeQuery(soleQuery, {}, createPatchOptions())
    await subscribeRealtimeQuery(soleJsonQuery, {}, createPatchOptions())
    await subscribeRealtimeQuery(firstQuery, {}, createFallbackOptions())
    await subscribeRealtimeQuery(firstJsonQuery, {}, createFallbackOptions())
    await subscribeRealtimeQuery(soleQuery, {}, createFallbackOptions())
    await subscribeRealtimeQuery(soleJsonQuery, {}, createFallbackOptions())
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toEqual({
      first: 1,
      firstJson: 1,
      sole: 1,
      soleJson: 1,
    })
    expect(snapshots).toEqual([
      { id: 2, title: 'Second' },
      { id: 2, title: 'Second' },
      { id: 2, title: 'Second' },
      { id: 2, title: 'Second' },
    ])
    expect(fallbackSnapshots.slice(-4)).toEqual([
      { id: 2, title: 'Updated Second' },
      { id: 2, title: 'Updated Second' },
      { id: 2, title: 'Updated Second' },
      { id: 2, title: 'Updated Second' },
    ])
    expect(patches).toHaveLength(4)
    expect(patches.map(patch => patch.operations)).toEqual([
      [{
        op: 'replace',
        path: ['title'],
        value: 'Updated Second',
      }],
      [{
        op: 'replace',
        path: ['title'],
        value: 'Updated Second',
      }],
      [{
        op: 'replace',
        path: ['title'],
        value: 'Updated Second',
      }],
      [{
        op: 'replace',
        path: ['title'],
        value: 'Updated Second',
      }],
    ])
  })

  it('falls back for transformed model serialization instead of patching unsafe row shapes', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', secret: 'alpha' },
        { id: 2, title: 'Second', secret: 'beta' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      secret: column.string(),
    })
    const Post = defineModel(posts, {
      hidden: ['secret'],
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ secret: 'gamma' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(2)
    expect(patches).toEqual([])
    expect(snapshots).toEqual([
      [
        { id: 2, title: 'Second' },
        { id: 1, title: 'First' },
      ],
    ])
  })

  it('patches subscribed model paginated data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Updated Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        total: 2,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('patches subscribed model paginated data and metadata after inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 3,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 2,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 3, title: 'Third' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 3,
          lastPage: 2,
          hasMorePages: true,
        },
      },
    ])
  })

  it('patches subscribed model paginated data after deletes shrink the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 3,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 2,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 2,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 2,
          lastPage: 1,
          hasMorePages: false,
        },
      },
    ])
  })

  it('patches subscribed model paginated offset windows after earlier-page deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 5,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          total: 4,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 2,
          from: 3,
          to: 4,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          total: 4,
          lastPage: 2,
          hasMorePages: false,
        },
      },
    ])
  })

  it('patches subscribed model paginated offset windows after earlier-page inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').paginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 6, title: 'Sixth' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          total: 5,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 4, title: 'Fourth' },
          { id: 3, title: 'Third' },
        ],
        meta: {
          total: 6,
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          lastPage: 3,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 4, title: 'Fourth' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'replace',
        path: ['meta', 'total'],
        value: 6,
      },
    ])
  })

  it('patches subscribed model simple-paginated data and metadata after inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 3, title: 'Third' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: true,
      },
    ])
  })

  it('patches subscribed model simple-paginated data after deletes shrink the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: false,
      },
    ])
  })

  it('patches subscribed model simple-paginated offset windows after earlier-page deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: false,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: false,
      },
    ])
  })

  it('patches subscribed model simple-paginated offset windows after earlier-page inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginate(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 6, title: 'Sixth' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
      {
        data: [
          { id: 4, title: 'Fourth' },
          { id: 3, title: 'Third' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 4, title: 'Fourth' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches subscribed model simple-paginated data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginate(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Updated Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('patches subscribed model cursor-paginated data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 4).update({ title: 'Updated Fourth' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    const initialCursor = fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
      ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
      : null

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 4, title: 'Fourth' },
          { id: 3, title: 'Third' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: initialCursor,
        prevCursor: null,
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 4, title: 'Updated Fourth' },
        { id: 3, title: 'Third' },
      ],
      perPage: 2,
      cursorName: 'cursor',
      nextCursor: initialCursor,
      prevCursor: null,
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Fourth',
      },
    ])
  })

  it('patches first-page model cursor-paginated data and next cursor after inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    const finalCursor = fallbackSnapshots[1] && typeof fallbackSnapshots[1] === 'object'
      ? (fallbackSnapshots[1] as { readonly nextCursor?: unknown }).nextCursor
      : null

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: null,
        prevCursor: null,
      },
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: finalCursor,
        prevCursor: null,
      },
    ])
    expect(typeof finalCursor).toBe('string')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: finalCursor,
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 3, title: 'Third' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches first-page model cursor-paginated data and next cursor after deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
          ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
          : null,
        prevCursor: null,
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: null,
        prevCursor: null,
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: null,
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
    ])
  })

  it('patches subscribed model JSON collections after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').getJson()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      [
        { id: 2, title: 'Second' },
        { id: 1, title: 'First' },
      ],
    ])
    expect(fallbackSnapshots.at(-1)).toEqual([
      { id: 2, title: 'Updated Second' },
      { id: 1, title: 'First' },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: [0, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('patches subscribed model simple-paginated JSON data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginateJson(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ title: 'Updated Second' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: false,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Updated Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Second',
      },
    ])
  })

  it('patches subscribed model simple-paginated JSON data after deletes shrink the current window without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginateJson(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        from: 1,
        to: 2,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: false,
      },
    ])
  })

  it('patches subscribed model simple-paginated JSON offset windows after earlier-page deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginateJson(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 5).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 2, title: 'Second' },
        { id: 1, title: 'First' },
      ],
      meta: {
        perPage: 2,
        pageName: 'page',
        currentPage: 2,
        from: 3,
        to: 4,
        hasMorePages: false,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: false,
      },
    ])
  })

  it('patches subscribed model simple-paginated JSON offset windows after earlier-page inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
        { id: 5, title: 'Fifth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').simplePaginateJson(2, 2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 6, title: 'Sixth' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        meta: {
          perPage: 2,
          pageName: 'page',
          currentPage: 2,
          from: 3,
          to: 4,
          hasMorePages: true,
        },
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 4, title: 'Fourth' },
        { id: 3, title: 'Third' },
      ],
      meta: {
        perPage: 2,
        pageName: 'page',
        currentPage: 2,
        from: 3,
        to: 4,
        hasMorePages: true,
      },
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 4, title: 'Fourth' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches subscribed model cursor-paginated JSON data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').cursorPaginateJson(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 4).update({ title: 'Updated Fourth' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    const initialCursor = fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
      ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
      : null

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 4, title: 'Fourth' },
          { id: 3, title: 'Third' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: initialCursor,
        prevCursor: null,
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 4, title: 'Updated Fourth' },
        { id: 3, title: 'Third' },
      ],
      perPage: 2,
      cursorName: 'cursor',
      nextCursor: initialCursor,
      prevCursor: null,
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Fourth',
      },
    ])
  })

  it('patches subscribed belongs-to eager paginated delete backfills without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
        { id: 3, author_id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id').paginateJson(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).delete()
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
        ],
        meta: {
          currentPage: 1,
          from: 1,
          hasMorePages: true,
          lastPage: 2,
          pageName: 'page',
          perPage: 2,
          to: 2,
          total: 3,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [
          { author: { id: 3, name: 'Linus' }, author_id: 3, id: 3, title: 'Third' },
        ],
      },
      {
        op: 'merge',
        path: ['meta'],
        fields: {
          hasMorePages: false,
          lastPage: 1,
          total: 2,
        },
      },
    ])
  })

  it('patches subscribed belongs-to eager simple-paginated delete backfills without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
        { id: 3, author_id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id', 'desc').simplePaginateJson(2, 1)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError: (error: unknown) => {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { author: { id: 3, name: 'Linus' }, author_id: 3, id: 3, title: 'Third' },
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
        ],
        meta: {
          currentPage: 1,
          from: 1,
          hasMorePages: true,
          pageName: 'page',
          perPage: 2,
          to: 2,
        },
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
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
        index: 1,
        deleteCount: 0,
        values: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
        ],
      },
      {
        op: 'replace',
        path: ['meta', 'hasMorePages'],
        value: false,
      },
    ])
  })

  it('patches first-page model cursor-paginated JSON belongs-to inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id', 'desc').cursorPaginateJson(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, author_id: 1, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    const finalCursor = fallbackSnapshots[1] && typeof fallbackSnapshots[1] === 'object'
      ? (fallbackSnapshots[1] as { readonly nextCursor?: unknown }).nextCursor
      : null

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: null,
        prevCursor: null,
      },
      {
        data: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 3, title: 'Third' },
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: finalCursor,
        prevCursor: null,
      },
    ])
    expect(typeof finalCursor).toBe('string')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: finalCursor,
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 3, title: 'Third' },
        ],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches first-page model cursor-paginated JSON belongs-to delete backfills without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      authors: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
      ],
      posts: [
        { id: 1, author_id: 1, title: 'First' },
        { id: 2, author_id: 2, title: 'Second' },
        { id: 3, author_id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: db,
      },
    }))
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const authors = defineGeneratedTable('authors', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    const Author = defineModel(authors)
    const Post = defineModel(posts, {
      relations: {
        author: belongsTo(() => Author, 'author_id'),
      },
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().with('author').orderBy('id', 'desc').cursorPaginateJson(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { author: { id: 3, name: 'Linus' }, author_id: 3, id: 3, title: 'Third' },
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
          ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
          : null,
        prevCursor: null,
      },
      {
        data: [
          { author: { id: 2, name: 'Grace' }, author_id: 2, id: 2, title: 'Second' },
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: null,
        prevCursor: null,
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: null,
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
        index: 1,
        deleteCount: 0,
        values: [
          { author: { id: 1, name: 'Ada' }, author_id: 1, id: 1, title: 'First' },
        ],
      },
    ])
  })

  it('patches first-page model cursor-paginated JSON data and next cursor after deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    const Post = defineModel(posts)
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.model(Post).query().orderBy('id', 'desc').cursorPaginateJson(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
          ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
          : null,
        prevCursor: null,
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: null,
        prevCursor: null,
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: null,
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
    ])
  })

  it('keeps subscribed cursor-paginated query windows anchored after earlier inserts', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: Array<{
      readonly ids: readonly number[]
      readonly cursorName: string
      readonly hasMorePages: boolean
    }> = []
    const firstPageQuery = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const query = defineRealtimeQuery({
      args: schema({
        cursor: field.string().nullable(),
      }),
      access: 'public',
      handler: async ({ args, db: context }) => {
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2, args.cursor)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 5, title: 'Fifth' })
        return true
      },
    })
    const firstPage = await executeRealtimeQuery(firstPageQuery)

    await subscribeRealtimeQuery(query, { cursor: firstPage.data.nextCursor }, {
      onData: snapshot => {
        snapshots.push({
          ids: snapshot.data.data.map(post => Number(post.id)),
          cursorName: snapshot.data.cursorName,
          hasMorePages: snapshot.data.nextCursor !== null,
        })
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(snapshots).toEqual([
      {
        ids: [2, 1],
        cursorName: 'cursor',
        hasMorePages: false,
      },
    ])
  })

  it('patches first-page cursor-paginated query data and next cursor after inserts without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    const finalCursor = fallbackSnapshots[1] && typeof fallbackSnapshots[1] === 'object'
      ? (fallbackSnapshots[1] as { readonly nextCursor?: unknown }).nextCursor
      : null

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: null,
        prevCursor: null,
      },
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: finalCursor,
        prevCursor: null,
      },
    ])
    expect(typeof finalCursor).toBe('string')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: finalCursor,
      },
      {
        op: 'splice',
        path: ['data'],
        index: 0,
        deleteCount: 0,
        values: [{ id: 3, title: 'Third' }],
      },
      {
        op: 'splice',
        path: ['data'],
        index: 2,
        deleteCount: 1,
        values: [],
      },
    ])
  })

  it('patches first-page cursor-paginated query data and next cursor after deletes without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(fallbackSnapshots).toEqual([
      {
        data: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
          ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
          : null,
        prevCursor: null,
      },
      {
        data: [
          { id: 2, title: 'Second' },
          { id: 1, title: 'First' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: null,
        prevCursor: null,
      },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['nextCursor'],
        value: null,
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
        index: 1,
        deleteCount: 0,
        values: [{ id: 1, title: 'First' }],
      },
    ])
  })

  it('patches subscribed cursor-paginated query data after stable row updates without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
        { id: 4, title: 'Fourth' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const fallbackSnapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 4).update({ title: 'Updated Fourth' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
      onError(error: unknown) {
        throw error
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        fallbackSnapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      {
        data: [
          { id: 4, title: 'Fourth' },
          { id: 3, title: 'Third' },
        ],
        perPage: 2,
        cursorName: 'cursor',
        nextCursor: fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
          ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
          : null,
        prevCursor: null,
      },
    ])
    expect(fallbackSnapshots.at(-1)).toEqual({
      data: [
        { id: 4, title: 'Updated Fourth' },
        { id: 3, title: 'Third' },
      ],
      perPage: 2,
      cursorName: 'cursor',
      nextCursor: fallbackSnapshots[0] && typeof fallbackSnapshots[0] === 'object'
        ? (fallbackSnapshots[0] as { readonly nextCursor?: unknown }).nextCursor
        : null,
      prevCursor: null,
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['data', 0, 'title'],
        value: 'Updated Fourth',
      },
    ])
  })

  it('patches subscribed aggregate queries after writes change aggregate values', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          average: await context.table('posts').avg('views'),
          count: await context.table('posts').count(),
          maximum: await context.table('posts').max('views'),
          views: await context.table('posts').sum('views'),
        }
      },
    })
    const insertMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third', views: 11 })
        return true
      },
    })
    const updateMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ views: 9 })
        return true
      },
    })
    const deleteMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(insertMutation)
    await executeRealtimeMutation(updateMutation)
    await executeRealtimeMutation(deleteMutation)

    expect(snapshots).toEqual([
      { average: 6, count: 2, maximum: 7, views: 12 },
      { average: 23 / 3, count: 3, maximum: 11, views: 23 },
      { average: 9, count: 3, maximum: 11, views: 27 },
      { average: 10, count: 2, maximum: 11, views: 20 },
    ])
    expect(queryRuns).toBe(1)
  })

  it('delivers compact aggregate patches without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          count: await context.table('posts').count(),
          views: await context.table('posts').sum('views'),
        }
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third', views: 3 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { count: 2, views: 12 },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'merge',
        path: [],
        fields: {
          count: 3,
          views: 15,
        },
      },
    ])
  })

  it('patches ambiguous primitive aggregate result bindings when all candidates produce the same value', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          count: await context.table('posts').count(),
          maximum: await context.table('posts').max('id'),
        }
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        fields: {
          count: 3,
          maximum: 3,
        },
        op: 'merge',
        path: [],
      },
    ])
    expect(snapshots).toEqual([
      { count: 2, maximum: 2 },
    ])
  })

  it('falls back safely when ambiguous primitive aggregate bindings produce different values', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          count: await context.table('posts').count(),
          maximum: await context.table('posts').max('id'),
        }
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 4, title: 'Fourth' })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(2)
    expect(patches).toEqual([])
    expect(snapshots).toEqual([
      { count: 2, maximum: 2 },
      { count: 3, maximum: 4 },
    ])
  })

  it('keeps unchanged average aggregates silent while updating aggregate metadata', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').avg('views')
      },
    })
    const unchangedAverageMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third', views: 6 })
        return true
      },
    })
    const changedAverageMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 4, title: 'Fourth', views: 10 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(unchangedAverageMutation)
    await executeRealtimeMutation(changedAverageMutation)

    expect(snapshots).toEqual([6, 7])
    expect(queryRuns).toBe(1)
  })

  it('patches subscribed constrained average aggregates when rows leave the predicate without rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', user_id: 1, views: 5 },
        { id: 2, title: 'Second', user_id: 1, views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').where('user_id', 1).avg('views')
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ user_id: 2 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: number | null }) {
        snapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(mutation)

    expect(snapshots).toEqual([6])
    expect(patches.map(patch => patch.operations)).toEqual([
      [
        {
          op: 'replace',
          path: [],
          value: 5,
        },
      ],
    ])
    expect(queryRuns).toBe(1)
  })

  it('patches subscribed minimum aggregates when inserts change the minimum', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').min('views')
      },
    })
    const insertMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ id: 3, title: 'Third', views: 3 })
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(insertMutation)

    expect(snapshots).toEqual([5, 3])
    expect(queryRuns).toBe(1)
  })

  it('keeps patched duplicate minimum aggregate metadata without backfilling later deletes', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').min('views')
      },
    })
    const insertDuplicateMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert([
          { id: 3, title: 'Third', views: 3 },
          { id: 4, title: 'Fourth', views: 3 },
        ])
        return true
      },
    })
    const deleteOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: number | null }) {
        snapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(insertDuplicateMinimumMutation)
    await executeRealtimeMutation(deleteOneMinimumMutation)

    expect(snapshots).toEqual([5])
    expect(patches.map(patch => patch.operations)).toEqual([
      [
        {
          op: 'replace',
          path: [],
          value: 3,
        },
      ],
    ])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
  })

  it('patches extreme aggregate updates that replace the current extreme without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          maximum: await context.table('posts').max('views'),
          minimum: await context.table('posts').min('views'),
        }
      },
    })
    const increaseMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ views: 11 })
        return true
      },
    })
    const decreaseMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ views: 3 })
        return true
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onError(error: unknown) {
        throw error
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(increaseMaximumMutation)
    await executeRealtimeMutation(decreaseMinimumMutation)

    expect(snapshots).toEqual([
      { maximum: 7, minimum: 5 },
    ])
    expect(patches.map(patch => patch.operations)).toEqual([
      [
        {
          op: 'replace',
          path: ['maximum'],
          value: 11,
        },
      ],
      [
        {
          op: 'replace',
          path: ['minimum'],
          value: 3,
        },
      ],
    ])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
  })

  it('patches subscribed extreme aggregate runner-up values without rerunning or backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          maximum: await context.table('posts').max('views'),
          minimum: await context.table('posts').min('views'),
        }
      },
    })
    const updateMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).update({ views: 4 })
        return true
      },
    })
    const deleteMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(updateMutation)
    await executeRealtimeMutation(deleteMutation)

    expect(snapshots).toEqual([
      { maximum: 7, minimum: 5 },
      { maximum: 5, minimum: 4 },
      { maximum: 5, minimum: 5 },
    ])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
    expect(adapter.queries).not.toContainEqual({
      sql: 'SELECT "views" FROM "posts" ORDER BY "views" DESC LIMIT 1',
      bindings: [],
    })
    expect(adapter.queries).not.toContainEqual({
      sql: 'SELECT "views" FROM "posts" ORDER BY "views" ASC LIMIT 1',
      bindings: [],
    })
  })

  it('preserves duplicate extreme aggregate metadata after aggregate backfills', async () => {
    const tables = {
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
        { id: 3, title: 'Third', views: 7 },
      ],
    }
    const adapter = new RelationalMemoryAdapter(tables)
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').max('views')
      },
    })
    const deleteOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const handlePatchError = (error: unknown): never => {
      throw error
    }
    const patchOptions = {
      onData: (snapshot: { readonly data: number | null }) => {
        snapshots.push(snapshot.data)
      },
      onError: handlePatchError,
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    tables.posts[0] = { id: 1, title: 'First', views: 6 }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 1,
        }],
        tableName: 'posts',
      }],
    })
    await executeRealtimeMutation(deleteOneMaximumMutation)

    expect(snapshots).toEqual([7])
    expect(patches).toEqual([])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(1)
  })

  it('keeps duplicate current extreme aggregates silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
        { id: 3, title: 'Third', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').max('views')
      },
    })
    const deleteOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 2).delete()
        return true
      },
    })
    const deleteLastMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).delete()
        return true
      },
    })

    const patchOptions = {
      onData: (snapshot: { readonly data: number | null }) => {
        snapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(deleteOneMaximumMutation)
    await executeRealtimeMutation(deleteLastMaximumMutation)

    expect(snapshots).toEqual([7])
    expect(patches).toEqual([
      {
        operations: [{
          op: 'replace',
          path: [],
          value: 5,
        }],
        version: 2,
      },
    ])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
  })

  it('keeps duplicate current minimum and maximum aggregate updates silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 5 },
        { id: 3, title: 'Third', views: 7 },
        { id: 4, title: 'Fourth', views: 7 },
      ],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          maximum: await context.table('posts').max('views'),
          minimum: await context.table('posts').min('views'),
        }
      },
    })
    const updateOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ views: 6 })
        return true
      },
    })
    const updateOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 3).update({ views: 6 })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updateOneMinimumMutation)
    await executeRealtimeMutation(updateOneMaximumMutation)

    expect(snapshots).toEqual([
      { maximum: 7, minimum: 5 },
    ])
    expect(patches).toEqual([])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
  })

  it('keeps duplicate current minimum and maximum aggregate upserts silent without backfilling', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 5 },
        { id: 3, title: 'Third', views: 7 },
        { id: 4, title: 'Fourth', views: 7 },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          maximum: await context.table('posts').max('views'),
          minimum: await context.table('posts').min('views'),
        }
      },
    })
    const upsertOneMinimumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 1, title: 'First', views: 6 },
          ['id'],
          ['views'],
        )
        return true
      },
    })
    const upsertOneMaximumMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 3, title: 'Third', views: 6 },
          ['id'],
          ['views'],
        )
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
      onPatch: (patch: RealtimePatchForTest) => {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(upsertOneMinimumMutation)
    await executeRealtimeMutation(upsertOneMaximumMutation)

    expect(snapshots).toEqual([
      { maximum: 7, minimum: 5 },
    ])
    expect(patches).toEqual([])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
  })

  it('patches all subscribed aggregate kinds for returning upserts without rerunning the query handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          average: await context.table('posts').avg('views'),
          count: await context.table('posts').count(),
          maximum: await context.table('posts').max('views'),
          minimum: await context.table('posts').min('views'),
          views: await context.table('posts').sum('views'),
        }
      },
    })
    const upsertMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').upsert(
          { id: 2, title: 'Second', views: 10 },
          ['id'],
          ['views'],
        )
        return true
      },
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        throw error
      },
    })
    await executeRealtimeMutation(upsertMutation)

    expect(snapshots).toEqual([
      { average: 6, count: 2, maximum: 7, minimum: 5, views: 12 },
      { average: 7.5, count: 2, maximum: 10, minimum: 5, views: 15 },
    ])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
    expect(adapter.queries).not.toContainEqual({
      sql: 'SELECT "views" FROM "posts"',
      bindings: [],
    })
    expect(adapter.queries).not.toContainEqual({
      sql: 'SELECT "views" FROM "posts" ORDER BY "views" DESC LIMIT 1',
      bindings: [],
    })
    expect(adapter.queries).not.toContainEqual({
      sql: 'SELECT "views" FROM "posts" ORDER BY "views" ASC LIMIT 1',
      bindings: [],
    })
  })

  it('keeps irrelevant returning aggregate updates silent without backfilling or rerunning the handler', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    })
    const db = createReturningContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          average: await context.table('posts').avg('views'),
          count: await context.table('posts').count(),
          maximum: await context.table('posts').max('views'),
          minimum: await context.table('posts').min('views'),
          views: await context.table('posts').sum('views'),
        }
      },
    })
    const updateMutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 1).update({ title: 'Renamed' })
        return true
      },
    })
    const patchOptions = {
      onData: (snapshot: { readonly data: unknown }) => {
        snapshots.push(snapshot.data)
      },
      onError: (error: unknown) => {
        throw error
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    await executeRealtimeMutation(updateMutation)

    expect(snapshots).toEqual([
      { average: 6, count: 2, maximum: 7, minimum: 5, views: 12 },
    ])
    expect(patches).toEqual([])
    expect(queryRuns).toBe(1)
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(0)
  })

  it('falls back to aggregate backfill when update invalidations omit changed value metadata', async () => {
    const tables = {
      posts: [
        { id: 1, title: 'First', views: 5 },
        { id: 2, title: 'Second', views: 7 },
      ],
    }
    const adapter = new RelationalMemoryAdapter(tables)
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[] = []
    const patches: RealtimePatchForTest[] = []
    let queryRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return {
          count: await context.table('posts').count(),
          views: await context.table('posts').sum('views'),
        }
      },
    })
    const patchOptions = {
      onData(snapshot: { readonly data: unknown }) {
        snapshots.push(snapshot.data)
      },
      onPatch(patch: RealtimePatchForTest) {
        patches.push(patch)
      },
    }

    await subscribeRealtimeQuery(query, {}, patchOptions)
    tables.posts[0] = { id: 1, title: 'First', views: 9 }
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
      mutations: [{
        connectionName: 'main',
        kind: 'update',
        predicates: [{
          column: 'id',
          operator: '=',
          value: 1,
        }],
        tableName: 'posts',
      }],
    })

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([
      { count: 2, views: 12 },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      {
        op: 'replace',
        path: ['views'],
        value: 16,
      },
    ])
    expect(adapter.queries.filter(query => query.sql === postsViewsAggregateBackfillSql)).toHaveLength(1)
  })

  it('supports client helpers and unsubscribes from later refreshes', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const client = createRealtimeClient()
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => context.table('posts').get(),
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return { count: adapter.rows.length }
      },
    })

    await expect(client.query(query, {})).resolves.toMatchObject({
      data: [{ id: 1, title: 'First' }],
    })
    const subscription = await client.subscribe(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await expect(client.mutate(mutation, {})).resolves.toMatchObject({
      data: { count: 2 },
    })
    subscription.unsubscribe()
    await client.mutate(mutation, {})

    expect(subscription.current.data).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Post 2' },
    ])
    expect(snapshots).toEqual([
      [{ id: 1, title: 'First' }],
      [
        { id: 1, title: 'First' },
        { id: 2, title: 'Post 2' },
      ],
    ])
  })

  it('executes callable mutations through the client transport with inferred data', async () => {
    const createPost = defineRealtimeMutation({
      name: 'posts.create',
      args: schema({
        title: field.string().required(),
      }),
      access: 'public',
      handler: async ({ args }) => ({
        id: 1,
        title: args.title,
      }),
    })

    configureRealtimeClientTransport({
      async query<TResult>() {
        return {
          name: 'posts.list',
          data: [] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>(name: string, args: Record<string, unknown>) {
        return {
          name,
          data: {
            id: 1,
            title: args.title,
          } as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        return () => {}
      },
    })

    await expect(createPost({ title: 'First' })).resolves.toEqual({
      id: 1,
      title: 'First',
    })
  })

  it('ignores unrelated dependency invalidations and reports refresh errors', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const snapshots: unknown[][] = []
    const errors: unknown[] = []
    let shouldThrow = false
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        const rows = await context.table('posts').get()
        if (shouldThrow) {
          throw new Error('refresh failed')
        }

        return rows
      },
    })
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
      onError: error => {
        errors.push(error)
      },
    })

    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:comments'],
    })
    shouldThrow = true
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })

    expect(snapshots).toEqual([[{ id: 1, title: 'First' }]])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  it('refreshes only for the current dependencies after a query changes what it reads', async () => {
    const adapter = new RelationalMemoryAdapter({
      posts: [{ id: 1, title: 'First' }],
      comments: [{ id: 1, body: 'Initial' }],
    })
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let readComments = false
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => readComments
        ? await context.table('comments').orderBy('id').get()
        : await context.table('posts').orderBy('id').get(),
    })

    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:comments'],
    })
    readComments = true
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })
    await realtimeRuntimeInternals.handleDatabaseInvalidation({
      connectionName: 'main',
      dependencies: ['db:main:comments'],
    })

    expect(snapshots).toEqual([
      [{ id: 1, title: 'First' }],
      [{ id: 1, body: 'Initial' }],
    ])
  })

  it('stops refreshing unsubscribed queries after matching writes', async () => {
    const adapter = new MemoryAdapter()
    const db = createContext(adapter)
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let queryRuns = 0
    const snapshots: unknown[][] = []
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        queryRuns += 1
        return await context.table('posts').get()
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').insert({ title: 'Next' })
        return true
      },
    })

    const subscription = await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => {
        snapshots.push(snapshot.data)
      },
    })
    subscription.unsubscribe()
    await executeRealtimeMutation(mutation)

    expect(queryRuns).toBe(1)
    expect(snapshots).toEqual([[{ id: 1, title: 'First' }]])
  })

  it('rejects authenticated access when auth is unavailable', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: 'authenticated',
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeAuthUnavailableError)
  })

  it('rejects authenticated access when auth runtime loading fails', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => {
        throw new Error('auth crashed')
      },
    })
    const query = defineRealtimeQuery({
      access: 'authenticated',
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeAuthUnavailableError)
  })

  it('rejects authenticated access when configured auth fails while resolving a guard', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => ({
        getAuthRuntime() {
          return {
            user: async () => {
              throw new Error('auth context missing')
            },
            provider: async () => null,
            guard() {
              return {
                user: async () => null,
                provider: async () => null,
              }
            },
          }
        },
      }),
    })
    const query = defineRealtimeQuery({
      access: 'authenticated',
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeAuthUnavailableError)
  })

  it('treats failing optional auth as anonymous for public access', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => {
        throw new Error('auth crashed')
      },
    })
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ auth }) => auth,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: null,
    })
  })

  it('resolves authenticated access across configured guards', async () => {
    const db = createContext()
    const user = {
      id: 10,
      email: 'ava@example.com',
      can: async () => true,
    } satisfies AuthenticatedAuthUser
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        admin: null,
        web: user,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        guards: ['admin', 'web'],
      },
      handler: async ({ auth }) => ({
        guard: auth.guard,
        userId: auth.user.id,
      }),
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: {
        guard: 'web',
        userId: 10,
      },
    })
  })

  it('resolves authenticated access from one named guard', async () => {
    const db = createContext()
    const user = {
      id: 11,
      can: async () => true,
    } satisfies AuthenticatedAuthUser
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        web: user,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        guard: 'web',
      },
      handler: async ({ auth }) => auth.guard,
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: 'web',
    })
  })

  it('runs custom authorization before the handler', async () => {
    const db = createContext()
    const user = {
      id: 10,
      can: async () => true,
    } satisfies AuthenticatedAuthUser
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        default: user,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        authorize: async ({ auth }) => auth?.user.id === 20,
      },
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeForbiddenError)
  })

  it('runs handlers when custom authorization allows access', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'public',
        authorize: async () => true,
      },
      handler: async () => 'allowed',
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: 'allowed',
    })
  })

  it('passes nullable auth into public custom authorization callbacks', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => null,
    })
    let receivedAuth: unknown = Symbol('unset')
    const query = defineRealtimeQuery({
      access: {
        require: 'public',
        authorize: async ({ auth }) => {
          receivedAuth = auth
          return true
        },
      },
      handler: async () => 'allowed',
    })

    await expect(executeRealtimeQuery(query)).resolves.toMatchObject({
      data: 'allowed',
    })
    expect(receivedAuth).toBeNull()
  })

  it('only treats missing realtime definition directories as empty', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-server-'))

    try {
      await expect(resolveRealtimeDefinition('posts.missing', {
        projectRoot,
      })).rejects.toThrow('Realtime definition "posts.missing" was not found.')

      const filePath = join(projectRoot, 'server-realtime-file')
      await writeFile(filePath, '')
      await expect(resolveRealtimeDefinition('posts.missing', {
        projectRoot,
        realtimeRoot: 'server-realtime-file',
      })).rejects.toThrow()
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects custom authenticated authorization when no guard returns a user', async () => {
    const db = createContext()
    configureRealtimeRuntime({
      db: () => db,
      loadAuthModule: async () => createAuthModule({
        default: null,
      }),
    })
    const query = defineRealtimeQuery({
      access: {
        require: 'authenticated',
        authorize: async () => true,
      },
      handler: async () => true,
    })

    await expect(executeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeUnauthorizedError)
  })
})
