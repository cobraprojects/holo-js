import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import type { TransactionFrame } from '../core/openTransactions'
import { createQueryCompiler } from './queryCompilerFactory'
import { evictReplacedTableIdentity, invalidateReplacedTableIdentity } from '../cache'
import { splitTablePath, tablePathSegments } from '../schema/identifiers'
import { listGeneratedTableSpellings } from '../schema/generated'
import { foldTableName, rememberCanonicalTableName, rememberTableNameFolding, type TableNameFolding } from '../schema/tableIdentityRegistry'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SelectQueryPlan, QueryPredicateNode } from './ast'

type TableIdentityRow = {
  readonly schema: string | null
  readonly name: string | null
  readonly bare_schema: string | null
}

type TableIdentityRefresh = {
  readonly identity: string
  readonly expired: readonly string[]
}

type TableIdentityEntry = {
  readonly generation: number
  readonly refresh: Promise<TableIdentityRefresh>
}

const resolvedIdentities = new WeakMap<object, Map<string, TableIdentityEntry>>()
const tableNameFoldings = new WeakMap<object, Promise<TableNameFolding>>()
const resolvedTableNameFoldings = new WeakMap<object, TableNameFolding>()

export function resolvedTableNameFolding(connection: DatabaseContext): TableNameFolding | undefined {
  return resolvedTableNameFoldings.get(getRootDatabaseContext(connection))
}

async function readTableNameFolding(connection: DatabaseContext): Promise<TableNameFolding> {
  const compiler = createQueryCompiler(connection)
  const statement = compiler.compileTableNameFoldingLookup()
  if (!statement) return compiler.tableNameFolding()
  const { rows } = await connection.queryCompiled(statement)
  return compiler.tableNameFolding(rows[0])
}

async function resolveTableNameFolding(connection: DatabaseContext): Promise<void> {
  const owner = getRootDatabaseContext(connection)
  const cached = tableNameFoldings.get(owner)
  const folding = cached ?? readTableNameFolding(connection)
  if (!cached) {
    tableNameFoldings.set(owner, folding)
    folding.catch(() => {
      if (tableNameFoldings.get(owner) === folding) tableNameFoldings.delete(owner)
    })
  }
  const resolved = await folding
  resolvedTableNameFoldings.set(owner, resolved)
  rememberTableNameFolding(connection.getConnectionName(), resolved)
}

function schemaChangingTransaction(connection: DatabaseContext): TransactionFrame | undefined {
  const frame = currentRootTransaction(connection)
  return frame?.schemaChanged ? frame : undefined
}

function ownerIdentities(owner: object): Map<string, TableIdentityEntry> {
  const existing = resolvedIdentities.get(owner)
  if (existing) return existing
  const created = new Map<string, TableIdentityEntry>()
  resolvedIdentities.set(owner, created)
  return created
}

function toCanonicalName(tableName: string, row: TableIdentityRow | undefined): string {
  if (!row?.schema || !row.name) return tableName
  const { table } = splitTablePath(tableName)
  return row.schema === row.bare_schema ? table : `${row.schema}.${table}`
}

async function lookupTableIdentity(connection: DatabaseContext, tableName: string): Promise<string> {
  if (splitTablePath(tableName).schema === undefined) return tableName
  const statement = createQueryCompiler(connection).compileTableIdentityLookup(tableName)
  if (!statement) return tableName
  const { rows } = await connection.queryCompiled<TableIdentityRow>(statement)
  return toCanonicalName(tableName, rows[0])
}

async function refreshTableIdentity(connection: DatabaseContext, tableName: string, replaced: readonly TableIdentityEntry[]): Promise<TableIdentityRefresh> {
  const fold = (name: string) => foldTableName(connection.getConnectionName(), name)
  const identity = fold(await lookupTableIdentity(connection, tableName))
  if (replaced.length === 0) return { identity, expired: [] }
  const replacedIdentities = await Promise.all(replaced.map(previous => previous.refresh.then(resolved => resolved.identity, () => identity)))
  for (const expiredIdentity of new Set([...replacedIdentities, identity])) {
    await evictReplacedTableIdentity(connection, expiredIdentity)
  }
  return { identity, expired: [...new Set(replacedIdentities.filter(replacedIdentity => replacedIdentity !== identity))] }
}

export async function resolveTableIdentity(connection: DatabaseContext, tableName: string): Promise<string> {
  if (tablePathSegments(tableName).length > 2) return tableName
  await resolveTableNameFolding(connection)
  const transaction = schemaChangingTransaction(connection)
  const rootIdentities = ownerIdentities(getRootDatabaseContext(connection))
  const identities = transaction ? ownerIdentities(transaction) : rootIdentities
  const cached = identities.get(tableName)
  const generation = currentSchemaGeneration()
  const replaced = [...new Set([cached, rootIdentities.get(tableName)])].filter((previous): previous is TableIdentityEntry => previous !== undefined)
  const entry = cached?.generation === generation
    ? cached
    : { generation, refresh: refreshTableIdentity(connection, tableName, replaced) }
  if (entry !== cached) {
    identities.set(tableName, entry)
    entry.refresh.catch(() => {
      if (identities.get(tableName) !== entry) return
      if (cached) identities.set(tableName, cached)
      else identities.delete(tableName)
    })
  }
  const { identity, expired } = await entry.refresh
  rememberCanonicalTableName(connection.getConnectionName(), tableName, identity, transaction)
  if (entry !== cached) {
    for (const expiredIdentity of expired) {
      await invalidateReplacedTableIdentity(connection, expiredIdentity)
    }
  }
  return identity
}

export async function resolveGeneratedTableIdentity(connection: DatabaseContext, tableName: string): Promise<void> {
  const spellings = listGeneratedTableSpellings(tableName)
  if (spellings.length === 0 || spellings.includes(tableName)) return
  await resolveTableIdentity(connection, tableName)
  for (const spelling of spellings) {
    await resolveTableIdentity(connection, spelling)
  }
}

function collectPredicateTables(predicate: QueryPredicateNode, tables: Set<string>, seen: Set<SelectQueryPlan>): void {
  if (predicate.kind === 'group') {
    for (const child of predicate.predicates) collectPredicateTables(child, tables, seen)
    return
  }
  if (predicate.kind === 'exists' || predicate.kind === 'subquery') collectPlanTables(predicate.subquery, tables, seen)
}

function collectPlanTables(plan: SelectQueryPlan, tables: Set<string>, seen: Set<SelectQueryPlan>): void {
  if (seen.has(plan)) return
  seen.add(plan)
  tables.add(plan.source.tableName)
  for (const join of plan.joins) {
    if (join.table) tables.add(join.table)
    if (join.subquery) collectPlanTables(join.subquery, tables, seen)
  }
  for (const union of plan.unions) collectPlanTables(union.query, tables, seen)
  for (const selection of plan.selections) {
    if (selection.kind === 'subquery') collectPlanTables(selection.query, tables, seen)
  }
  for (const predicate of plan.predicates) collectPredicateTables(predicate, tables, seen)
}

function planTables(plan: SelectQueryPlan): Set<string> {
  const tables = new Set<string>()
  collectPlanTables(plan, tables, new Set())
  return tables
}

export async function resolvePlanTableIdentities(connection: DatabaseContext, plan: SelectQueryPlan): Promise<void> {
  for (const tableName of planTables(plan)) {
    await resolveTableIdentity(connection, tableName)
  }
}

export async function resolvePlanGeneratedTableIdentities(connection: DatabaseContext, plan: SelectQueryPlan): Promise<void> {
  for (const tableName of planTables(plan)) {
    await resolveGeneratedTableIdentity(connection, tableName)
  }
}
