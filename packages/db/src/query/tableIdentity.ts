import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import type { TransactionFrame } from '../core/openTransactions'
import { createQueryCompiler } from './queryCompilerFactory'
import { invalidateReplacedTableIdentity } from '../cache'
import { splitTablePath } from '../schema/identifiers'
import { listGeneratedTableSpellings } from '../schema/generated'
import { rememberCanonicalTableName } from '../schema/tableIdentityRegistry'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SelectQueryPlan, QueryPredicateNode } from './ast'

type TableIdentityRow = {
  readonly schema: string | null
  readonly name: string | null
  readonly bare_schema: string | null
}

type TableIdentityEntry = {
  readonly generation: number
  readonly identity: Promise<string>
}

const resolvedIdentities = new WeakMap<object, Map<string, TableIdentityEntry>>()

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
  const statement = createQueryCompiler(connection).compileTableIdentityLookup(tableName)
  if (!statement) return tableName
  const { rows } = await connection.queryCompiled<TableIdentityRow>(statement)
  return toCanonicalName(tableName, rows[0])
}

export async function resolveTableIdentity(connection: DatabaseContext, tableName: string): Promise<string> {
  if (splitTablePath(tableName).schema === undefined) return tableName
  const transaction = schemaChangingTransaction(connection)
  const rootIdentities = ownerIdentities(getRootDatabaseContext(connection))
  const identities = transaction ? ownerIdentities(transaction) : rootIdentities
  const cached = identities.get(tableName)
  const previous = cached ?? rootIdentities.get(tableName)
  const entry = cached?.generation === currentSchemaGeneration()
    ? cached
    : { generation: currentSchemaGeneration(), identity: lookupTableIdentity(connection, tableName) }
  if (entry !== cached) {
    identities.set(tableName, entry)
    entry.identity.catch(() => {
      if (identities.get(tableName) === entry) identities.delete(tableName)
    })
  }
  const identity = await entry.identity
  rememberCanonicalTableName(connection.getConnectionName(), tableName, identity, transaction)
  if (previous && entry !== previous) {
    const replaced = await previous.identity.catch(() => identity)
    if (replaced !== identity) await invalidateReplacedTableIdentity(connection, replaced)
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
